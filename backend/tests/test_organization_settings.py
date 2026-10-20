"""Organization has its own bounded allowance; other generation roles stay stable."""
import json

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import RespondInput, ThoughtInput, VisionInput
from moolai_backend.settings import Settings


def test_organization_environment_is_independent(monkeypatch):
    monkeypatch.delenv('NEBIUS_ORGANIZATION_MAX_TOKENS', raising=False)
    default = Settings.from_env()
    assert default.organization_max_completion_tokens == 16384
    monkeypatch.setenv('NEBIUS_ORGANIZATION_MAX_TOKENS', '8192')
    configured = Settings.from_env()
    assert configured.organization_max_completion_tokens == 8192
    assert configured.summary_max_completion_tokens == default.summary_max_completion_tokens
    assert configured.agent_max_tokens == default.agent_max_tokens
    assert configured.thought_organization_format == default.thought_organization_format
    assert configured.summary_model == default.summary_model


@pytest.mark.parametrize('limit', [0, 4095, 16385, True, 8192.0, '8192', None])
def test_invalid_organization_limit_fails_at_configuration(limit):
    with pytest.raises(ValueError, match='Organization completion limit'):
        Settings(organization_max_completion_tokens=limit)


def thought():
    return ThoughtInput(sessionId='s', incremental=True, finalize=True, segments=[{
        'id': 'turn', 'turnId': 'turn', 'revision': 1, 'speaker': 'user',
        'text': 'A proposed room layout.', 'final': True, 'createdAt': '2026-10-11T00:00:00Z',
    }])


@pytest.mark.parametrize('format', ['units', 'units_top_level', 'compact'])
@pytest.mark.parametrize('limit', [4096, 8192, 16384])
async def test_every_organization_format_uses_only_the_configured_allowance(format, limit):
    settings = Settings(nebius_api_key='fixture', thought_organization_format=format,
                        organization_max_completion_tokens=limit)
    calls = []

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
        body = json.loads(request.content)
        calls.append(body)
        group = {'title': 'Room layout', 'summary': 'A room layout is proposed.', 'topicSuggestions': []}
        if format == 'compact':
            answer = {'groups': [{**group, 'endUnit': 0, 'continuesActive': False, 'ongoing': False}]}
        elif format == 'units_top_level':
            answer = {'groups': [{**group, 'unitIds': ['u0']}], 'remainder': [],
                      'continuesActive': False, 'lastOngoing': False}
        else:
            answer = {'groups': [{**group, 'unitIds': ['u0'], 'continuesActive': False, 'ongoing': False}],
                      'remainder': []}
        return httpx.Response(200, json={'model': settings.summary_model, 'choices': [{
            'finish_reason': 'stop', 'message': {'content': json.dumps(answer)}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result = await NebiusProvider(Gateway(settings, client)).consolidate(thought())
    assert result.groups[0].spans[0].end == len(thought().segments[0].text)
    assert len(calls) == 1
    assert calls[0]['max_completion_tokens'] == limit
    assert calls[0]['temperature'] == .2
    assert calls[0]['response_format']['json_schema']['strict'] is True
    assert not {'chat_template_kwargs', 'thinking_token_budget', 'reasoning_effort'} & calls[0].keys()


async def test_larger_organization_limit_does_not_change_other_roles(record):
    settings = Settings(nebius_api_key='fixture', organization_max_completion_tokens=16384)
    calls = []

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': model} for model in (
                settings.summary_model, settings.agent_model, settings.vision_model, settings.ocr_model)]})
        body = json.loads(request.content)
        calls.append(body)
        schema = body.get('response_format', {}).get('json_schema', {}).get('name')
        if schema == 'summary':
            answer = {'title': 'Garden', 'summary': 'Shade remains uncertain.', 'topicSuggestions': []}
        elif schema == 'topic_plan':
            answer = {'endUnits': [0], 'extendsActive': False, 'ongoing': False}
        elif body['model'] in (settings.vision_model, settings.ocr_model):
            answer = {'observations': [], 'interpretation': ''}
        else:
            answer = None
        return httpx.Response(200, json={'model': body['model'], 'choices': [{
            'finish_reason': 'stop', 'message': {'content': json.dumps(answer) if answer else 'The proposal is unconfirmed.'}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider = NebiusProvider(Gateway(settings, client))
        await provider.summarize(record)
        await provider.plan_thoughts(thought())
        await provider.respond(RespondInput(messages=[{'role': 'user', 'content': 'What is known?'}], tools=[]))
        for mode in ('visual', 'ocr'):
            await provider.vision(VisionInput(mode=mode, question='Read this.',
                image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert [body['max_completion_tokens'] for body in calls] == [1200, 4096, 2400, 1600, 1600]
    assert calls[0]['chat_template_kwargs'] == {'enable_thinking': False}
    assert all('chat_template_kwargs' not in body for body in calls[1:])
    assert calls[-1]['reasoning_effort'] == 'low'


async def test_organization_limit_failure_keeps_source_and_does_not_retry():
    settings = Settings(nebius_api_key='fixture', organization_max_completion_tokens=8192)
    source = thought()
    original = source.model_dump()
    calls = []

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
        calls.append(json.loads(request.content))
        return httpx.Response(200, json={'model': settings.summary_model, 'choices': [{
            'finish_reason': 'length', 'message': {'content': '{"groups":['}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        with pytest.raises(ServiceError, match='8,192-token output limit'):
            await NebiusProvider(Gateway(settings, client)).consolidate(source)
    assert len(calls) == 1 and source.model_dump() == original


async def test_only_organization_gets_the_longer_provider_timeout(record):
    # A 16,384-token organizer generation takes about 80 s; every other call keeps its 90 s bound.
    settings = Settings(nebius_api_key='fixture')
    timeouts = {}

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': model} for model in (settings.summary_model, settings.agent_model)]})
        body = json.loads(request.content)
        name = body.get('response_format', {}).get('json_schema', {}).get('name') or body['model']
        timeouts[name] = request.extensions['timeout']['read']
        if name == 'thoughts':
            answer = {'groups': [{'title': 'Garden', 'summary': 'Shade remains uncertain.', 'topicSuggestions': [],
                                  'unitIds': ['u0'], 'continuesActive': False, 'ongoing': False}], 'remainder': []}
        elif name == 'summary':
            answer = {'title': 'Garden', 'summary': 'Shade remains uncertain.', 'topicSuggestions': []}
        else:
            answer = None
        return httpx.Response(200, json={'model': body['model'], 'choices': [{
            'finish_reason': 'stop', 'message': {'content': json.dumps(answer) if answer else 'The proposal is unconfirmed.'}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider = NebiusProvider(Gateway(settings, client))
        try:
            await provider.consolidate(thought())
        except ServiceError:
            pass  # The organizer's reply shape is not under test; its request timeout is.
        await provider.summarize(record)
        await provider.respond(RespondInput(messages=[{'role': 'user', 'content': 'What is known?'}], tools=[]))
    assert timeouts['thoughts'] == 150
    assert timeouts['summary'] == 90 and timeouts[settings.agent_model] == 90
