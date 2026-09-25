"""Test a separate keyword-free J1 policy without changing production behavior.

Four user examples use the current adapter; 28 predeclared phrases use a single
experimental Choice. Default is dry-run. --live reserves each request against
the existing US$5 ledger. No retries, microphones, tools or generation calls.
"""
import argparse
import asyncio
from datetime import datetime, timezone
from decimal import Decimal
from importlib import import_module
import json
from pathlib import Path
import sys
import time
from uuid import uuid4

from dotenv import dotenv_values
import httpx

# Reuse the baseline runner's evidence capture; importing it makes no requests.
baseline = import_module('validate-j1')
EvidenceGateway, digest = baseline.EvidenceGateway, baseline.digest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from moolai_backend.providers import JevProvider, ServiceError
from moolai_backend.schemas import RouteInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

CASES = ROOT / 'experiments/fixtures/j1-natural-language-cases.json'
POLICY = ROOT / 'experiments/fixtures/j1-natural-language-policy.json'
OUTPUT = ROOT / '.data/validation/j1-natural-language-results.json'
RESERVATION = Decimal('0.01')
THRESHOLD = 0.8


def question_for(policy, item):
    state_kind = ('help_offer' if item.get('pendingOffer') else
                  'active' if item['activeConversation'] else 'idle')
    return {'route': {
        'type': 'choice', 'instructions': policy['instructions'],
        'criteria': {name: policy['criteria'][name]
                     for name in policy['allowedByState'][state_kind]},
    }}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    args = parser.parse_args()
    cases = json.loads(CASES.read_text())['cases']
    policy = json.loads(POLICY.read_text())
    assert len(cases) == 28 and len({case['id'] for case in cases}) == 28
    for case in cases:
        RouteInput.model_validate(case['input'])
        assert case['expectedRoute'] in question_for(policy, case['input'])['route']['criteria']
    jobs = [('current', case) for case in cases if case['baselineComparison']]
    assert len(jobs) == 4
    jobs += [('candidate', case) for case in cases]
    with Ledger(ROOT / '.data/provider-validation.json') as ledger:
        ledger.ensure_budget(len(jobs), RESERVATION)
        print(json.dumps({'live': args.live, 'requests': len(jobs),
                          'beforeUsd': float(ledger.reserved),
                          'additionalReservationUsd': float(RESERVATION * len(jobs)),
                          'projectedUsd': float(ledger.reserved + RESERVATION * len(jobs))}), flush=True)
        if not args.live:
            return
        if OUTPUT.exists():
            raise ValueError('Result already exists; preserve it instead of overwriting or rerunning')
        env = dotenv_values(ROOT / 'backend/.env')
        settings = Settings(typesafe_api_key=env.get('TYPESAFE_API_KEY') or '',
                            jev_model=env.get('JEV_MODEL') or Settings.jev_model)
        if not settings.typesafe_api_key or settings.jev_model != 'jev-1.13.0':
            raise ValueError('Expected configured TypeSafe key and jev-1.13.0')
        report = {
            'startedAt': datetime.now(timezone.utc).isoformat(), 'complete': False,
            'model': settings.jev_model, 'threshold': THRESHOLD, 'retries': 0,
            'scope': 'Provider-only keyword-free policy experiment. Four examples use the unchanged '
                     'production route adapter; 28 shown phrases use test-only Choice criteria. '
                     'No production schema, prompt, controller, ASR or model change. No microphone, '
                     'answer/summary generation, help dialogue, tool execution or screen capture.',
            'sourceHashes': {str(p.relative_to(ROOT)): digest(p) for p in [
                CASES, POLICY, Path(__file__).resolve(), ROOT / 'scripts/validate-j1.py',
                ROOT / 'backend/moolai_backend/providers.py', ROOT / 'packages/agent/src/index.ts']},
            'budgetBeforeUsd': float(ledger.reserved), 'results': [],
        }

        def save():
            report['paidCallsCumulative'] = len(ledger.entries)
            report['reservedUsdCumulative'] = float(ledger.reserved)
            report['additionalReservationUsd'] = round(float(ledger.reserved) - report['budgetBeforeUsd'], 2)
            categories = {}
            for r in report['results']:
                if r['profile'] != 'candidate':
                    continue
                group = categories.setdefault(r['category'], {'cases': 0, 'responses': 0,
                    'routeMatches': 0, 'thresholdActionMatches': 0})
                group['cases'] += 1
                group['responses'] += int('output' in r)
                group['routeMatches'] += int(r.get('routeMatches', False))
                group['thresholdActionMatches'] += int(r.get('thresholdActionMatches', False))
            report['candidateByCategory'] = categories
            OUTPUT.parent.mkdir(parents=True, exist_ok=True)
            temporary = OUTPUT.with_suffix('.tmp')
            temporary.write_text(json.dumps(report, indent=2, ensure_ascii=False) + '\n')
            temporary.replace(OUTPUT)

        async with httpx.AsyncClient(trust_env=False) as client:
            gateway = EvidenceGateway(settings, client)
            provider = JevProvider(gateway)
            for profile, case in jobs:
                entry = ledger.reserve('TypeSafe', RESERVATION)
                entry.update(callId=f'j1-natural-{uuid4()}', validation='j1_natural_language_v1',
                             fixtureId=case['id'], profile=profile, model=settings.jev_model)
                ledger.save()
                result = {**case, 'profile': profile}
                started = time.perf_counter()
                try:
                    if profile == 'current':
                        output = await asyncio.wait_for(
                            provider.route(RouteInput.model_validate(case['input'])), 35)
                        result['output'] = output.model_dump(exclude_none=True)
                        result['supportsExpectedRoute'] = case['expectedRoute'] != 'offer_help'
                    else:
                        item = case['input']
                        state = {'activeConversation': item['activeConversation']}
                        if item.get('pendingOffer'):
                            state['pendingOffer'] = item['pendingOffer']
                        state['recentContext'] = item['recentContext']
                        state['latestUserUtterance'] = item['text']
                        result['questions'] = question_for(policy, item)
                        answers = await asyncio.wait_for(provider.evaluate(state, result['questions']), 35)
                        answer = answers['route']
                        result['output'] = {'route': answer['choice'], 'confidence': answer['confidence']}
                        result['supportsExpectedRoute'] = True
                    output = result['output']
                    result['routeMatches'] = output['route'] == case['expectedRoute']
                    result['meetsNormalThreshold'] = output['confidence'] >= THRESHOLD
                    result['hypotheticalThresholdAction'] = (
                        'clarify' if output['route'] == 'unclear' or output['confidence'] < THRESHOLD
                        else output['route'])
                    expected_action = 'clarify' if case['expectedRoute'] == 'unclear' else case['expectedRoute']
                    result['thresholdActionMatches'] = result['hypotheticalThresholdAction'] == expected_action
                    result['evidence'] = gateway.evidence
                    entry.update(status='succeeded', servedModel=settings.jev_model,
                                 usage=(gateway.evidence or {}).get('usage', {}))
                except Exception as error:
                    result['error'] = str(error) if isinstance(error, ServiceError) else type(error).__name__
                    entry['status'] = 'failed_or_unknown_charge'
                finally:
                    result['durationMs'] = round((time.perf_counter() - started) * 1000)
                    entry['durationMs'] = result['durationMs']
                    ledger.save()
                    report['results'].append(result)
                    save()
                    print(json.dumps({'profile': profile, 'id': case['id'], 'output': result.get('output'),
                                      'error': result.get('error'),
                                      'thresholdActionMatches': result.get('thresholdActionMatches')}), flush=True)
        report['complete'] = True
        report['finishedAt'] = datetime.now(timezone.utc).isoformat()
        save()
        print(json.dumps({'candidate': report['candidateByCategory'],
                          'reservedUsdCumulative': report['reservedUsdCumulative']}), flush=True)


if __name__ == '__main__':
    asyncio.run(main())
