import json
import httpx
import pytest
from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings


def test_compact_organization_requires_explicit_valid_configuration(monkeypatch):
    monkeypatch.delenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', raising=False)
    assert Settings().thought_organization_format == 'units'
    assert Settings.from_env().thought_organization_format == 'units'
    monkeypatch.setenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', 'compact')
    assert Settings.from_env().thought_organization_format == 'compact'
    monkeypatch.setenv('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', 'automatic')
    with pytest.raises(ValueError, match='format'):
        Settings.from_env()


async def test_default_organization_preserves_unit_addressing_and_bounded_generation():
    # Changing the default model and continuity instructions must not activate
    # the separate compact-format experiment or expand its request allowance.
    settings=Settings(nebius_api_key='fixture')
    captured=[]
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        captured.append(json.loads(request.content))
        result={'groups':[{'title':'Plant plan','summary':'Keep twelve plants and add no more.',
            'topicSuggestions':[],'unitIds':['u0','u1'],'continuesActive':False,'ongoing':False}],'remainder':[]}
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[
            {'finish_reason':'stop','message':{'content':json.dumps(result)}}]})
    item=ThoughtInput(sessionId='s',incremental=True,finalize=True,segments=[dict(
        id='a',turnId='a',revision=1,speaker='user',text='Keep the twelve plants. Do not add more.',final=True,createdAt='now')])
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result=await NebiusProvider(Gateway(settings,client)).consolidate(item)
    assert result.remainder==[] and len(captured)==1
    body = captured[0]
    assert body['model'] == 'nvidia/Nemotron-3_5-Lightning'
    assert body['max_completion_tokens'] == 8192 and body['temperature'] == 0.2
    assert body['store'] is False and body['stream'] is False
    assert 'chat_template_kwargs' not in body
    state = json.loads(body['messages'][1]['content'])
    assert state['units'] == [
        {'id':'u0','speaker':'user','text':'Keep the twelve plants. '},
        {'id':'u1','speaker':'user','text':'Do not add more.'},
    ]
    schema = body['response_format']['json_schema']['schema']
    assert set(schema['properties']) == {'groups', 'remainder'}
    assert 'unitIds' in schema['$defs']['ThoughtWireGroup']['properties']
    assert 'additionalProperties' not in body['messages'][0]['content']
    assert json.dumps(schema) not in body['messages'][0]['content'], 'The structured schema is supplied once, not duplicated in instructions'


async def test_default_units_refuse_duplicate_identity_before_dispatch():
    settings=Settings(nebius_api_key='fixture')
    def unexpected(_request):
        pytest.fail('Duplicate source must be rejected before provider access')
    item=ThoughtInput(sessionId='s',finalize=True,segments=[dict(id='same',turnId='a',revision=1,
        speaker='user',text='A source.',final=True,createdAt='now')]*2)
    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(ServiceError,match='Duplicate'):
            await NebiusProvider(Gateway(settings,client)).consolidate(item)


async def test_default_units_enforce_the_complete_request_byte_bound():
    settings=Settings(nebius_api_key='fixture')
    def unexpected(_request):
        pytest.fail('Oversized request must be rejected before provider access')
    item=ThoughtInput(sessionId='s',finalize=True,context='界'*12000,segments=[dict(
        id='a',turnId='a',revision=1,speaker='user',text='Preserved source.',final=True,createdAt='now')])
    async with httpx.AsyncClient(transport=httpx.MockTransport(unexpected)) as client:
        with pytest.raises(ServiceError,match='32,000-byte limit') as error:
            await NebiusProvider(Gateway(settings,client)).consolidate(item)
    assert error.value.status==413

@pytest.mark.parametrize('bad', [False, True])
async def test_semantic_units_partition_source_with_utf16_and_never_use_pause_boundaries(bad):
    settings=Settings(nebius_api_key='fixture')
    captures=[]
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        body=json.loads(request.content);captures.append(body)
        state=json.loads(body['messages'][1]['content'])
        assert state['units'][0]['text']=='Hamstring 🦵. '
        assert 'NOT note boundaries' in body['messages'][0]['content']
        ids=[u['id'] for u in state['units']]
        result={'groups':[{'title':'Anatomy','summary':'The user discussed anatomy.','topicSuggestions':['Anatomy'],'unitIds':ids[:-1] if bad else ids}],'remainder':[]}
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[{'finish_reason':'stop','message':{'content':json.dumps(result)}}]})
    item=ThoughtInput(sessionId='s',finalize=True,segments=[dict(id='a',turnId='a',revision=1,speaker='user',text='Hamstring 🦵. Brain.',final=True,createdAt='now')])
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider=NebiusProvider(Gateway(settings,client))
        if bad:
            with pytest.raises(ServiceError,match='Invalid thought'):await provider.consolidate(item)
        else:
            result=await provider.consolidate(item)
            assert result.groups[0].spans[0].end==14
            assert result.groups[0].spans[1].start==14
            assert result.groups[0].spans[1].end==20
    assert len(captures)==1
    assert captures[0]['max_completion_tokens']==8192
    assert 'chat_template_kwargs' not in captures[0]  # Preserve grouping's evaluated reasoning profile.

@pytest.mark.parametrize('bad', ['none', 'wrong_continuation', 'ongoing_at_close', 'oversized'])
async def test_incremental_organization_carries_active_note_and_validates_flags(bad):
    settings=Settings(nebius_api_key='fixture')
    captures=[]
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        body=json.loads(request.content);captures.append(body)
        state=json.loads(body['messages'][1]['content'])
        assert state['incremental'] is True
        assert state['activeNote']['summary']=='First: recall needs dates.'
        assert body['response_format']['json_schema']['schema']['properties']['groups']['maxItems']==6
        assert 'chat_template_kwargs' not in body
        group={'title':'App review','summary':'First: recall needs dates. Second: Markdown rendering.' if bad!='oversized' else 'x'*1001,
               'topicSuggestions':['App review'],'unitIds':[u['id'] for u in state['units']], 'continuesActive':True,'ongoing':True}
        groups=[group]
        if bad=='wrong_continuation':
            groups=[{**group,'continuesActive':False,'ongoing':False,'unitIds':['u0']},{**group,'unitIds':['u1']}]
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'groups':groups,'remainder':[]})}}]})
    item=ThoughtInput(sessionId='s',incremental=True,finalize=bad=='ongoing_at_close',activeNote={'id':'note','title':'App review','summary':'First: recall needs dates.','sourceRevision':1,'sourceExcerpt':'user: First: recall needs dates.','sourceTruncated':False},
        segments=[dict(id='a',turnId='a',revision=1,speaker='user',text='Second: Markdown rendering. Keep lists.',final=True,createdAt='now')])
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider=NebiusProvider(Gateway(settings,client))
        if bad!='none':
            with pytest.raises(ServiceError,match='Invalid thought'):await provider.consolidate(item)
        else:
            result=await provider.consolidate(item);assert result.groups[0].ongoing;assert result.groups[0].continuesActive
    assert len(captures)==1  # No automatic retry, including invalid output.
