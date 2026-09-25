"""Metered, non-streaming transport for the frozen agent harness comparison.

--preflight checks account inventory and public prices without inference. --call
accepts one RespondInput on stdin and reserves before its only paid request.
External SDKs translate their history into this same transport; no SDK gets keys.
"""
import argparse
import asyncio
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import importlib
import json
from pathlib import Path
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from dotenv import dotenv_values
import httpx
from moolai_backend.providers import NebiusProvider, ServiceError
from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

EvidenceGateway = importlib.import_module('validate-j1').EvidenceGateway
EXPERIMENT = 'agent_harness_v1'
MODELS = {'super': 'nvidia/nemotron-3-super-120b-a12b',
          'ultra': 'nvidia/Nemotron-3-Ultra-550b-a55b'}
CAPS = {'super': (248, Decimal('.01')), 'ultra': (248, Decimal('.03'))}
RUN_CAP = Decimal('10')
CUMULATIVE_CAP = Decimal('25.87')
WIRE_BYTES = 12000
INPUT_TOKEN_BOUND = 15000
OUTPUT_TOKENS = 4000
PRICE_SOURCE = 'https://tokenfactory.nebius.com/api/public/models_info'
REQUIRED_FROZEN = {'scripts/harness-provider.py', 'backend/moolai_backend/providers.py',
                   'backend/moolai_backend/schemas.py', 'scripts/validate-j1.py',
                   'backend/moolai_backend/validate_live.py'}


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def settings():
    env = dotenv_values(ROOT / 'backend/.env')
    return Settings(nebius_api_key=env.get('NEBIUS_API_KEY') or '',
                    nebius_base_url=env.get('NEBIUS_BASE_URL') or Settings.nebius_base_url)


def validate_request(request):
    if not isinstance(request, dict) or set(request) != {
            'callId', 'phase', 'caseId', 'profile', 'modelProfile', 'repeat', 'step', 'input'}:
        raise ValueError('Unexpected bridge request fields')
    phase, case, profile = request['phase'], request['caseId'], request['profile']
    model_profile, repeat, step = request['modelProfile'], request['repeat'], request['step']
    if profile not in ('H0', 'H1', 'H2', 'H3') or model_profile not in MODELS:
        raise ValueError('Unknown harness or model profile')
    if type(repeat) is not int or type(step) is not int:
        raise ValueError('Repeat and step must be integers')
    if phase == 'compatibility':
        if case != 'compatibility' or repeat != 0 or step not in (1, 2):
            raise ValueError('Unknown compatibility case/repeat/step')
    elif phase == 'agent':
        if case not in {f'h{i:02}' for i in range(1, 9)} or step not in range(1, 7):
            raise ValueError('Unknown agent case/step')
        if repeat not in (0, 1) or (repeat == 1 and case not in ('h01', 'h03')):
            raise ValueError('Undeclared agent repeat')
    else:
        raise ValueError('Unknown phase')
    expected = f'{EXPERIMENT}:{phase}:{case}:{profile}:{model_profile}:{repeat}:{step}'
    if request['callId'] != expected:
        raise ValueError('Unstable operation ID')
    RespondInput.model_validate(request['input'])
    return MODELS[model_profile]


def reserve(ledger, request):
    model = validate_request(request)
    previous = [e for e in ledger.entries if e.get('validation') == EXPERIMENT]
    maximum, amount = CAPS[request['modelProfile']]
    if any(e.get('callId') == request['callId'] for e in ledger.entries):
        raise ValueError('Call already reserved; no automatic retry')
    if sum(e.get('modelProfile') == request['modelProfile'] for e in previous) >= maximum:
        raise ValueError('Per-model call cap exhausted')
    if sum((Decimal(e['reservedUsd']) for e in previous), Decimal(0)) + amount > RUN_CAP:
        raise ValueError('US$10 experiment cap exhausted')
    group = [e for e in previous if all(e.get(k) == request[k] for k in
             ('phase', 'caseId', 'profile', 'modelProfile', 'repeat'))]
    limit = 2 if request['phase'] == 'compatibility' else 6
    if len(group) >= limit:
        raise ValueError('Frozen case/profile/model call cap exhausted')
    # The reusable Ledger may have a different caller limit in tests or tools;
    # this bridge always enforces the approved cumulative cap independently.
    if ledger.reserved + amount > CUMULATIVE_CAP:
        raise ValueError('Cumulative US$25.87 reservation cap exhausted')
    ledger.ensure_budget(1, amount)
    entry = {k: request[k] for k in ('callId', 'phase', 'caseId', 'profile', 'modelProfile', 'repeat', 'step')}
    entry.update(validation=EXPERIMENT, provider='Nebius', model=model, apiMethod='respond',
                 reservedUsd=str(amount), actualCostUsd=None, status='reserved_before_dispatch',
                 at=datetime.now(timezone.utc).isoformat())
    ledger.entries.append(entry)
    ledger.save()
    return entry


def verify_freeze(path):
    frozen = json.loads(Path(path).read_text())
    hashes = frozen.get('sourceHashes', {})
    if frozen.get('experiment') != EXPERIMENT or not REQUIRED_FROZEN.issubset(hashes):
        raise ValueError('Incomplete or wrong experiment freeze')
    for relative, expected in hashes.items():
        target = (ROOT / relative).resolve()
        if not target.is_relative_to(ROOT.resolve()) or digest(target) != expected:
            raise ValueError('Frozen source changed: ' + relative)
    return frozen


async def preflight(config, client):
    inventory = await NebiusProvider(EvidenceGateway(config, client)).models(refresh=True)
    response = await client.get(PRICE_SOURCE, timeout=30)
    response.raise_for_status()
    rows = {f['model_id']: f for m in response.json() for f in m.get('flavors', [])}
    checked = []
    for profile, model in MODELS.items():
        if model not in inventory or model not in rows:
            raise ValueError('Exact model unavailable: ' + model)
        row = rows[model]
        price_in, price_out = (Decimal(str(row[name])) for name in
                               ('input_price_per_million_tokens', 'output_price_per_million_tokens'))
        if any(not price.is_finite() or price < 0 for price in (price_in, price_out)):
            raise ValueError('Invalid published model price')
        bound = (price_in * INPUT_TOKEN_BOUND + price_out * OUTPUT_TOKENS) / 1000000
        if bound > CAPS[profile][1]:
            raise ValueError('Current price exceeds reservation: ' + model)
        checked.append({'modelProfile': profile, 'model': model, 'available': True,
                        'inputUsdPerMillion': str(price_in), 'outputUsdPerMillion': str(price_out),
                        'inputTokenBound': INPUT_TOKEN_BOUND, 'outputTokenBound': OUTPUT_TOKENS,
                        'textBoundUsd': str(bound), 'reservationUsd': str(CAPS[profile][1])})
    return {'at': datetime.now(timezone.utc).isoformat(), 'models': checked,
            'priceSource': PRICE_SOURCE, 'inferenceCalls': 0, 'maximumNewReservationUsd': '9.92',
            'runCapUsd': str(RUN_CAP), 'cumulativeCapUsd': str(CUMULATIVE_CAP),
            'maxCallsPerModel': 248, 'maxWireBytes': WIRE_BYTES}


def verify_preflight(frozen):
    info = frozen['preflight']
    checked = datetime.fromisoformat(info['at'])
    age = (datetime.now(timezone.utc) - checked).total_seconds()
    if not 0 <= age <= 7200:
        raise ValueError('Preflight is stale or future-dated; stop rather than dispatch')
    for profile, model in MODELS.items():
        row = next((r for r in info['models'] if r.get('modelProfile') == profile), None)
        if not row or row.get('model') != model or row.get('available') is not True:
            raise ValueError('Missing exact account model preflight')
        price_in = Decimal(row['inputUsdPerMillion'])
        price_out = Decimal(row['outputUsdPerMillion'])
        if any(not price.is_finite() or price < 0 for price in (price_in, price_out)):
            raise ValueError('Invalid frozen price')
        if (price_in * INPUT_TOKEN_BOUND + price_out * OUTPUT_TOKENS) / 1000000 > CAPS[profile][1]:
            raise ValueError('Frozen prices exceed reservation')


class HarnessGateway(EvidenceGateway):
    def __init__(self, config, client, ledger, request):
        super().__init__(config, client)
        self.ledger, self.request_info = ledger, request
        self.entry = None
        self.wire_input = None
        self.raw_response = None

    async def request(self, provider, url, key, payload=None, method='POST'):
        if method == 'POST':
            if self.entry is not None:
                raise ValueError('A logical call cannot dispatch twice')
            model = validate_request(self.request_info)
            expected = {'model': model, 'max_completion_tokens': OUTPUT_TOKENS,
                        'temperature': .2, 'stream': False, 'store': False}
            if not isinstance(payload, dict) or any(payload.get(k) != v for k, v in expected.items()):
                raise ValueError('Unexpected experiment model settings')
            if set(payload) - {*expected, 'messages', 'tools', 'tool_choice'}:
                raise ValueError('Unexpected wire fields, including reasoning or retry settings')
            answer_only = self.request_info['input'].get('responseMode', 'auto') == 'answer_only'
            if payload.get('tool_choice') != ('none' if answer_only else 'auto'):
                raise ValueError('Incorrect response mode on provider wire')
            if answer_only and payload.get('tools'):
                raise ValueError('Answer-only wire must not expose tools')
            if len(json.dumps(payload, ensure_ascii=False).encode('utf-8')) > WIRE_BYTES:
                raise ValueError('Full text request exceeds the 12,000-byte bound')
            self.wire_input = deepcopy(payload)
            self.entry = reserve(self.ledger, self.request_info)
        result = await super().request(provider, url, key, payload, method)
        if method == 'POST':
            self.raw_response = deepcopy(result)
        return result


class HarnessProvider(NebiusProvider):
    async def completion(self, model, messages, max_completion_tokens, **parameters):
        return await super().completion(model, messages, OUTPUT_TOKENS, **parameters)


async def dispatch(config, client, request, frozen):
    model = validate_request(request)
    verify_preflight(frozen)
    report = {k: request[k] for k in ('callId', 'phase', 'caseId', 'profile', 'modelProfile', 'repeat', 'step')}
    report.update(model=model, status='not_dispatched', input=deepcopy(request['input']))
    config = replace(config, agent_model=model)
    with Ledger(ROOT / '.data/provider-validation.json', limit=CUMULATIVE_CAP) as ledger:
        before = ledger.reserved
        gateway = HarnessGateway(config, client, ledger, request)
        started = time.perf_counter()
        try:
            result = await HarnessProvider(gateway).respond(RespondInput.model_validate(request['input']))
            report.update(status='succeeded', output=result.model_dump(exclude_none=True))
        except Exception as error:
            message = str(error) if isinstance(error, (ServiceError, ValueError)) else type(error).__name__
            report.update(status='failed_or_unknown_charge' if gateway.entry else 'not_dispatched', error=message)
        finally:
            usage = (gateway.evidence or {}).get('usage', {})
            report.update(elapsedMs=round((time.perf_counter() - started) * 1000), evidence=gateway.evidence,
                          wireInput=gateway.wire_input, rawResponse=gateway.raw_response, usage=usage)
            if gateway.entry:
                gateway.entry.update(status=report['status'], usage=usage, elapsedMs=report['elapsedMs'])
                ledger.save()
            report.update(reservedUsd=str(ledger.reserved - before), cumulativeReservationUsd=str(ledger.reserved),
                          cumulativeCalls=len(ledger.entries))
    return report


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    actions = parser.add_mutually_exclusive_group()
    actions.add_argument('--preflight', action='store_true')
    actions.add_argument('--call', action='store_true')
    parser.add_argument('--freeze', type=Path)
    args = parser.parse_args()
    if not args.preflight and not args.call:
        print(json.dumps({'experiment': EXPERIMENT, 'paidCalls': 0,
                          'maxCalls': {k: v[0] for k, v in CAPS.items()},
                          'maximumReservationUsd': '9.92', 'runCapUsd': str(RUN_CAP),
                          'cumulativeCapUsd': str(CUMULATIVE_CAP)}))
        return
    config = settings()
    async with httpx.AsyncClient(trust_env=False, timeout=95) as client:
        if args.preflight:
            result = await preflight(config, client)
        else:
            if not args.freeze:
                raise ValueError('Frozen sources and current price evidence are required')
            frozen = verify_freeze(args.freeze)
            raw = sys.stdin.read(100001)
            if len(raw.encode('utf-8')) > 100000:
                raise ValueError('Request exceeds bridge input limit')
            result = await dispatch(config, client, json.loads(raw), frozen)
        print(json.dumps(result, ensure_ascii=False))


if __name__ == '__main__':
    asyncio.run(main())
