"""Explicit, tiny provider smoke checks with a shared conservative reservation ledger.

Default is inventory only. Reservations are operator-verified price upper bounds,
not observed invoices; uncertain requests retain their entire reservation.
"""
import argparse
import asyncio
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
import fcntl
import json
import os
from pathlib import Path

from dotenv import load_dotenv
import httpx

from .providers import Gateway, NebiusProvider, ServiceError, TavilyProvider, probability
from .settings import Settings

LIMIT = Decimal('5.00')


class Ledger:
    def __init__(self, path: Path, limit: Decimal = LIMIT):
        self.path = path
        self.entries = []
        if not limit.is_finite() or limit <= 0:
            raise ValueError('Budget limit must be positive')
        self.limit = limit

    def __enter__(self):
        self.path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = self.path.with_suffix('.lock').open('a')
        fcntl.flock(self.lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if self.path.exists():
            data = json.loads(self.path.read_text())
            if data.get('version') != 1 or not isinstance(data.get('calls'), list):
                raise ValueError('Invalid validation ledger; refusing to reset the budget')
            self.entries = data['calls']
        return self

    def __exit__(self, *_args):
        fcntl.flock(self.lock, fcntl.LOCK_UN)
        self.lock.close()

    @property
    def reserved(self):
        values = [Decimal(entry['reservedUsd']) for entry in self.entries]
        if any(not value.is_finite() or value <= 0 for value in values):
            raise ValueError('Invalid budget entries; refusing paid calls')
        return sum(values, Decimal('0'))

    def ensure_budget(self, count: int, reservation: Decimal):
        if not reservation.is_finite() or reservation <= 0:
            raise ValueError('Per-call reservation must be a positive dollar amount')
        if count < 0 or self.reserved + count * reservation > self.limit:
            raise ValueError(f'This run would exceed the cumulative US${self.limit:g} reservation budget')

    def save(self):
        temporary = self.path.with_suffix('.tmp')
        fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, 'w') as handle:
            json.dump({'version': 1, 'calls': self.entries}, handle, indent=2)
            handle.write('\n')
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, self.path)

    def reserve(self, provider: str, amount: Decimal) -> dict:
        self.ensure_budget(1, amount)
        entry = {'provider': provider, 'at': datetime.now(timezone.utc).isoformat(),
                 'reservedUsd': str(amount), 'status': 'reserved_before_dispatch', 'actualCostUsd': None}
        self.entries.append(entry)
        self.save()  # Crash/timeout after dispatch cannot accidentally refund an unknown charge.
        return entry


def safe_usage(data: dict) -> dict:
    usage = data.get('usage', {})
    if not isinstance(usage, dict):
        return {}
    return {name: value for name, value in usage.items()
            if name in ('input_tokens', 'output_tokens', 'prompt_tokens', 'completion_tokens', 'total_tokens', 'credits')
            and type(value) in (int, float) and value >= 0}


async def tiny_call(provider: str, gateway: Gateway, model: str) -> dict:
    settings = gateway.settings
    if provider == 'jev':
        data = await gateway.request('TypeSafe', 'https://api.typesafe.ai/v1/systemone', settings.typesafe_api_key, {
            'model': settings.jev_model, 'state': 'The sky is blue.',
            'questions': {'check': {'type': 'noul', 'instructions': 'Does the text mention the sky?'}},
        })
        if data.get('model') != settings.jev_model:
            raise ServiceError('TypeSafe model did not match the configured version')
        answer = data.get('answers', {}).get('check', {})
        if answer.get('type') != 'noul':
            raise ServiceError('TypeSafe smoke response was invalid')
        probability(answer.get('noul'))
        return {'model': settings.jev_model, 'usage': safe_usage(data)}
    if provider == 'nebius':
        data = await gateway.request('Nebius', settings.nebius_base_url + '/chat/completions', settings.nebius_api_key, {
            'model': model, 'messages': [{'role': 'user', 'content': 'Reply with the single word ready.'}],
            'max_completion_tokens': 32, 'store': False, 'temperature': 0, 'stream': False,
        })
        if data.get('model') != model:
            raise ServiceError('Nebius model did not match the configured version')
        try:
            choice = data['choices'][0]
            if choice.get('finish_reason') != 'stop' or not isinstance(choice['message']['content'], str) or not choice['message']['content'].strip():
                raise ValueError('incomplete completion')
        except (KeyError, IndexError, TypeError, ValueError) as error:
            raise ServiceError('Nebius tiny response was invalid or exhausted its 32-token cap') from error
        return {'model': model, 'usage': safe_usage(data)}
    data = await gateway.request('Tavily', 'https://api.tavily.com/search', settings.tavily_api_key, {
        'query': 'NVIDIA Nemotron official documentation', 'search_depth': 'basic', 'max_results': 1,
        'include_answer': False, 'include_raw_content': False, 'include_images': False, 'auto_parameters': False,
    })
    TavilyProvider.results(data, 'content', 1)
    return {'usage': safe_usage(data)}


async def validate(settings: Settings, selected: list[str], paid: bool, reservation: Decimal | None,
                   ledger_path: Path, nebius_role='summary', client=None) -> dict:
    owned_client = client is None
    client = client or httpx.AsyncClient(trust_env=False)
    report = {'mode': 'paid_smoke' if paid else 'inventory_only', 'providers': {}, 'paidCalls': 0}
    try:
        gateway = Gateway(settings, client)
        models = {'summary': settings.summary_model, 'agent': settings.agent_model,
                  'vision': settings.vision_model, 'ocr': settings.ocr_model}
        keys = {'jev': settings.typesafe_api_key, 'nebius': settings.nebius_api_key, 'tavily': settings.tavily_api_key}
        eligible = True
        for provider in selected:
            status = {'configured': bool(keys[provider]), 'accessVerified': False}
            report['providers'][provider] = status
            if not keys[provider]:
                status['error'] = 'Not configured'
                eligible = False
            elif provider == 'nebius':
                try:
                    inventory = await NebiusProvider(gateway).models(refresh=True)
                    status.update({'inventoryVerified': True, 'requested': models,
                                   'availableConfiguredModels': [name for name in models.values() if name in inventory]})
                    if models[nebius_role] not in inventory:
                        status['error'] = 'Selected exact model is unavailable; no fallback'
                        eligible = False
                except ServiceError as error:
                    status['error'] = str(error)
                    eligible = False
        if not paid or not eligible:
            return report
        if reservation is None:
            raise ValueError('A verified per-call dollar upper bound is required for paid checks')
        with Ledger(ledger_path) as ledger:
            ledger.ensure_budget(len(selected), reservation)
            for provider in selected:
                entry = ledger.reserve(provider, reservation)
                report['paidCalls'] += 1
                try:
                    result = await tiny_call(provider, gateway, models[nebius_role])
                    entry.update(result, status='succeeded')
                    report['providers'][provider].update(result, accessVerified=True)
                except ServiceError as error:
                    entry.update(status='failed_or_unknown_charge', error=str(error))
                    report['providers'][provider]['error'] = str(error)
                finally:
                    ledger.save()
            report['reservedUsdTotal'] = str(ledger.reserved)
        return report
    finally:
        if owned_client:
            await client.aclose()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--providers', default='jev,nebius,tavily', help='Comma-separated subset of jev,nebius,tavily')
    parser.add_argument('--env', default='.env')
    parser.add_argument('--allow-paid', action='store_true')
    parser.add_argument('--pricing-checked', action='store_true', help='Confirm current account pricing supports the per-call upper bound')
    parser.add_argument('--max-call-usd', help='Conservative verified upper bound for EACH selected tiny call, retained on failures')
    parser.add_argument('--nebius-role', choices=['summary', 'agent', 'vision', 'ocr'], default='summary')
    args = parser.parse_args()
    selected = list(dict.fromkeys(part.strip() for part in args.providers.split(',')))
    if not selected or any(provider not in ('jev', 'nebius', 'tavily') for provider in selected):
        parser.error('Choose a nonempty subset of jev,nebius,tavily')
    if args.allow_paid and (not args.pricing_checked or not args.max_call_usd):
        parser.error('Paid checks require --pricing-checked and --max-call-usd after verifying current prices')
    try:
        reservation = Decimal(args.max_call_usd) if args.max_call_usd else None
    except InvalidOperation:
        parser.error('--max-call-usd must be a dollar amount')
    load_dotenv(args.env, override=False)
    # One fixed ledger for this checkout. Do not let a CLI flag accidentally reset the shared budget.
    ledger_path = Path(__file__).resolve().parents[2] / '.data' / 'provider-validation.json'
    try:
        report = asyncio.run(validate(Settings.from_env(), selected, args.allow_paid, reservation, ledger_path, args.nebius_role))
        print(json.dumps(report, indent=2))
    except (ValueError, OSError) as error:
        parser.exit(1, f'Validation stopped: {error}\n')
    if any('error' in result for result in report['providers'].values()):
        raise SystemExit(1)


if __name__ == '__main__':
    main()
