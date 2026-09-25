"""No-network bounds and ledger checks for the one-shot closeout regression."""
import importlib.util
import json
import sys
from decimal import Decimal
from pathlib import Path

import httpx
import pytest

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'backend'))
spec = importlib.util.spec_from_file_location('final_regression_provider', Path(__file__).with_name('provider.py'))
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger


def request(case='a01', method='respond', step=1):
    value = {'messages': [{'role': 'user', 'content': 'Use only my notes.'}], 'tools': []}
    if method == 'route':
        value = {'text': 'Hello', 'recentContext': '', 'activeConversation': False}
    elif method == 'vision':
        value = {'image': {'mimeType': 'image/png', 'dataBase64': 'YWJj'}, 'question': 'Read the label'}
    return {'callId': f'{bridge.EXPERIMENT}:{case}:{method}:{step}', 'caseId': case,
            'method': method, 'step': step, 'input': value}


def test_declared_matrix_and_theoretical_category_reservations_are_bounded():
    cases = json.loads(Path(__file__).with_name('cases.json').read_text())
    assert [len(cases[group]) for group in ('j1', 'answers', 'enrichment', 'ocr')] == [12, 6, 6, 4]
    assert len({c['id'] for group in ('j1', 'answers', 'enrichment', 'ocr') for c in cases[group]}) == 28
    assert sum(amount * maximum for maximum, amount in bridge.CAPS.values()) == Decimal('3.58')
    assert bridge.RUN_CAP == Decimal('4') and bridge.TOTAL_CAP == Decimal('35.87')
    assert bridge.INPUT_TOKENS * Decimal(1) / 1_000_000 + 2400 * Decimal(3) / 1_000_000 < bridge.CAPS['respond'][1]
    assert all((ROOT / c['image']).is_file() for c in cases['ocr'])


def test_reservations_are_stable_and_failed_requests_are_never_refunded(tmp_path):
    with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
        entry = bridge.reserve(ledger, request())
        entry['status'] = 'failed_or_unknown_charge'
        ledger.save()
        with pytest.raises(ValueError, match='Already reserved'):
            bridge.reserve(ledger, request())
        assert ledger.reserved == Decimal('.03')
        bridge.reserve(ledger, request(step=2))
        assert ledger.reserved == Decimal('.06')


def test_per_case_generation_allowance_cannot_be_reset(tmp_path):
    with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
        for step in range(1, 7):
            bridge.reserve(ledger, request(case='a03', step=step))
        with pytest.raises(ValueError, match='Per-case'):
            bridge.reserve(ledger, request(case='a03', step=7))
        assert len(ledger.entries) == 6


def test_historical_ledger_fingerprint_requires_review_if_balance_changes(tmp_path):
    with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
        ledger.entries = [{'reservedUsd': '23.536', 'status': 'historical'}]
        history = bridge.historical_ledger(ledger)
        assert history['calls'] == 1 and history['reservedUsd'] == '23.536'
        bridge.reserve(ledger, request())
        assert bridge.historical_ledger(ledger) == history
        ledger.entries[0]['reservedUsd'] = '23.537'
        with pytest.raises(ValueError, match='Historical'):
            bridge.historical_ledger(ledger)


@pytest.mark.parametrize('change', [{'caseId': 'unknown'}, {'method': 'web'}, {'step': True},
                                   {'step': 0}, {'callId': 'reset'}, {'extra': 'field'}])
def test_unknown_or_reset_request_cannot_dispatch(change):
    item = request(); item.update(change)
    with pytest.raises((ValueError, TypeError)):
        bridge.validate(item)


def test_group_isolation_and_one_vision_call_per_case(tmp_path):
    invalid = request('j01')
    with pytest.raises(ValueError, match='isolation'):
        bridge.validate(invalid)
    with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
        bridge.reserve(ledger, request('o01', 'vision'))
        with pytest.raises(ValueError, match='Per-case'):
            bridge.reserve(ledger, request('o01', 'vision', 2))


@pytest.mark.parametrize('kind', ['run', 'cumulative'])
def test_budget_rejection_prevents_reservation(tmp_path, kind):
    with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
        ledger.entries = [{'reservedUsd': '3.99', 'validation': bridge.EXPERIMENT, 'method': 'other'}] if kind == 'run' else [{'reservedUsd': '35.86'}]
        before = list(ledger.entries)
        with pytest.raises(ValueError, match='cap exceeded'):
            bridge.reserve(ledger, request())
        assert ledger.entries == before


@pytest.mark.asyncio
@pytest.mark.parametrize('content', ['x' * 16001, '漢' * 5334], ids=['ascii', 'utf8'])
async def test_complete_text_wire_bound_precedes_reservation_and_network(tmp_path, content):
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda _: pytest.fail('No network'))) as client:
        with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
            gateway = bridge.Metered(Settings(), client, ledger, request())
            with pytest.raises(ValueError, match='text payload too large'):
                await gateway.request('Nebius', 'https://example.invalid', 'fixture', {
                    'model': bridge.MODELS['respond'], 'messages': [{'role': 'user', 'content': content}],
                    'max_completion_tokens': 2400, 'temperature': .2,
                })
            assert ledger.entries == []


@pytest.mark.asyncio
async def test_reservation_is_written_before_failed_network_and_second_dispatch_rejected(tmp_path):
    path = tmp_path / 'ledger.json'
    calls = []

    def fail(_request):
        calls.append(1)
        assert json.loads(path.read_text())['calls'][0]['status'] == 'reserved_before_dispatch'
        return httpx.Response(429, json={'error': 'synthetic provider refusal'})

    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        with Ledger(path, limit=bridge.TOTAL_CAP) as ledger:
            gateway = bridge.Metered(Settings(), client, ledger, request())
            payload = {'model': bridge.MODELS['respond'], 'messages': [], 'max_completion_tokens': 2400, 'temperature': .2}
            with pytest.raises(bridge.ServiceError):
                await gateway.request('Nebius', 'https://example.invalid', 'fixture', payload)
            with pytest.raises(ValueError, match='Second dispatch'):
                await gateway.request('Nebius', 'https://example.invalid', 'fixture', payload)
            assert ledger.reserved == Decimal('.03') and len(calls) == 1


def test_jev_pricing_requires_pinned_model_input_price_and_free_output_statement():
    document = '<p>jev-1.13.0</p><p>$0.042 per Mtok</p><p>Output tokens are free.</p>'
    result = bridge.jev_pricing(document)
    assert result['inputTokenAllowance'] == 20000
    assert Decimal(result['boundUsd']) == Decimal('.00084')
    assert result['outputUsdPerMillion'] == '0' and len(result['sourceSha256']) == 64
    for changed in [document.replace('0.042', '0.42'), document.replace('are free', 'are charged'),
                    document.replace('1.13.0', '1.14.0')]:
        with pytest.raises(ValueError, match='pricing changed'):
            bridge.jev_pricing(changed)


@pytest.mark.asyncio
async def test_vision_metering_keeps_nebius_destination_and_original_image_payload(tmp_path):
    endpoint = 'https://api.tokenfactory.nebius.com/v1/chat/completions'
    image_url = 'data:image/png;base64,YWJj'
    seen = []

    def respond(request):
        seen.append(str(request.url))
        assert str(request.url) == endpoint
        body = json.loads(request.content)
        assert body['messages'][0]['content'][1]['image_url']['url'] == image_url
        return httpx.Response(200, json={'model': bridge.MODELS['vision'], 'usage': {'prompt_tokens': 42}})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with Ledger(tmp_path / 'ledger.json', limit=bridge.TOTAL_CAP) as ledger:
            gateway = bridge.Metered(Settings(), client, ledger, request('o01', 'vision'))
            payload = {'model': bridge.MODELS['vision'], 'max_completion_tokens': 1600, 'temperature': .2,
                       'messages': [{'role': 'user', 'content': [{'type': 'text', 'text': 'Read the label'},
                           {'type': 'image_url', 'image_url': {'url': image_url}}]}]}
            result = await gateway.request('Nebius', endpoint, 'fixture', payload)
            assert result['usage']['prompt_tokens'] == 42
            assert gateway.wire == payload and ledger.reserved == Decimal('.03')
    assert seen == [endpoint]
