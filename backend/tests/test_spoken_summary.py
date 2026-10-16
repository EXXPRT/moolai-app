"""One paid response carries independent written, summary and walkthrough output."""
import copy
import json
from dataclasses import replace

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.prompts import instruction
from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings


ANSWER = {
    'text': '## Results\nThe corrected quantity is 12 mg.\n\n## Limits\nIt remains a proposal, with >90% estimated coverage.',
    'spokenText': 'The corrected quantity is 12 milligrams. It remains a proposal, with estimated coverage above 90 percent.',
    'spokenOutline': None, 'references': None, 'understoodRequest': None,
}


async def invoke(answer, mode='auto', settings=None, messages=None, tools=None):
    requests = []
    settings = settings or Settings(nebius_api_key='fixture')
    def respond(request):
        requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        message = {'content': json.dumps(answer)} if mode == 'answer_only' else {'tool_calls': [{
            'id': 'answer', 'type': 'function', 'function': {'name': 'deliver_answer', 'arguments': json.dumps(answer)}}]}
        return httpx.Response(200, json={'model': settings.agent_model, 'choices': [{
            'finish_reason': 'stop' if mode == 'answer_only' else 'tool_calls', 'message': message}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(settings, client)).respond(RespondInput(
            messages=messages or [{'role': 'user', 'content': 'Explain the corrected quantity and limits.'}],
            tools=tools or [], responseMode=mode))
    return result, requests


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
@pytest.mark.parametrize('outline', [None, {'overview': 'Wrong fields', 'points': []}, '{unfinished'])
async def test_summary_does_not_depend_on_optional_walkthrough(mode, outline):
    answer = {**ANSWER, 'spokenOutline': outline}
    result, requests = await invoke(answer, mode)
    assert result.text == ANSWER['text'] and result.spokenText == ANSWER['spokenText']
    assert result.toolCalls == [] and result.controlProposal is None
    assert result.spokenOutline is None
    assert bool(result.narrationError) == (outline is not None)
    assert [request.method for request in requests] == ['GET', 'POST']
    payload = json.loads(requests[-1].content)
    schema = (payload['response_format']['json_schema']['schema'] if mode == 'answer_only' else
              next(tool['function']['parameters'] for tool in payload['tools'] if tool['function']['name'] == 'deliver_answer'))
    assert schema['properties']['spokenText']['type'] == 'string'
    assert schema['properties']['spokenText']['minLength'] == 1
    assert schema['properties']['spokenText']['maxLength'] == 1200
    assert 'spokenText' in schema['required']


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
@pytest.mark.parametrize('summary', [None, '', ' \n\t', 42, 'x' * 1201])
async def test_missing_summary_retains_complete_answer_without_retry(mode, summary):
    result, requests = await invoke({**ANSWER, 'spokenText': summary}, mode)
    assert result.text == ANSWER['text'] and result.spokenText is None
    assert result.narrationError == 'A spoken summary was not available. The written answer is saved.'
    assert len(requests) == 2


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_loaded_phase_policy_preserves_host_constraints_and_exact_source(mode):
    original = [{'role': 'system', 'content': 'Use only my notes; preserve the two-sentence constraint.'},
                {'role': 'tool', 'content': '{"status":"failed","query":"pressure","detail":"漢 🌱"}', 'toolCallId': 'read-1'},
                {'role': 'user', 'content': 'No, use the corrected 12 mg, not 16 mg.'}]
    before = copy.deepcopy(original)
    _, requests = await invoke(ANSWER, mode, messages=original)
    payload = json.loads(requests[-1].content)
    assert original == before
    assert [message['content'] for message in payload['messages'][1:]] == [message['content'] for message in original]
    policy = payload['messages'][0]['content']
    assert ('final-answer phase' if mode == 'answer_only' else 'during retrieval') in policy
    assert 'spokenText' in policy and 'import/update' in policy
    # Verify the live wire loads the revised resource, not just a file on disk.
    resource = 'agent-final-v3' if mode == 'answer_only' else 'agent-retrieval-v3'
    assert instruction(resource) in policy
    assert instruction(resource.replace('-v3', '-v2')) not in policy
    assert 'Compress background rather than weakening a caveat' in policy
    assert 'For each requested theme, state its concrete behavior and material scope' in policy
    if mode == 'answer_only':
        assert 'tools' not in payload and payload['tool_choice'] == 'none'


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_complete_wire_bound_counts_generated_schema_and_utf8_before_any_network(mode):
    settings = Settings(nebius_api_key='fixture')
    messages = [{'role': 'user', 'content': 'Preserve Unicode 漢 🌱 and exactly 12 mg.'}]
    _, requests = await invoke(ANSWER, mode, settings=settings, messages=messages)
    exact = len(requests[-1].content)
    assert exact > len(json.dumps(messages).encode('utf-8'))
    calls = []
    async with httpx.AsyncClient(transport=httpx.MockTransport(lambda request: calls.append(request))) as client:
        with pytest.raises(ServiceError, match='byte limit'):
            await NebiusProvider(Gateway(replace(settings, agent_max_request_bytes=exact - 1), client)).respond(
                RespondInput(messages=messages, tools=[], responseMode=mode))
    assert calls == []
    # Exactly the encoded boundary passes, not a character approximation.
    _, requests = await invoke(ANSWER, mode, settings=replace(settings, agent_max_request_bytes=exact), messages=messages)
    assert len(requests[-1].content) == exact


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_missing_summary_uses_entire_short_limitation_without_paid_retry(mode):
    text = ('I could not validate the requested reading. That does not establish that it is absent.\n\n'
            'The earlier measurement was 24 kilopascals, but the current image is unreadable; '
            'I cannot report the earlier number as a current measurement.')
    result, requests = await invoke({**ANSWER, 'text': text, 'spokenText': None}, mode)
    assert result.spokenText == text and result.text == text
    assert result.narrationError is None
    assert [request.method for request in requests] == ['GET', 'POST']


@pytest.mark.parametrize('text', [
    'A limitation. ' * 121,
    '## Reading\nNot available.',
    '1. Current value unknown.\n2. Previous value was 24 kPa.',
    '| Value | Status |\n| --- | --- |\n| 24 | historical |',
    'The source is [the note](https://example.test/note).',
])
async def test_missing_summary_never_clips_long_or_structured_answer(text):
    result, requests = await invoke({**ANSWER, 'text': text, 'spokenText': None})
    assert result.text == text and result.spokenText is None and result.narrationError
    assert len(requests) == 2
