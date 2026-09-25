from decimal import Decimal
import json

import httpx
import pytest

from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger, validate


async def test_inventory_default_never_makes_paid_calls(tmp_path):
    settings = Settings(nebius_api_key='fixture')
    seen = []

    def respond(request):
        seen.append(request)
        assert request.method == 'GET'
        return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        report = await validate(settings, ['nebius'], False, None, tmp_path / 'ledger.json', client=client)
    assert report['paidCalls'] == 0 and len(seen) == 1
    assert not (tmp_path / 'ledger.json').exists()
    assert 'fixture' not in json.dumps(report)


async def test_no_paid_checks_if_any_preflight_fails(tmp_path):
    def respond(_request):
        pytest.fail('missing configuration must not make a request')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        report = await validate(Settings(typesafe_api_key='fixture'), ['jev', 'tavily'], True, Decimal('1'), tmp_path / 'ledger.json', client=client)
    assert report['paidCalls'] == 0


async def test_budget_fails_before_dispatch(tmp_path):
    def respond(_request):
        pytest.fail('exceeded budget must prevent paid dispatch')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ValueError, match=r'US\$5'):
            await validate(Settings(typesafe_api_key='fixture', tavily_api_key='fixture'), ['jev', 'tavily'], True, Decimal('3'), tmp_path / 'ledger.json', client=client)


async def test_one_call_each_and_unknown_charges_stay_reserved(tmp_path):
    ledger = tmp_path / 'ledger.json'
    seen = []

    def respond(request):
        seen.append(request)
        if 'typesafe' in request.url.host:
            body = json.loads(request.content)
            assert len(body['questions']) == 1 and len(body['state']) < 100
            return httpx.Response(200, json={'model': 'jev-1.13.0', 'answers': {'check': {'type': 'noul', 'noul': .99}}, 'usage': {'input_tokens': 50, 'output_tokens': 1, 'secret': 'must-not-save'}})
        raise httpx.ReadTimeout('PRIVATE DETAILS', request=request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        report = await validate(Settings(typesafe_api_key='secret-key', tavily_api_key='secret-key'), ['jev', 'tavily'], True, Decimal('2'), ledger, client=client)
    assert report['paidCalls'] == 2 and len(seen) == 2
    assert report['reservedUsdTotal'] == '4'
    data = json.loads(ledger.read_text())
    assert [entry['status'] for entry in data['calls']] == ['succeeded', 'failed_or_unknown_charge']
    assert 'PRIVATE' not in ledger.read_text() and 'secret' not in ledger.read_text()
    with Ledger(ledger) as stored:
        with pytest.raises(ValueError, match=r'US\$5'):
            stored.ensure_budget(1, Decimal('2'))


async def test_nebius_inventory_precedes_one_capped_completion(tmp_path):
    settings = Settings(nebius_api_key='fixture')
    seen = []

    def respond(request):
        seen.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
        body = json.loads(request.content)
        assert body['max_completion_tokens'] == 32 and body['model'] == settings.summary_model
        assert 'max_tokens' not in body and body['store'] is False
        return httpx.Response(200, json={'model': settings.summary_model, 'choices': [{'finish_reason': 'stop', 'message': {'content': 'ready'}}], 'usage': {'total_tokens': 12}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        report = await validate(settings, ['nebius'], True, Decimal('.10'), tmp_path / 'ledger.json', client=client)
    assert seen == ['GET', 'POST'] and report['providers']['nebius']['accessVerified'] is True


def test_nonfinite_or_negative_reservations_rejected(tmp_path):
    with Ledger(tmp_path / 'ledger.json') as ledger:
        for amount in ('NaN', 'Infinity', '-1', '0'):
            with pytest.raises(ValueError):
                ledger.ensure_budget(1, Decimal(amount))
