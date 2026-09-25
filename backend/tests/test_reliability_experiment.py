import asyncio
from decimal import Decimal
import importlib.util
import json
from pathlib import Path
import sys

import httpx
import pytest

from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('reliability_experiment', ROOT / 'scripts/reliability-provider.py')
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


def request(phase='agent', case='opaque-case', profile='A', repeat=0, step=0):
    return {'phase': phase, 'caseId': case, 'profile': profile, 'repeat': repeat, 'step': step,
            'callId': f'{experiment.EXPERIMENT}:{phase}:{case}:{profile}:{repeat}:{step}'}


def test_budget_preserves_history_unknown_attempts_and_case_limits(tmp_path):
    path = tmp_path / 'ledger.json'
    path.write_text(json.dumps({'version': 1, 'calls': [{'reservedUsd': '9.27', 'status': 'failed_or_unknown_charge'}]}))
    with Ledger(path, limit=Decimal(20)) as ledger:
        experiment.reserve(ledger, request(), 'generation')
        assert ledger.reserved == Decimal('9.29')
        with pytest.raises(ValueError, match='already reserved'):
            experiment.reserve(ledger, request(), 'generation')
        experiment.reserve(ledger, request(step=1), 'generation')
        with pytest.raises(ValueError, match='case/profile'):
            experiment.reserve(ledger, request(step=2), 'generation')
    assert len(json.loads(path.read_text())['calls']) == 3


def test_frozen_aggregate_caps_fit_seven_dollars_and_cannot_reset_by_call_id(tmp_path):
    assert sum(maximum * amount for maximum, amount in experiment.CAPS.values()) == Decimal('6.84')
    with Ledger(tmp_path / 'ledger.json', limit=Decimal(20)) as ledger:
        for i in range(12):
            experiment.reserve(ledger, request('tag', f'opaque-{i}', 'current'), 'tag')
        with pytest.raises(ValueError, match='category'):
            experiment.reserve(ledger, request('tag', 'different-run', 'current'), 'tag')


def test_cumulative_ceiling_is_not_raised_or_refunded(tmp_path):
    path = tmp_path / 'ledger.json'
    path.write_text(json.dumps({'version': 1, 'calls': [{'reservedUsd': '19.99'}]}))
    with Ledger(path, limit=Decimal(20)) as ledger:
        with pytest.raises(ValueError, match='cumulative'):
            experiment.reserve(ledger, request(), 'generation')
        assert ledger.reserved == Decimal('19.99')


def test_expected_labels_never_enter_tag_or_model_selection():
    manifest = {'agentCases': [{'id': 'opaque-case', 'expected': {'answer': 'never send me'}}], 'agentRepeats': []}
    assert experiment.validate_request(request(), manifest) == ('generation', experiment.MODELS['super'])
    assert experiment.validate_request(request(profile='D'), manifest)[1] == experiment.MODELS['glm']
    with pytest.raises(ValueError, match='Undeclared'):
        experiment.validate_request(request(repeat=1), manifest)
    invalid = request(); invalid['callId'] = 'another-run'
    with pytest.raises(ValueError, match='operation'):
        experiment.validate_request(invalid, manifest)


@pytest.mark.parametrize('content', ['x' * 20001, '漢' * 7000])
def test_complete_wire_bound_rejects_before_reservation_or_network(tmp_path, content):
    async def run():
        network = []
        async def handler(req):
            network.append(req)
            return httpx.Response(200, json={})
        with Ledger(tmp_path / 'ledger.json', limit=Decimal(20)) as ledger:
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                gateway = experiment.ExperimentGateway(Settings(), client, ledger, request(), 'generation')
                with pytest.raises(ValueError, match='byte bound'):
                    await gateway.request('Nebius', 'https://example.test', 'fixture', {'messages': [], 'tools': [{'description': content}]})
                assert not ledger.entries
                assert not network
    asyncio.run(run())


def test_freeze_rejects_changed_sources(tmp_path, monkeypatch):
    monkeypatch.setattr(experiment, 'ROOT', tmp_path)
    source = tmp_path / 'source'; source.write_text('original')
    frozen = tmp_path / 'frozen.json'
    frozen.write_text(json.dumps({'experiment': experiment.EXPERIMENT, 'sourceHashes': {'source': experiment.digest(source)}}))
    experiment.verify_freeze(frozen)
    source.write_text('changed')
    with pytest.raises(ValueError, match='changed'):
        experiment.verify_freeze(frozen)


def test_reservation_precedes_dispatch_and_keeps_snapshot(tmp_path):
    async def run():
        with Ledger(tmp_path / 'ledger.json', limit=Decimal(20)) as ledger:
            async def handler(req):
                assert len(ledger.entries) == 1
                assert json.loads((tmp_path / 'ledger.json').read_text())['calls'][0]['status'] == 'reserved_before_dispatch'
                return httpx.Response(200, json={'model': 'fixture', 'usage': {'prompt_tokens': 10}, 'choices': []})
            async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
                gateway = experiment.ExperimentGateway(Settings(), client, ledger, request(), 'generation')
                payload = {'messages': [{'role': 'user', 'content': 'first'}]}
                await gateway.request('Nebius', 'https://example.test', 'fixture', payload)
                payload['messages'][0]['content'] = 'later mutation'
                assert gateway.wire_input['messages'][0]['content'] == 'first'
                with pytest.raises(ValueError, match='twice'):
                    await gateway.request('Nebius', 'https://example.test', 'fixture', payload)
    asyncio.run(run())
