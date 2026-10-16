import json
import httpx
import pytest
from moolai_backend.providers import Gateway,JevProvider,NebiusProvider,ServiceError
from moolai_backend.schemas import RespondInput,RouteInput
from moolai_backend.settings import Settings
SETTINGS=Settings(typesafe_api_key='fixture',nebius_api_key='fixture')

async def test_closing_question_is_explicit_state_with_scoped_choices():
    def respond(request):
        body=json.loads(request.content);state=json.loads(body['state'])
        assert state['pendingOffer']['question']=='Shall I close this conversation?'
        assert set(body['questions']['route']['criteria'])=={'end_agent','continue_agent','check_status','suppress_note','no_action','unclear'}
        assert 'plain affirmative' in body['questions']['route']['criteria']['end_agent']
        return httpx.Response(200,json={'model':SETTINGS.jev_model,'answers':{
            'route':{'type':'choice','choice':'end_agent','confidence':.91,'probabilities':{'end_agent':.91,'continue_agent':.03,'check_status':0,'suppress_note':0,'no_action':.03,'unclear':.03}},
            'substantive_content':{'type':'noul','noul':0}}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result=await JevProvider(Gateway(SETTINGS,client)).route(RouteInput(text='Yes.',recentContext='assistant: Shall I close this conversation?',activeConversation=True,
            pendingOffer={'kind':'close','conversationId':'c','sessionId':'s','turnId':'t','revisionKey':'t:1','question':'Shall I close this conversation?'}))
        assert result.route=='end_agent' and result.confidence==.91

@pytest.mark.parametrize('mode,text,task,valid',[('contextual','Answer.',False,True),('current','Answer.',False,False),('contextual','',False,False),('contextual','Answer.',True,False),('answer_only','Answer.',False,False)])
async def test_offer_is_separate_bounded_control(mode,text,task,valid):
    def respond(request):
        if request.method=='GET':return httpx.Response(200,json={'data':[{'id':SETTINGS.agent_model}]})
        body=json.loads(request.content)
        names=[t['function']['name'] for t in body.get('tools',[])]
        assert ('offer_conversation_close' in names)==(mode=='contextual')
        if mode=='answer_only':assert body['tool_choice']=='none' and 'tools' not in body
        calls=[{'id':'one','type':'function','function':{'name':'offer_conversation_close','arguments':'{"reason":"answered"}'}}]
        if task:calls.append({'id':'two','type':'function','function':{'name':'search_notes','arguments':'{"query":"notes"}'}})
        return httpx.Response(200,json={'model':SETTINGS.agent_model,'choices':[{'finish_reason':'tool_calls','message':{'content':text,'tool_calls':calls}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider=NebiusProvider(Gateway(SETTINGS,client))
        item=RespondInput(messages=[{'role':'user','content':'Explain this.'}],tools=[{'name':'search_notes','description':'Search notes','parameters':{}}],
            closingMode='current' if mode=='current' else 'contextual',responseMode='answer_only' if mode=='answer_only' else 'auto')
        if valid:
            result=await provider.respond(item);assert result.controlProposal.action=='offer_close' and not result.toolCalls
        else:
            with pytest.raises(ServiceError):await provider.respond(item)
