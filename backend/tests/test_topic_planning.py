import json
import httpx
import pytest
from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings

def source(**kw):
    return ThoughtInput(sessionId='s', incremental=True, finalize=kw.pop('finalize',False),
        segments=[{'id':'a','turnId':'a','revision':1,'speaker':'user','text':'First 🦵. Second. ',
                   'final':True,'createdAt':'2026-10-08T00:00:00Z'}],**kw)

async def invoke(answer, item=None):
    bodies=[]
    def transport(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':'nvidia/Nemotron-3_5-Lightning'}]})
        body=json.loads(request.content);bodies.append(body)
        return httpx.Response(200,json={'model':body['model'],'choices':[{'finish_reason':'stop','message':{'content':json.dumps(answer)}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        p=NebiusProvider(Gateway(Settings(nebius_api_key='fixture'),client))
        return await p.plan_thoughts(item or source()),bodies

async def test_plan_exact_unicode_boundaries_and_default_reasoning():
    result,bodies=await invoke({'endUnits':[0,1],'extendsActive':False,'ongoing':True})
    assert [g.spans[0].model_dump() for g in result.groups]==[
        {'segmentId':'a','revision':1,'start':0,'end':10},
        {'segmentId':'a','revision':1,'start':10,'end':18}]
    assert result.remainder==[] and result.ongoing
    assert bodies[0]['max_completion_tokens']==4096
    assert 'chat_template_kwargs' not in bodies[0]
    assert len(httpx.Request('POST','https://example.invalid',json=bodies[0]).content)<=32000

@pytest.mark.parametrize('answer',[
    {'endUnits':[1,0],'extendsActive':False,'ongoing':False},
    {'endUnits':[0,0],'extendsActive':False,'ongoing':False},
    {'endUnits':[2],'extendsActive':False,'ongoing':False},
    {'endUnits':[1],'extendsActive':True,'ongoing':False},
    {'endUnits':[],'extendsActive':False,'ongoing':False},
    {'endUnits':[True],'extendsActive':False,'ongoing':False},
])
async def test_invalid_plan_is_rejected_without_retry(answer):
    with pytest.raises(ServiceError):await invoke(answer)

async def test_suffix_stays_pending_unless_final():
    result,_=await invoke({'endUnits':[0],'extendsActive':False,'ongoing':True})
    assert result.remainder[0].start==10
    with pytest.raises(ServiceError):await invoke({'endUnits':[0],'extendsActive':False,'ongoing':False},source(finalize=True))

async def test_complete_request_bound_blocks_dispatch():
    calls=[]
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda r:calls.append(r))) as client:
        provider=NebiusProvider(Gateway(Settings(nebius_api_key='fixture'),client))
        with pytest.raises(ServiceError):await provider.plan_thoughts(source(context='🦵'*9000))
    assert calls==[]
