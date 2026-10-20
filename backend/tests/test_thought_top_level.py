"""Deterministic wire safety checks, not evidence of a model's semantic fidelity."""
import json

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings


def thought(*, active=True, finalize=False, incremental=True):
    return ThoughtInput(sessionId='session', incremental=incremental, finalize=finalize,
        activeNote={
            'id': 'latest-note', 'title': 'Greenhouse plan', 'sourceRevision': 3,
            'summary': 'The user wrote twelve trays in a draft; installation is unconfirmed.',
            'sourceExcerpt': 'user: I wrote twelve trays in the draft. None is confirmed installed.',
            'sourceTruncated': False,
        } if active else None,
        segments=[{
            'id': 'correction', 'turnId': 'turn-1', 'revision': 2, 'speaker': 'user',
            'text': '  Correction: eight trays, not twelve. \nBrain 🧠 next. Back to the greenhouse?  ',
            'final': True, 'createdAt': '2026-10-04T01:00:00Z',
        }])


def group(ids, title='Greenhouse plan'):
    return {'title': title, 'summary': 'The user corrected the proposed tray count to eight.',
            'topicSuggestions': ['Greenhouse'], 'unitIds': ids}


def output():
    return {'continuesActive': True, 'lastOngoing': True,
            'groups': [group(['u0']), group(['u1'], 'Brain'), group(['u2'], 'Greenhouse return')],
            'remainder': []}


async def execute(item, response, *, status=200, finish='stop'):
    settings = Settings(nebius_api_key='fixture', thought_organization_format='units_top_level')
    calls = []

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
        calls.append(json.loads(request.content))
        if status != 200:
            return httpx.Response(status, json={'error': 'Fixture provider failure'})
        return httpx.Response(200, json={'model': settings.summary_model, 'choices': [
            {'finish_reason': finish, 'message': {'content': json.dumps(response)}}]})

    original = item.model_dump()
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        try:
            result = await NebiusProvider(Gateway(settings, client)).consolidate(item)
        except ServiceError as error:
            result = error
    assert item.model_dump() == original
    assert len(calls) == 1  # A validation/provider failure must never retry.
    return result, calls[0]


def test_top_level_wire_is_explicit_and_does_not_change_production_default(monkeypatch):
    monkeypatch.delenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', raising=False)
    assert Settings().thought_organization_format == Settings.from_env().thought_organization_format == 'units'
    monkeypatch.setenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', 'units_top_level')
    assert Settings.from_env().thought_organization_format == 'units_top_level'


@pytest.mark.parametrize('active', [False, True])
@pytest.mark.parametrize('finalize', [False, True])
async def test_schema_constrains_state_and_server_assigns_only_first_and_last_flags(active, finalize):
    reply = output()
    reply.update(continuesActive=active, lastOngoing=not finalize)
    result, payload = await execute(thought(active=active, finalize=finalize), reply)
    assert not isinstance(result, ServiceError)
    assert [g.continuesActive for g in result.groups] == [active, False, False]
    assert [g.ongoing for g in result.groups] == [False, False, not finalize]
    schema = payload['response_format']['json_schema']['schema']
    assert set(schema['properties']) == {'groups', 'remainder', 'continuesActive', 'lastOngoing'}
    assert set(schema['required']) == set(schema['properties'])
    assert schema['properties']['continuesActive'].get('enum') == (None if active else [False])
    assert schema['properties']['lastOngoing'].get('enum') == ([False] if finalize else None)
    properties = schema['$defs']['ThoughtWireGroup']['properties']
    assert set(properties) == {'title', 'summary', 'topicSuggestions', 'unitIds'}
    assert set(schema['$defs']['ThoughtWireGroup']['required']) == set(properties)
    assert schema['$defs']['ThoughtWireGroup']['additionalProperties'] is False
    assert schema['properties']['groups']['minItems'] == 1
    assert schema['properties']['groups']['maxItems'] == 6
    assert properties['summary']['maxLength'] == 1000
    assert payload['model'] == 'nvidia/Nemotron-3_5-Lightning'
    assert payload['max_completion_tokens'] == 16384 and payload['temperature'] == 0.2
    assert 'chat_template_kwargs' not in payload
    assert 'FIRST group and lastOngoing only to the LAST group' in payload['messages'][0]['content']
    state = json.loads(payload['messages'][1]['content'])
    assert ''.join(unit['text'] for unit in state['units']) == thought().segments[0].text
    text_bytes = thought().segments[0].text.encode('utf-16-le')
    published = ''.join(text_bytes[span.start * 2:span.end * 2].decode('utf-16-le')
                        for g in result.groups for span in g.spans)
    assert published == thought().segments[0].text
    assert all(span.revision == 2 and span.segmentId == 'correction'
               for g in result.groups for span in g.spans)


async def test_single_growing_group_can_both_continue_and_remain_ongoing():
    result, _ = await execute(thought(), {
        'continuesActive': True, 'lastOngoing': True,
        'groups': [group(['u0', 'u1'])], 'remainder': ['u2'],
    })
    assert result.groups[0].continuesActive and result.groups[0].ongoing
    assert result.groups[0].spans[-1].end == result.remainder[0].start
    assert result.remainder[0].end == len(thought().segments[0].text.encode('utf-16-le')) // 2


@pytest.mark.parametrize('bad', [
    'unknown', 'duplicate', 'reversed', 'missing', 'wrong-remainder', 'group-flags',
    'string-flag', 'numeric-flag', 'missing-flag', 'blank-title', 'blank-summary',
    'oversized-summary', 'empty-incremental', 'unknown-field',
])
async def test_invalid_candidate_output_is_rejected_with_source_unchanged(bad):
    reply = output()
    if bad == 'unknown': reply['groups'][0]['unitIds'] = ['u99']
    if bad == 'duplicate': reply['groups'][1]['unitIds'] = ['u0']
    if bad == 'reversed': reply['groups'].reverse()
    if bad == 'missing': reply['groups'].pop()
    if bad == 'wrong-remainder': reply['remainder'] = ['u0']
    if bad == 'group-flags': reply['groups'][0]['ongoing'] = True
    if bad == 'string-flag': reply['lastOngoing'] = 'false'
    if bad == 'numeric-flag': reply['continuesActive'] = 1
    if bad == 'missing-flag': del reply['continuesActive']
    if bad == 'blank-title': reply['groups'][0]['title'] = '  '
    if bad == 'blank-summary': reply['groups'][0]['summary'] = '\n'
    if bad == 'oversized-summary': reply['groups'][0]['summary'] = 'x' * 1001
    if bad == 'empty-incremental':
        reply = {'continuesActive': False, 'lastOngoing': False, 'groups': [], 'remainder': ['u0', 'u1', 'u2']}
    if bad == 'unknown-field': reply['unexpected'] = 'source instructions are not a contract'
    result, _ = await execute(thought(), reply)
    assert isinstance(result, ServiceError) and result.status == 422
    assert str(result) == 'Invalid thought organization; full transcript retained'


@pytest.mark.parametrize('case', ['no-active', 'final-ongoing', 'final-remainder', 'empty-flags'])
async def test_impossible_top_level_transitions_cannot_bypass_schema_validation(case):
    item, reply = thought(), output()
    if case == 'no-active': item = thought(active=False)
    if case == 'final-ongoing': item = thought(finalize=True)
    if case == 'final-remainder':
        item = thought(finalize=True)
        reply.update(lastOngoing=False, groups=[group(['u0'])], remainder=['u1', 'u2'])
    if case == 'empty-flags':
        item = thought(incremental=False)
        reply.update(groups=[], remainder=['u0', 'u1', 'u2'])
    result, _ = await execute(item, reply)
    assert isinstance(result, ServiceError) and result.status == 422


async def test_legacy_unfinished_source_can_stay_entirely_in_remainder():
    result, _ = await execute(thought(incremental=False), {
        'continuesActive': False, 'lastOngoing': False, 'groups': [], 'remainder': ['u0', 'u1', 'u2'],
    })
    assert result.groups == [] and len(result.remainder) == 3


@pytest.mark.parametrize('failure', ['provider', 'output-limit'])
async def test_provider_failure_or_exhausted_output_does_not_retry(failure):
    result, _ = await execute(thought(), output(), status=503 if failure == 'provider' else 200,
                              finish='length' if failure == 'output-limit' else 'stop')
    assert isinstance(result, ServiceError)
    if failure == 'output-limit': assert '16,384-token output limit' in str(result)


async def test_complete_request_bound_is_unchanged_and_checked_before_dispatch():
    settings = Settings(nebius_api_key='fixture', thought_organization_format='units_top_level')
    item = thought().model_copy(update={'context': '界' * 12000})

    def unexpected(_):
        pytest.fail('Oversized request must stop before provider dispatch')

    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(ServiceError, match='32,000-byte limit'):
            await NebiusProvider(Gateway(settings, client)).consolidate(item)


@pytest.mark.parametrize('bound', [1000, 4000])
async def test_one_constant_drives_schema_prompt_and_validator(bound, monkeypatch):
    # Re-adopting a longer group summary is one constant, never three literals drifting apart (BGN-10).
    from moolai_backend import providers
    monkeypatch.setattr(providers, 'GROUP_SUMMARY_CHARS', bound)
    for length, accepted in ((bound, True), (bound + 1, False), (1001, bound >= 1001)):
        reply = output()
        reply['groups'][0]['summary'] = 'x' * length
        result, body = await execute(thought(), reply)
        schema = body['response_format']['json_schema']['schema']
        assert schema['$defs']['ThoughtWireGroup']['properties']['summary']['maxLength'] == bound
        assert f'each summary at most {bound} characters' in body['messages'][0]['content']
        assert isinstance(result, ServiceError) is (not accepted), (length, result)
