"""Synthetic regressions for authored-source fidelity and HTTP request lifetime."""
import asyncio
import json

import httpx
import pytest

from moolai_backend.app import create_app
from moolai_backend.providers import Gateway, JevProvider, ServiceError, TavilyProvider
from moolai_backend.request_lifetime import run_provider_request
from moolai_backend.schemas import Author, TagInput
from moolai_backend.settings import Settings
from starlette.requests import Request


async def test_j7_receives_authoritative_body_attribution_and_mixed_sources(record):
    states = []
    def respond(request):
        payload = json.loads(request.content)
        state = json.loads(payload['state'])
        states.append(state)
        return httpx.Response(200, json={'model': 'jev-1', 'answers': {
            'purpose': {'type': 'choice', 'choice': 'Reference', 'confidence': 1.0,
                        'probabilities': {name: float(name == 'Reference')
                            for name in payload['questions']['purpose']['criteria']}},
            'doubt': {'type': 'noul', 'noul': .1},
            'faithful': {'type': 'noul', 'noul': .1},
            'understandable': {'type': 'noul', 'noul': .95},
        }})

    settings = Settings(typesafe_api_key='fixture', jev_model='jev-1')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = JevProvider(Gateway(settings, client))
        for body in ('The planned dose is 5 mg, not 50 mg.', 'The planned dose is 50 mg, not 5 mg.'):
            authored = record.model_copy(update={'body': body, 'segments': []})
            await provider.tag(TagInput(record=authored, topicCandidates=[]))
        mixed = record.model_copy(update={'body': 'Correction: more shade was only a proposal.'})
        mixed.author = Author(id='writer', kind='user', name='Fixture author')
        await provider.tag(TagInput(record=mixed, topicCandidates=[]))

    assert states[0]['node']['authoredBody'] != states[1]['node']['authoredBody']
    assert states[0]['node']['segments'] == []
    assert states[0]['node']['authoredBy'] is None  # Do not invent authorship.
    assert states[2]['node']['authoredBy']['kind'] == 'user'
    assert states[2]['node']['segments'][0]['speaker'] == 'user'
    assert states[2]['node']['segments'][0]['text'] == record.segments[0].text


async def test_j7_oversized_authored_source_is_rejected_without_silent_clipping(record):
    def unexpected(_):
        pytest.fail('An oversized source must not be dispatched')
    settings = Settings(typesafe_api_key='fixture', max_context_chars=1000)
    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(ServiceError, match='Context is too large'):
            await JevProvider(Gateway(settings, client)).tag(TagInput(
                record=record.model_copy(update={'body': 'Original words. ' * 1000}), topicCandidates=[]))


@pytest.mark.parametrize('returned', [
    ['https://example.org/a', 'https://example.org/a'],
    ['https://example.org/a', 'https://example.org/unmapped-redirect'],
    ['https://example.org/a'],
])
async def test_extract_requires_each_requested_resource_not_just_matching_counts(returned):
    def respond(_):
        return httpx.Response(200, json={'results': [
            {'url': url, 'raw_content': 'Source evidence'} for url in returned]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='incomplete extraction'):
            await TavilyProvider(Gateway(Settings(tavily_api_key='fixture'), client)).extract(
                ['https://example.org/a', 'https://example.org/b'])


async def test_extract_accepts_resource_equivalence_and_out_of_order_results():
    def respond(_):
        return httpx.Response(200, json={'results': [
            {'url': 'https://example.org/b?q=1', 'raw_content': 'B'},
            {'url': 'https://example.org/', 'raw_content': 'A'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        results = await TavilyProvider(Gateway(Settings(tavily_api_key='fixture'), client)).extract([
            'https://EXAMPLE.ORG:443#section', 'https://example.org/b?q=1'])
    assert [item.content for item in results] == ['B', 'A']


async def invoke_asgi(app, path, payload, queue, sent):
    body = json.dumps(payload).encode()
    queue.put_nowait({'type': 'http.request', 'body': body, 'more_body': False})
    async def send(event):
        sent.append(event)
    await app({'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1',
        'method': 'POST', 'scheme': 'http', 'path': path, 'raw_path': path.encode(),
        'query_string': b'', 'root_path': '', 'server': ('test', 80), 'client': ('test', 1),
        'headers': [(b'content-type', b'application/json'), (b'authorization', b'Bearer fixture')]},
        queue.get, send)


@pytest.mark.parametrize('during', ['inventory', 'completion'])
async def test_disconnect_cancels_inference_and_prevents_later_paid_dispatch(during):
    settings = Settings(backend_token='fixture', nebius_api_key='fixture')
    queue, sent, calls = asyncio.Queue(), [], []
    cancelled = asyncio.Event()
    async def respond(request):
        calls.append(request.url.path)
        if request.method == 'GET' and during != 'inventory':
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        queue.put_nowait({'type': 'http.disconnect'})
        if during == 'inventory':
            # A queued disconnect must be observed even if inventory immediately
            # returns, before the following paid completion is dispatched.
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        try:
            await asyncio.Event().wait()
        except asyncio.CancelledError:
            cancelled.set()
            raise

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        app = create_app(settings, http_client=client)
        await asyncio.wait_for(invoke_asgi(app, '/v1/respond', {
            'messages': [{'role': 'user', 'content': 'Explain the saved fixture.'}], 'tools': [],
        }, queue, sent), timeout=1)
    assert [event['status'] for event in sent if event['type'] == 'http.response.start'] == [499]
    assert len(calls) == (1 if during == 'inventory' else 2)
    assert cancelled.is_set() == (during == 'completion')


async def test_already_disconnected_caller_does_not_dispatch_and_next_request_is_independent():
    events = asyncio.Queue()
    events.put_nowait({'type': 'http.disconnect'})
    request = Request({'type': 'http'}, events.get)
    calls = []
    def respond(_):
        calls.append('dispatch')
        return httpx.Response(200, json={'ok': True})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        gateway = Gateway(Settings(), client)
        result = await run_provider_request(request, lambda: gateway.request('Fixture', 'https://example.org', 'fixture'))
        assert result.status_code == 499 and calls == []
        # Context and watcher cleanup cannot contaminate another request.
        assert await gateway.request('Fixture', 'https://example.org', 'fixture') == {'ok': True}
        assert calls == ['dispatch']


async def test_disconnect_isolated_to_its_request_and_stops_dispatch_after_caught_cancellation():
    abandoned, healthy = asyncio.Queue(), asyncio.Queue()
    inventory_started, continue_healthy = asyncio.Event(), asyncio.Event()
    dispatched = []

    async def respond(request):
        dispatched.append(request.url.path)
        return httpx.Response(200, json={'ok': True})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        gateway = Gateway(Settings(), client)
        async def stale_operation():
            inventory_started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                # Even if an intermediate dependency catches cancellation,
                # Gateway must not dispatch new paid work for its old caller.
                return await gateway.request('Fixture', 'https://example.org/old', 'fixture')

        async def current_operation():
            await continue_healthy.wait()
            return await gateway.request('Fixture', 'https://example.org/current', 'fixture')

        stale = asyncio.create_task(run_provider_request(Request({'type': 'http'}, abandoned.get), stale_operation))
        current = asyncio.create_task(run_provider_request(Request({'type': 'http'}, healthy.get), current_operation))
        await inventory_started.wait()
        abandoned.put_nowait({'type': 'http.disconnect'})
        assert (await stale).status_code == 499
        continue_healthy.set()
        assert await current == {'ok': True}
    assert dispatched == ['/current']


async def test_handler_cancellation_cannot_start_paid_work_during_cleanup():
    events, started = asyncio.Queue(), asyncio.Event()
    def unexpected(_):
        pytest.fail('Cancelled cleanup must not dispatch another provider call')
    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        gateway = Gateway(Settings(), client)
        async def operation():
            started.set()
            try:
                await asyncio.Event().wait()
            except asyncio.CancelledError:
                await gateway.request('Fixture', 'https://example.org', 'fixture')
        handler = asyncio.create_task(run_provider_request(Request({'type': 'http'}, events.get), operation))
        await started.wait()
        handler.cancel()
        with pytest.raises(asyncio.CancelledError):
            await handler
