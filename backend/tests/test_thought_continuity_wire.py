"""Mocked wire/validation checks; these do not establish model summary fidelity."""
import json

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings


ACTIVE_NOTE = {
    'id': 'review', 'title': 'Four app issues', 'sourceRevision': 4,
    'summary': 'The user recorded issues one and two and will provide two more.',
    'sourceExcerpt': 'user: First, recall dates are missing. Second, lists need Markdown.',
    'sourceTruncated': False,
}


def request_item(active, finalize):
    return ThoughtInput(sessionId='s', incremental=True, finalize=finalize,
        activeNote=ACTIVE_NOTE if active else None, segments=[{
            'id':'next', 'turnId':'next', 'revision':2, 'speaker':'user', 'final':True,
            'createdAt':'now',
            'text':'Third, scrolling freezes. Fourth, speech skips later points. All four are recorded, but none are fixed.',
        }])


@pytest.mark.parametrize('wire_format', ['units', 'compact'])
@pytest.mark.parametrize('active', [False, True])
@pytest.mark.parametrize('finalize', [False, True])
async def test_state_specific_schema_and_reconciled_summary_context(wire_format, active, finalize):
    settings = Settings(nebius_api_key='fixture', thought_organization_format=wire_format)
    captures = []

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data':[{'id':settings.summary_model}]})
        body = json.loads(request.content)
        captures.append(body)
        state = json.loads(body['messages'][1]['content'])
        assert state['activeNote'] == (ACTIVE_NOTE if active else None)
        assert state['units'][-1]['text'] == 'All four are recorded, but none are fixed.'
        schema = body['response_format']['json_schema']['schema']
        properties = schema['$defs']['ThoughtWireGroup']['properties']
        assert properties['continuesActive'].get('enum') == (None if active else [False])
        assert properties['ongoing'].get('enum') == ([False] if finalize else None)
        assert set(schema['$defs']['ThoughtWireGroup']['required']) == set(properties)
        assert schema['$defs']['ThoughtWireGroup']['additionalProperties'] is False
        group = {
            'title':'Four app issues', 'summary':'The user recorded four issues; none is fixed.',
            'topicSuggestions':['App review'], 'continuesActive':active, 'ongoing':False,
        }
        if wire_format == 'units':
            group['unitIds'] = [unit['id'] for unit in state['units']]
            output = {'groups':[group], 'remainder':[]}
        else:
            group['endUnit'] = len(state['units']) - 1
            output = {'groups':[group]}
        return httpx.Response(200, json={'model':settings.summary_model, 'choices':[
            {'finish_reason':'stop', 'message':{'content':json.dumps(output)}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result = await NebiusProvider(Gateway(settings, client)).consolidate(request_item(active, finalize))
    assert result.groups[0].continuesActive is active and not result.groups[0].ongoing
    assert result.remainder == [] and len(captures) == 1
    instructions = captures[0]['messages'][0]['content']
    for behavior in [
        'Corrections, elaborations, numbered points and subheadings',
        'latest eligible topic, including a note whose previous summary was complete',
        'A complete summary does not by itself mean the topic changed',
        'retained summary as a draft', 'replace superseded quantities',
        'remove stale promises or unfinished-list wording',
        'Recording all issues is not fixing all issues',
        'speaker attribution', 'uncertainty', 'NEW episode, not a merge',
    ]:
        assert behavior in instructions
    assert captures[0]['max_completion_tokens'] == 16384
    assert 'chat_template_kwargs' not in captures[0]


@pytest.mark.parametrize('wire_format', ['units', 'compact'])
@pytest.mark.parametrize('invalid_flag', ['continuesActive', 'ongoing'])
async def test_ignored_schema_constraints_still_fail_without_retry(wire_format, invalid_flag):
    settings = Settings(nebius_api_key='fixture', thought_organization_format=wire_format)
    calls = []
    item = request_item(active=False, finalize=True)
    original = item.model_dump()

    def upstream(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data':[{'id':settings.summary_model}]})
        body = json.loads(request.content)
        calls.append(body)
        state = json.loads(body['messages'][1]['content'])
        group = {'title':'Review', 'summary':'The recorded issues remain unresolved.',
            'topicSuggestions':[], 'continuesActive':False, 'ongoing':False, invalid_flag:True}
        if wire_format == 'units':
            group['unitIds'] = [unit['id'] for unit in state['units']]
            output = {'groups':[group], 'remainder':[]}
        else:
            group['endUnit'] = len(state['units']) - 1
            output = {'groups':[group]}
        return httpx.Response(200, json={'model':settings.summary_model, 'choices':[
            {'finish_reason':'stop', 'message':{'content':json.dumps(output)}}]})

    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        with pytest.raises(ServiceError, match='Invalid thought organization'):
            await NebiusProvider(Gateway(settings, client)).consolidate(item)
    assert len(calls) == 1
    assert item.model_dump() == original
