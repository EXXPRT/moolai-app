"""Pinned Nanobot loop. All model/tool operations are RPCs to the Moolai parent."""
import asyncio
import importlib.metadata
import json
import sys
from loguru import logger
from nanobot.agent.runner import AgentRunner, AgentRunSpec
from nanobot.agent.tools.base import Tool
from nanobot.agent.tools.registry import ToolRegistry
from nanobot.providers.base import LLMProvider, LLMResponse, ToolCallRequest
from nanobot.utils.llm_runtime import GenerationSettings, LLMRuntime

logger.remove()
if importlib.metadata.version('nanobot-ai') != '0.3.5':
    raise RuntimeError('Expected pinned nanobot-ai 0.3.5')
sequence = 0

def emit(value):
    print(json.dumps(value, ensure_ascii=False), flush=True)

async def rpc(kind, **data):
    global sequence
    sequence += 1
    emit({'id': sequence, 'kind': kind, **data})
    line = await asyncio.to_thread(sys.stdin.readline)
    if not line or len(line.encode()) > 2_000_000:
        raise RuntimeError('Parent RPC closed or oversized')
    reply = json.loads(line)
    if reply.get('id') != sequence or 'error' in reply:
        raise RuntimeError(reply.get('error', 'Parent RPC mismatch'))
    return reply['result']

class ParentProvider(LLMProvider):
    def __init__(self):
        super().__init__(provider_name='moolai-metered-parent')
    def get_default_model(self):
        return 'parent-selected-model'
    async def chat_with_retry(self, messages, **kwargs):
        return await self.chat(messages, **kwargs)
    async def chat(self, messages, **kwargs):
        result = await rpc('generate', messages=messages)
        if not result.get('text', '').strip() and not result.get('toolCalls'):
            raise RuntimeError('Empty model response; no automatic recovery')
        return LLMResponse(result.get('text', ''), [ToolCallRequest(c['id'], c['name'], c['arguments'])
                           for c in result.get('toolCalls', [])])

class ParentTool(Tool):
    def __init__(self, definition):
        self.definition = definition
    @property
    def name(self):
        return self.definition['name']
    @property
    def description(self):
        return self.definition['description']
    @property
    def parameters(self):
        # Shared Moolai validation is authoritative; do not add SDK argument coercion.
        # Model-visible definitions still come from the parent's guarded frame.
        return {'type': 'object', 'additionalProperties': True}
    async def execute(self, **arguments):
        return json.dumps(await rpc('execute', name=self.name, arguments=arguments), ensure_ascii=False)

async def main():
    initial = json.loads(sys.stdin.readline())
    registry = ToolRegistry()
    for definition in initial['tools']:
        if definition['name'] not in ('search_notes', 'read_note'):
            raise RuntimeError('Tool outside notes allowlist')
        registry.register(ParentTool(definition))
    runtime = LLMRuntime(ParentProvider(), 'parent-selected-model',
                         GenerationSettings(temperature=0.2, max_tokens=4000), 32768)
    result = await AgentRunner().run(AgentRunSpec(
        initial_messages=initial['messages'], tools=registry, runtime=runtime,
        max_iterations=initial['maxSteps'], max_tool_result_chars=12000,
        concurrent_tools=False, finalize_on_max_iterations=False,
        consolidate_history=None, consolidate_provider_compaction=None))
    emit({'kind': 'done', 'answer': result.final_content, 'error': result.error,
          'stopReason': result.stop_reason, 'messages': result.messages})

if __name__ == '__main__':
    try:
        asyncio.run(main())
    except Exception as error:
        emit({'kind': 'failed', 'error': str(error)})
        raise SystemExit(1)
