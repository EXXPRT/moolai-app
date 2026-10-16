from datetime import datetime, timedelta, timezone
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sys

import httpx
import pytest

from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('harness_provider', ROOT / 'scripts/harness-provider.py')
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
# Historical harness fixtures use their frozen model, independent of the current
# production default selected by the user.
CONFIG = Settings(nebius_api_key='fixture-secret', agent_model=bridge.MODELS['super'])


def request(phase='agent', case='h01', profile='H0', model='super', repeat=0, step=1, mode='auto'):
    return {'phase': phase, 'caseId': case, 'profile': profile, 'modelProfile': model,
            'repeat': repeat, 'step': step,
            'callId': f'{bridge.EXPERIMENT}:{phase}:{case}:{profile}:{model}:{repeat}:{step}',
            'input': {'messages': [{'role': 'user', 'content': 'Use only my notes.'}],
                      'tools': [], 'responseMode': mode}}


def preflight():
    return {'preflight': {'at': datetime.now(timezone.utc).isoformat(), 'models': [
        {'modelProfile': key, 'model': model, 'available': True,
         'inputUsdPerMillion': '.3', 'outputUsdPerMillion': '.9'}
        for key, model in bridge.MODELS.items()]}}


def completion(model, text='Supported answer.'):
    return {'model': model, 'usage': {'prompt_tokens': 10, 'completion_tokens': 7, 'total_tokens': 17},
            'choices': [{'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': text}}]}


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
@pytest.mark.parametrize('text', ['', None])
async def test_historical_final_text_still_rejects_empty_output_without_retry(mode, text):
    requests = []
    def respond(req):
        requests.append(req.method)
        if req.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': CONFIG.agent_model}]})
        return httpx.Response(200, json=completion(CONFIG.agent_model, text))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(bridge.ServiceError):
            await bridge.HarnessProvider(bridge.EvidenceGateway(CONFIG, client)).respond(RespondInput(
                messages=[{'role': 'user', 'content': 'Explain the evidence.'}], tools=[], responseMode=mode))
    assert requests == ['GET', 'POST']


def test_full_frozen_matrix_reserves_496_calls_without_changing_history(tmp_path):
    path = tmp_path / 'ledger.json'
    history = {'callId': 'previous', 'validation': 'old', 'reservedUsd': '15.87', 'status': 'failed_or_unknown_charge'}
    path.write_text(json.dumps({'version': 1, 'calls': [history]}))
    with Ledger(path, limit=bridge.CUMULATIVE_CAP) as ledger:
        for model in bridge.MODELS:
            for profile in ('H0', 'H1', 'H2', 'H3'):
                for step in (1, 2):
                    bridge.reserve(ledger, request('compatibility', 'compatibility', profile, model, step=step))
                for case in (f'h{i:02}' for i in range(1, 9)):
                    for repeat in ((0, 1) if case in ('h01', 'h03') else (0,)):
                        for step in range(1, 7):
                            bridge.reserve(ledger, request(case=case, profile=profile, model=model, repeat=repeat, step=step))
        assert len(ledger.entries) == 497 and ledger.entries[0] == history
        assert ledger.reserved == Decimal('25.79')
        for model in bridge.MODELS:
            rows = [row for row in ledger.entries if row.get('modelProfile') == model]
            assert len(rows) == 248
            assert sum(row['phase'] == 'compatibility' for row in rows) == 8
    assert sum(count * amount for count, amount in bridge.CAPS.values()) == Decimal('9.92')


def test_duplicate_unknown_attempt_and_cumulative_limit_remain_reserved(tmp_path):
    with Ledger(tmp_path / 'ledger.json', limit=Decimal(100)) as ledger:
        entry = bridge.reserve(ledger, request(model='ultra'))
        entry['status'] = 'failed_or_unknown_charge'
        ledger.save()
        with pytest.raises(ValueError, match='already reserved'):
            bridge.reserve(ledger, request(model='ultra'))
        assert ledger.reserved == Decimal('.03')
        ledger.entries.append({'reservedUsd': '25.83'})
        with pytest.raises(ValueError, match='Cumulative'):
            bridge.reserve(ledger, request(model='ultra', step=2))
        assert ledger.reserved == Decimal('25.86')


@pytest.mark.parametrize('change', [
    {'profile': 'H4'}, {'modelProfile': 'unknown'}, {'step': 7}, {'step': True}, {'repeat': -1},
    {'caseId': 'h02', 'repeat': 1}, {'phase': 'unknown'}, {'callId': 'new-run-reset'},
    {'wireInput': {}}, {'input': {'messages': [], 'tools': []}},
])
def test_invalid_envelope_cannot_dispatch(change):
    item = request(); item.update(change)
    with pytest.raises((ValueError, TypeError)):
        bridge.validate_request(item)


def test_compatibility_and_agent_budgets_are_separate(tmp_path):
    with Ledger(tmp_path / 'ledger.json', limit=bridge.CUMULATIVE_CAP) as ledger:
        bridge.reserve(ledger, request('compatibility', 'compatibility'))
        bridge.reserve(ledger, request('compatibility', 'compatibility', step=2))
        for step in range(1, 7):
            bridge.reserve(ledger, request(step=step))
        # Tampered historical IDs cannot bypass per-cell and per-model caps.
        ledger.entries[-1]['callId'] = 'unknown-previous-attempt'
        with pytest.raises(ValueError, match='case/profile/model'):
            bridge.reserve(ledger, request(step=6))


@pytest.mark.parametrize('text', ['x' * 12001, '漢' * 4001], ids=['ascii-limit', 'utf8-limit'])
async def test_wire_utf8_byte_bound_precedes_reservation_and_paid_network(tmp_path, text):
    item = request(); item['input']['messages'][0]['content'] = text
    requests = []

    def handle(req):
        requests.append(req.method)
        assert req.method == 'GET'
        return httpx.Response(200, json={'data': [{'id': bridge.MODELS['super']}]})
    with Ledger(tmp_path / 'ledger.json', limit=bridge.CUMULATIVE_CAP) as ledger:
        async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
            gateway = bridge.HarnessGateway(CONFIG, client, ledger, item)
            with pytest.raises(ValueError, match='byte bound'):
                await bridge.HarnessProvider(gateway).respond(RespondInput.model_validate(item['input']))
        assert requests == ['GET'] and not ledger.entries


@pytest.mark.parametrize('change', [{'reasoning_effort': 'low'}, {'stream': True},
                                   {'max_completion_tokens': 4001}, {'temperature': .3},
                                   {'max_retries': 1}, {'model': 'substitute'}])
async def test_fixed_settings_reject_before_charge(tmp_path, change):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: pytest.fail('No network'))) as client:
        with Ledger(tmp_path / 'ledger.json', limit=bridge.CUMULATIVE_CAP) as ledger:
            gateway = bridge.HarnessGateway(CONFIG, client, ledger, request())
            payload = {'model': bridge.MODELS['super'], 'messages': [], 'max_completion_tokens': 4000,
                       'temperature': .2, 'store': False, 'stream': False, 'tool_choice': 'auto'}
            payload.update(change)
            with pytest.raises(ValueError):
                await gateway.request('Nebius', 'https://example.invalid', 'fixture', payload)
            assert not ledger.entries


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_dispatch_reserves_before_request_keeps_wire_and_usage(tmp_path, monkeypatch, mode):
    monkeypatch.setattr(bridge, 'ROOT', tmp_path)
    item = request(model='ultra', mode=mode)
    item['input']['tools'] = [{'name': 'brain_search', 'description': 'Search notes.', 'parameters': {'type': 'object'}}]
    requests = []

    def handle(req):
        requests.append(req.method)
        if req.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': bridge.MODELS['ultra']}]})
        body = json.loads(req.content)
        assert body['max_completion_tokens'] == 4000 and body['temperature'] == .2
        assert body['stream'] is False and not any('reasoning' in key for key in body)
        assert 'response_format' not in body
        assert all(tool['function']['name'] != 'deliver_answer' for tool in body.get('tools', []))
        if mode == 'answer_only':
            assert 'tools' not in body and body['tool_choice'] == 'none'
        else:
            assert len(body['tools']) == 2 and body['tool_choice'] == 'auto'
        ledger = json.loads((tmp_path / '.data/provider-validation.json').read_text())
        assert ledger['calls'][0]['status'] == 'reserved_before_dispatch'
        return httpx.Response(200, json=completion(bridge.MODELS['ultra']))
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        report = await bridge.dispatch(CONFIG, client, item, preflight())
        again = await bridge.dispatch(CONFIG, client, item, preflight())
    item['input']['messages'][0]['content'] = 'later mutation'
    assert report['input']['messages'][0]['content'] == 'Use only my notes.'
    assert report['wireInput']['messages'][0]['content'] == 'Use only my notes.'
    assert report['status'] == 'succeeded' and report['reservedUsd'] == '0.03'
    assert report['output']['toolCalls'] == [] and report['rawResponse']['model'] == bridge.MODELS['ultra']
    assert report['usage'] == report['evidence']['usage'] == {'prompt_tokens': 10, 'completion_tokens': 7, 'total_tokens': 17}
    assert again['status'] == 'not_dispatched' and again['reservedUsd'] == '0.00'
    assert requests == ['GET', 'POST', 'GET']


async def test_failed_provider_is_not_retried_or_refunded(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, 'ROOT', tmp_path)
    requests = []

    def handle(req):
        requests.append(req.method)
        if req.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': bridge.MODELS['super']}]})
        return httpx.Response(429, json={'error': 'private text and fixture-secret'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        report = await bridge.dispatch(CONFIG, client, request(), preflight())
    assert requests == ['GET', 'POST']
    assert report['status'] == 'failed_or_unknown_charge' and report['reservedUsd'] == '0.01'
    assert 'private' not in report['error'] and 'fixture-secret' not in json.dumps(report)
    assert json.loads((tmp_path / '.data/provider-validation.json').read_text())['calls'][0]['reservedUsd'] == '0.01'


async def test_read_only_preflight_uses_inventory_and_current_conservative_prices():
    requests = []

    def handle(req):
        requests.append(req.method)
        assert req.method == 'GET'
        if req.url.path.endswith('/models'):
            return httpx.Response(200, json={'data': [{'id': model} for model in bridge.MODELS.values()]})
        return httpx.Response(200, json=[{'flavors': [
            {'model_id': model, 'input_price_per_million_tokens': .3, 'output_price_per_million_tokens': .9}
            for model in bridge.MODELS.values()]}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(handle)) as client:
        result = await bridge.preflight(CONFIG, client)
    assert requests == ['GET', 'GET'] and result['inferenceCalls'] == 0
    assert all(Decimal(row['textBoundUsd']) == Decimal('.0081') for row in result['models'])
    bridge.verify_preflight({'preflight': result})


@pytest.mark.parametrize('change', ['old', 'future', 'unavailable', 'too_expensive'])
def test_preflight_cannot_be_stale_unavailable_or_under_reserved(change):
    frozen = preflight()
    if change in ('old', 'future'):
        hours = -3 if change == 'old' else 1
        frozen['preflight']['at'] = (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()
    elif change == 'unavailable':
        frozen['preflight']['models'][1]['available'] = False
    else:
        frozen['preflight']['models'][0]['inputUsdPerMillion'] = '100'
    with pytest.raises(ValueError):
        bridge.verify_preflight(frozen)


def test_freeze_includes_transport_and_reused_ledger_sources(tmp_path, monkeypatch):
    monkeypatch.setattr(bridge, 'ROOT', tmp_path)
    hashes = {}
    for relative in bridge.REQUIRED_FROZEN:
        target = tmp_path / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(relative)
        hashes[relative] = bridge.digest(target)
    path = tmp_path / 'freeze.json'
    path.write_text(json.dumps({'experiment': bridge.EXPERIMENT, 'sourceHashes': hashes}))
    bridge.verify_freeze(path)
    (tmp_path / 'scripts/harness-provider.py').write_text('changed')
    with pytest.raises(ValueError, match='changed'):
        bridge.verify_freeze(path)
    path.write_text(json.dumps({'experiment': bridge.EXPERIMENT, 'sourceHashes': {}}))
    with pytest.raises(ValueError, match='Incomplete'):
        bridge.verify_freeze(path)
