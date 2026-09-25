"""Bounded J1 baseline using production adapter and synthetic, predeclared cases.

Prepare controller inputs with scripts/replay-j1.ts first. Default is a dry run;
--live sends only those synthetic inputs to TypeSafe. Never retries or changes
production prompts. The shared US$5 ledger is locked for the whole run.
"""
import argparse
import asyncio
from datetime import datetime, timezone
from decimal import Decimal
import hashlib
import json
from pathlib import Path
import sys
import time
from uuid import uuid4

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))

from dotenv import dotenv_values
import httpx

from moolai_backend.providers import Gateway, JevProvider, ServiceError
from moolai_backend.schemas import RouteInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger, safe_usage

CASES = ROOT / 'experiments/fixtures/j1-cases.json'
PREPARED = ROOT / '.data/validation/j1-prepared-inputs.json'
OUTPUT = ROOT / '.data/validation/j1-routing-simulated.json'
RESERVATION = Decimal('0.01')


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


class EvidenceGateway(Gateway):
    """Capture bounded metadata from the same request the real adapter makes."""
    evidence = None

    async def request(self, provider, url, key, payload=None, method='POST'):
        self.evidence = None
        result = await super().request(provider, url, key, payload, method)
        self.evidence = {
            'servedModel': result.get('model'),
            'usage': safe_usage(result),
            'answers': result.get('answers'),
            'requestSha256': hashlib.sha256(
                json.dumps(payload, sort_keys=True).encode()).hexdigest(),
        }
        return result


def summarize(results):
    groups = {}
    for result in results:
        group = groups.setdefault(result['category'], {
            'total': 0, 'responses': 0, 'routeMatches': 0,
            'strictCases': 0, 'strictRouteMatches': 0,
            'belowThreshold': 0, 'controllerWouldRoute': 0,
        })
        group['total'] += 1
        group['responses'] += int('output' in result)
        group['routeMatches'] += int(result.get('routeMatches', False))
        group['controllerWouldRoute'] += int(result['controllerWouldRoute'])
        if result['scoring'] == 'strict':
            group['strictCases'] += 1
            group['strictRouteMatches'] += int(result.get('routeMatches', False))
        if 'output' in result:
            group['belowThreshold'] += int(result['output']['confidence'] < 0.8)
    return groups


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    manifest = json.loads(CASES.read_text())['cases']
    prepared = json.loads(PREPARED.read_text())['cases']
    assert len(manifest) == len(prepared) <= 40, 'Unexpected case count'
    assert len({case['id'] for case in manifest}) == len(manifest)
    by_id = {case['id']: case for case in prepared}
    for case in manifest:
        item = by_id[case['id']]
        assert item['text'] == case['text'], 'Prepared text differs'
        assert item['input']['text'] == case['text'], 'Input text differs'
        assert item['input']['activeConversation'] == case['activeConversation']
        RouteInput.model_validate(item['input'])

    with Ledger(ROOT / '.data/provider-validation.json') as ledger:
        ledger.ensure_budget(len(manifest), RESERVATION)
        projection = {
            'cases': len(manifest), 'strictCases': sum(c['scoring'] == 'strict' for c in manifest),
            'reservedBeforeUsd': float(ledger.reserved),
            'additionalReservationUsd': float(RESERVATION * len(manifest)),
            'projectedReservedUsd': float(ledger.reserved + RESERVATION * len(manifest)),
            'live': args.live, 'retries': 0,
        }
        print(json.dumps(projection), flush=True)
        if not args.live:
            return
        if OUTPUT.exists():
            raise ValueError('Baseline output already exists; refusing overwrite or accidental rerun')
        env = dotenv_values(ROOT / 'backend/.env')
        settings = Settings(
            typesafe_api_key=env.get('TYPESAFE_API_KEY') or '',
            jev_model=env.get('JEV_MODEL') or Settings.jev_model,
        )
        if not settings.typesafe_api_key:
            raise ValueError('TypeSafe key is missing in backend/.env')
        if settings.jev_model != 'jev-1.13.0':
            raise ValueError('Configured Jev model changed; review before running baseline')
        report = {
            'startedAt': datetime.now(timezone.utc).isoformat(),
            'scope': '32 synthetic texts through the unchanged production JevProvider.route adapter. '
                     'No microphone, private transcript, search or generation requests. '
                     'Controller-filtered cases are submitted directly to Jev for diagnosis; '
                     'separate offline replay measures actual controller behavior.',
            'model': settings.jev_model, 'threshold': 0.8, 'retries': 0,
            'sourceHashes': {
                str(path.relative_to(ROOT)): digest(path) for path in [
                    CASES, PREPARED, ROOT / 'backend/moolai_backend/providers.py',
                    ROOT / 'packages/agent/src/index.ts', Path(__file__).resolve(),
                ]
            },
            'budgetBeforeUsd': float(ledger.reserved), 'additionalReservationUsd': 0,
            'complete': False, 'results': [],
        }

        def save():
            report['byCategory'] = summarize(report['results'])
            report['paidCallsCumulative'] = len(ledger.entries)
            report['reservedUsdCumulative'] = float(ledger.reserved)
            report['additionalReservationUsd'] = round(float(ledger.reserved) - report['budgetBeforeUsd'], 2)
            OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            temporary = OUTPUT.with_suffix('.tmp')
            temporary.write_text(json.dumps(report, indent=2) + '\n')
            temporary.replace(OUTPUT)

        async with httpx.AsyncClient(trust_env=False) as client:
            gateway = EvidenceGateway(settings, client)
            provider = JevProvider(gateway)
            for case in manifest:
                item = by_id[case['id']]
                entry = ledger.reserve('TypeSafe', RESERVATION)
                entry.update(callId=f'j1-simulated-{uuid4()}', apiMethod='route',
                             validation='j1_simulated_baseline', fixtureId=case['id'], model=settings.jev_model)
                ledger.save()
                result = {**case, 'input': item['input'],
                          'controllerWouldRoute': item['controllerWouldRoute']}
                start = time.perf_counter()
                try:
                    output = await asyncio.wait_for(
                        provider.route(RouteInput.model_validate(item['input'])), timeout=35)
                    result['output'] = output.model_dump(exclude_none=True)
                    result['routeMatches'] = output.route in case['expectedRoutes']
                    result['meetsNormalThreshold'] = output.confidence >= 0.8
                    result['evidence'] = gateway.evidence
                    entry.update(status='succeeded', servedModel=settings.jev_model,
                                 usage=(gateway.evidence or {}).get('usage', {}))
                except Exception as error:
                    # Adapter errors are sanitized; unknown errors expose only type.
                    result['error'] = str(error) if isinstance(error, ServiceError) else type(error).__name__
                    result['routeMatches'] = False
                    entry['status'] = 'failed_or_unknown_charge'
                finally:
                    result['durationMs'] = round((time.perf_counter() - start) * 1000)
                    entry['durationMs'] = result['durationMs']
                    ledger.save()
                    report['results'].append(result)
                    save()
                    print(json.dumps({'id': case['id'], 'output': result.get('output'),
                                      'error': result.get('error'), 'routeMatches': result['routeMatches'],
                                      'controllerWouldRoute': result['controllerWouldRoute']}), flush=True)
        report['complete'] = True
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        save()
        print(json.dumps({'byCategory': report['byCategory'],
                          'reservedUsdCumulative': report['reservedUsdCumulative']}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
