import json
import httpx
import pytest
from pydantic import ValidationError
from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings

@pytest.mark.parametrize('bad', [False, True])
async def test_semantic_units_partition_source_with_utf16_and_never_use_pause_boundaries(bad):
    settings=Settings(nebius_api_key='fixture',thought_organization_format='compact')
    captures=[]
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        body=json.loads(request.content);captures.append(body)
        state=json.loads(body['messages'][1]['content'])
        assert state['units'][0]['text']=='Hamstring 🦵. '
        assert 'NOT note boundaries' in body['messages'][0]['content']
        assert [u['index'] for u in state['units']]==[0,1]
        assert 'additionalProperties' not in body['messages'][0]['content']
        result={'groups':[{'title':'Anatomy','summary':'The user discussed anatomy.','topicSuggestions':['Anatomy'],'endUnit':0 if bad else 1}]}
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
    assert captures[0]['max_completion_tokens']==16384
    assert captures[0]['temperature']==0.2
    assert 'chat_template_kwargs' not in captures[0]  # Preserve grouping's evaluated reasoning profile.
    assert 'max_request_bytes' not in captures[0]

@pytest.mark.parametrize('bad', ['none', 'wrong_continuation', 'ongoing_at_close', 'oversized'])
async def test_incremental_organization_carries_active_note_and_validates_flags(bad):
    settings=Settings(nebius_api_key='fixture',thought_organization_format='compact')
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
               'topicSuggestions':['App review'],'endUnit':len(state['units'])-1, 'continuesActive':True,'ongoing':True}
        groups=[group]
        if bad=='wrong_continuation':
            groups=[{**group,'continuesActive':False,'ongoing':False,'endUnit':0},{**group,'endUnit':1}]
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[{'finish_reason':'stop','message':{'content':json.dumps({'groups':groups})}}]})
    item=ThoughtInput(sessionId='s',incremental=True,finalize=bad=='ongoing_at_close',activeNote={'id':'note','title':'App review','summary':'First: recall needs dates.','sourceRevision':1,'sourceExcerpt':'user: First: recall needs dates.','sourceTruncated':False},
        segments=[dict(id='a',turnId='a',revision=1,speaker='user',text='Second: Markdown rendering. Keep lists.',final=True,createdAt='now')])
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider=NebiusProvider(Gateway(settings,client))
        if bad!='none':
            with pytest.raises(ServiceError,match='Invalid thought'):await provider.consolidate(item)
        else:
            result=await provider.consolidate(item);assert result.groups[0].ongoing;assert result.groups[0].continuesActive
    assert len(captures)==1  # No automatic retry, including invalid output.


def group(end, **changes):
    return {'title':'Saved discussion','summary':'The user discussed the supplied points.',
            'topicSuggestions':[], 'continuesActive':False,'ongoing':False,'endUnit':end,**changes}


def thought(texts=('One. Two. Three.',), **changes):
    return ThoughtInput(sessionId='s',incremental=True,finalize=False,segments=[
        dict(id=f's{i}',turnId=f't{i}',revision=3,speaker='user',text=text,final=True,createdAt='now')
        for i,text in enumerate(texts)],**changes)


async def organize(item, output, captures=None):
    settings=Settings(nebius_api_key='fixture',thought_organization_format='compact')
    captures=captures if captures is not None else []
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        captures.append(json.loads(request.content))
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[
            {'finish_reason':'stop','message':{'content':json.dumps(output)}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        return await NebiusProvider(Gateway(settings,client)).consolidate(item)


@pytest.mark.parametrize('groups', [
    [], [group(-1)], [group(3)], [group(True)], [group('2')], [group(2.0)],
    [group(1),group(1)], [group(2),group(0)],
    [group(0,ongoing=True),group(2)], [group(2,continuesActive=True)],
    [group(2,title=' \n')], [group(2,summary='\t ')],
])
async def test_compact_ranges_reject_invalid_or_nonprogressing_results_without_retry(groups):
    captures=[]
    with pytest.raises(ServiceError,match='Invalid thought'):
        await organize(thought(),{'groups':groups},captures)
    assert len(captures)==1


async def test_compact_result_keeps_implicit_suffix_and_public_shape():
    result=await organize(thought(),{'groups':[group(0,ongoing=True)]})
    assert result.groups[0].spans[0].model_dump()=={'segmentId':'s0','revision':3,'start':0,'end':5}
    assert [(s.start,s.end) for s in result.remainder]==[(5,10),(10,16)]
    public=result.model_dump()
    assert 'endUnit' not in public['groups'][0]
    assert set(public)=={'groups','remainder'}


async def test_finalization_requires_all_units_and_never_accepts_an_implicit_suffix():
    item=thought().model_copy(update={'finalize':True})
    for groups in [[],[group(0)]]:
        with pytest.raises(ServiceError,match='Invalid thought'):
            await organize(item,{'groups':groups})
    result=await organize(item,{'groups':[group(0),group(2)]})
    assert len(result.groups)==2 and result.remainder==[]


async def test_legacy_unfinished_source_can_remain_without_a_group():
    result=await organize(thought().model_copy(update={'incremental':False}),{'groups':[]})
    assert result.groups==[] and len(result.remainder)==3


@pytest.mark.parametrize('wire_format', ['units', 'compact'])
async def test_every_whitespace_and_unicode_character_round_trips_through_ranges(wire_format):
    texts=['\n\t 🦵 stretches! \r\n.. \t',' \t ','e\u0301 👩‍🔬?\n終わり','']
    captures=[]
    settings=Settings(nebius_api_key='fixture',thought_organization_format=wire_format)
    def upstream(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        body=json.loads(request.content);captures.append(body)
        units=json.loads(body['messages'][1]['content'])['units']
        assert ''.join(u['text'] for u in units)==''.join(texts)
        response={'groups':[group(len(units)-1)]}
        if wire_format=='units':
            response['groups'][0].pop('endUnit')
            response['groups'][0]['unitIds']=[unit['id'] for unit in units]
            response['remainder']=[]
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[{
            'finish_reason':'stop','message':{'content':json.dumps(response)}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        result=await NebiusProvider(Gateway(settings,client)).consolidate(thought(texts).model_copy(update={'finalize':True}))
    for i,text in enumerate(texts):
        spans=[s for s in result.groups[0].spans if s.segmentId==f's{i}']
        encoded=text.encode('utf-16-le');cursor=0;rebuilt=''
        for span in spans:
            assert span.start==cursor
            rebuilt+=encoded[span.start*2:span.end*2].decode('utf-16-le');cursor=span.end
        assert cursor==len(encoded)//2 and rebuilt==text
    assert len(captures)==1


async def test_whitespace_only_source_fails_before_paid_dispatch():
    captures=[]
    with pytest.raises(ServiceError,match='source'):
        await organize(thought(['\n\t ']),{'groups':[]},captures)
    assert captures==[]


def test_invalid_unicode_is_rejected_by_the_public_input_schema():
    with pytest.raises(ValidationError,match='unicode'):
        thought(['bad \ud800 text'])


async def test_duplicate_source_identity_is_rejected_before_paid_dispatch():
    item=thought(['First.','Second.']);item.segments[1].id=item.segments[0].id
    captures=[]
    with pytest.raises(ServiceError,match='Duplicate'):
        await organize(item,{'groups':[group(1)]},captures)
    assert captures==[]


async def test_incremental_group_count_is_enforced_after_provider_output():
    with pytest.raises(ServiceError,match='Invalid thought'):
        await organize(thought(['One. Two. Three. Four. Five. Six. Seven.']),{'groups':[group(i) for i in range(7)]})


async def test_full_request_bound_includes_context_and_schema_and_preserves_unicode():
    captures=[]
    with pytest.raises(ServiceError,match='32,000-byte limit') as error:
        await organize(thought(['A useful source.'],context='界'*12000),{'groups':[group(0)]},captures)
    assert error.value.status==413
    assert captures==[]


@pytest.mark.parametrize('limit_delta',[0,-1])
async def test_request_byte_boundary_uses_the_actual_complete_wire_payload(limit_delta):
    settings=Settings(nebius_api_key='fixture',thought_organization_format='compact');seen=[]
    messages=[{'role':'user','content':'Keep this 🦵 quantity: 12 mL.'}]
    format={'type':'json_schema','json_schema':{'name':'fixture','schema':{'type':'object','properties':{'title':{'type':'string'}}},'strict':True}}
    expected={'model':settings.summary_model,'messages':messages,'max_completion_tokens':4096,
              'store':False,'temperature':0.2,'stream':False,'response_format':format}
    size=len(json.dumps(expected,ensure_ascii=False,separators=(',',':'),allow_nan=False).encode('utf-8'))
    def upstream(request):
        seen.append(request)
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
        assert len(request.content)==size and json.loads(request.content)==expected
        return httpx.Response(200,json={'model':settings.summary_model,'choices':[{'finish_reason':'stop','message':{'content':'{}'}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
        provider=NebiusProvider(Gateway(settings,client))
        if limit_delta<0:
            with pytest.raises(ServiceError,match='byte limit'):
                await provider.completion(settings.summary_model,messages,4096,max_request_bytes=size-1,response_format=format)
            assert seen==[]
        else:
            await provider.completion(settings.summary_model,messages,4096,max_request_bytes=size,response_format=format)
            assert len(seen)==2


async def test_organization_output_limit_and_network_failure_are_not_retried():
    settings=Settings(nebius_api_key='fixture',thought_organization_format='compact')
    for failure in ['length','network']:
        calls=[]
        def upstream(request):
            if request.method=='GET':return httpx.Response(200,json={'data':[{'id':settings.summary_model}]})
            calls.append(request)
            if failure=='network':raise httpx.ReadTimeout('fixture',request=request)
            return httpx.Response(200,json={'model':settings.summary_model,'choices':[{'finish_reason':'length','message':{'content':''}}]})
        async with httpx.AsyncClient(transport=httpx.MockTransport(upstream)) as client:
            with pytest.raises(ServiceError):
                await NebiusProvider(Gateway(settings,client)).consolidate(thought())
        assert len(calls)==1
