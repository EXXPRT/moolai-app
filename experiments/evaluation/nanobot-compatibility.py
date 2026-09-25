"""Run the pinned Nanobot loop against a fake, bounded provider. No real model or task.

This qualifies selected runner mechanics; it is NOT an answer-quality benchmark or
an integrated Moolai ResponseRunner adapter. The injected provider owns zero retries.
"""
import asyncio
import copy
import importlib.metadata
import json
import sys
from pathlib import Path
from loguru import logger
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.utils.llm_runtime import GenerationSettings, LLMRuntime

logger.remove()
assert importlib.metadata.version('nanobot-ai') == '0.3.5'

class FixtureProvider(LLMProvider):
    def __init__(self, replies, limit=6):
        super().__init__(provider_name="moolai-fixture")
        self.replies, self.limit, self.requests = replies, limit, []

    def get_default_model(self):
        return 'fixture-only'

    async def chat(self, messages, **kwargs):
        if len(self.requests) >= self.limit:
            raise RuntimeError('Fixture transport call budget exhausted')
        self.requests.append({'messages':copy.deepcopy(messages), 'tools':copy.deepcopy(kwargs.get('tools'))})
        index=len(self.requests)-1
        reply=self.replies[min(index,len(self.replies)-1)]
        if isinstance(reply, Exception):
            raise reply
        return copy.deepcopy(reply)

    async def chat_with_retry(self, messages, **kwargs):
        # Production comparison must inject its metered transport here as well.
        # Nanobot's standard retry wrapper is not used in this configured profile.
        return await self.chat(messages, **kwargs)

class ReadNote(Tool):
    name='read_note'
    description='Read one synthetic fixture note.'
    parameters={'type':'object','properties':{'id':{'type':'string'}},'required':['id'],'additionalProperties':False}
    def __init__(self, events):
        self.events=events
    async def execute(self, id):
        self.events.append({'name':self.name,'id':id,'simulated':True})
        return json.dumps({'status':'success','id':id,'revision':2,'marker':73})

async def run(replies, limit=6):
    provider=FixtureProvider(replies,limit)
    registry=ToolRegistry()
    events=[]
    registry.register(ReadNote(events))
    runtime=LLMRuntime(provider,'fixture-only',GenerationSettings(temperature=0.2,max_tokens=4000),32768)
    spec=AgentRunSpec(initial_messages=[{'role':'user','content':'Read fixture-note and report its marker. Use only my notes.'}],
        tools=registry,runtime=runtime,max_iterations=limit,max_tool_result_chars=12000,
        concurrent_tools=False,finalize_on_max_iterations=False,
        consolidate_history=None,consolidate_provider_compaction=None)
    try:
        result=await AgentRunner().run(spec)
        return {'stopReason':result.stop_reason,'answer':result.final_content,'error':result.error,
                'requests':provider.requests,'toolEvents':events}
    except Exception as error:
        return {'stopReason':'exception','error':str(error),'requests':provider.requests,'toolEvents':events}

async def main():
    traces={}
    traces['tool_answer']=await run([LLMResponse(None,[ToolCallRequest('r1','read_note',{'id':'fixture-note'})]),LLMResponse('73')])
    traces['forbidden_tool']=await run([LLMResponse(None,[ToolCallRequest('r1','shell',{'command':'do not execute'})]),LLMResponse('Unavailable tool.')])
    traces['provider_failure']=await run([RuntimeError('Injected provider failure')])
    traces['call_limit']=await run([LLMResponse(None,[ToolCallRequest('r1','read_note',{'id':'fixture-note'})])],2)
    traces['empty_answer']=await run([LLMResponse('')],2)
    checks={
        'actual_pinned_loop':True,
        'read_then_answer':traces['tool_answer'].get('answer')=='73' and len(traces['tool_answer']['requests'])==2,
        'only_brain_tool_advertised':all([t['function']['name'] for t in r['tools']]==['read_note'] for row in traces.values() for r in row['requests']),
        'unknown_shell_not_executed':traces['forbidden_tool']['toolEvents']==[],
        'provider_failure_not_retried':len(traces['provider_failure']['requests'])==1,
        'no_extra_finalization_call':len(traces['call_limit']['requests'])==2,
    }
    report={'version':1,'candidate':'nanobot-ai==0.3.5','mode':'fixture-provider compatibility only',
        'paidCalls':0,'realTasks':0,'checks':checks,'passed':all(checks.values()),
        'findings':{'emptyAnswerRequests':len(traces['empty_answer']['requests']),
            'emptyAnswerRecoveryNeedsGuard':len(traces['empty_answer']['requests'])>1},
        'limits':['No Moolai BrainPort/controller integration yet.','Provider retry wrapper is overridden by the injected no-retry transport.',
                  'Empty-answer recovery remains an SDK behavior to guard before paid comparison.',
                  'No live model quality or model/harness ranking is established.'], 'traces':traces}
    if len(sys.argv)>1:
        output=Path(sys.argv[1]);output.parent.mkdir(parents=True,exist_ok=True)
        with output.open('x') as f:json.dump(report,f,indent=2);f.write('\n')
    print(json.dumps({k:v for k,v in report.items() if k!='traces'},indent=2))
    if not report['passed']:raise SystemExit(1)

if __name__=='__main__':asyncio.run(main())
