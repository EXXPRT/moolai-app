"""Presentation is part of the existing response, never an executable task."""
import copy
import json
from dataclasses import replace

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings


SETTINGS = Settings(nebius_api_key='fixture-secret')
ANSWER = {
    'text': '## Evidence\nTwo notes support the claim.\n\n## Limits\nThe estimate is >90%, not a guarantee.',
    'spokenOutline': {'overview': 'Here are the evidence and its limits.', 'points': [
        {'label': 'Evidence', 'explanation': 'Two notes support the claim.', 'sourceSections': [1]},
        {'label': 'Limits', 'explanation': 'The estimate is over 90 percent, not a guarantee.', 'sourceSections': [2]},
    ]},
    'spokenText': 'Two notes support the claim; the estimate is over 90 percent, not a guarantee.',
    'references': [{'recordId': 'evidence-note', 'title': 'Evidence and limitations'}],
}


def call(name='deliver_answer', arguments=None, call_id='delivery'):
    return {'id': call_id, 'type': 'function', 'function': {
        'name': name, 'arguments': json.dumps(ANSWER if arguments is None else arguments)}}


def provider_transport(message, requests):
    def respond(request):
        requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        return httpx.Response(200, json={'model': SETTINGS.agent_model, 'choices': [{
            'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop', 'message': message}]})
    return httpx.MockTransport(respond)


async def run(message, requests, mode='auto', tools=None):
    async with httpx.AsyncClient(transport=provider_transport(message, requests)) as client:
        return await NebiusProvider(Gateway(SETTINGS, client)).respond(RespondInput(
            messages=[{'role': 'user', 'content': 'Explain the evidence and limitations.'}],
            tools=tools or [], responseMode=mode))


async def test_delivery_keeps_every_section_in_one_call_without_executable_tools():
    requests = []
    result = await run({'content': None, 'tool_calls': [call()]}, requests)
    assert result.text == ANSWER['text']
    assert result.spokenOutline.model_dump() == ANSWER['spokenOutline']
    assert result.references[0].title == 'Evidence and limitations'
    assert result.toolCalls == [] and result.controlProposal is None
    assert [request.method for request in requests] == ['GET', 'POST']
    payload = json.loads(requests[-1].content)
    assert 'response_format' not in payload
    assert payload['max_completion_tokens'] == 2400 and payload['model'] == SETTINGS.agent_model
    delivery = next(item['function'] for item in payload['tools'] if item['function']['name'] == 'deliver_answer')
    schema = delivery['parameters']
    assert set(schema['required']) == {'text', 'spokenOutline', 'spokenText', 'references', 'understoodRequest'}
    assert 'sourceSections' in schema['$defs']['_DeliveredSpokenPoint']['required']
    assert 'not a task' in delivery['description']


@pytest.mark.parametrize('name,arguments', [
    ('search_notes', '{"query":"current pressure","query":"unrelated reading"}'),
    ('propose_end_conversation', '{"reason":"continue","reason":"finished"}'),
])
async def test_duplicate_task_or_control_arguments_are_rejected_without_retry(name, arguments):
    requests = []
    proposal = {'id': 'ambiguous', 'type': 'function', 'function': {'name': name, 'arguments': arguments}}
    tools = [{'name': 'search_notes', 'description': 'Search notes', 'parameters': {'type': 'object'}}]
    with pytest.raises(ServiceError, match='invalid text or tool calls'):
        await run({'tool_calls': [proposal]}, requests, tools=tools)
    assert [request.method for request in requests] == ['GET', 'POST']


@pytest.mark.parametrize('other', ['brain_search', 'propose_end_conversation', 'offer_conversation_close', 'deliver_answer'])
async def test_delivery_cannot_be_mixed_with_tasks_controls_or_another_answer(other):
    requests = []
    with pytest.raises(ServiceError, match='invalid text or tool calls'):
        await run({'tool_calls': [call(), call(other, {'query': 'evidence'}, 'other')]}, requests,
                  tools=[{'name': 'brain_search', 'description': 'Search notes.', 'parameters': {}}])
    assert [request.method for request in requests] == ['GET', 'POST']


@pytest.mark.parametrize('change', ['missing_outline', 'missing_sections', 'empty_text', 'empty_explanation', 'blank_explanation', 'duplicate_sections', 'extra_action'])
async def test_invalid_delivery_does_not_turn_into_a_tool_or_retry(change, caplog):
    answer = copy.deepcopy(ANSWER)
    if change == 'missing_outline':
        del answer['spokenOutline']
    elif change == 'missing_sections':
        del answer['spokenOutline']['points'][0]['sourceSections']
    elif change == 'empty_text':
        answer['text'] = '   '
    elif change == 'empty_explanation':
        answer['spokenOutline']['points'][0]['explanation'] = ''
    elif change == 'blank_explanation':
        answer['spokenOutline']['points'][0]['explanation'] = '   '
    elif change == 'duplicate_sections':
        answer['spokenOutline']['points'][0]['sourceSections'] = [1, 1]
    elif change == 'extra_action':
        answer['toolCalls'] = [{'name': 'delete'}]
    requests = []
    if change in ('empty_text', 'extra_action'):
        with pytest.raises(ServiceError):
            await run({'tool_calls': [call(arguments=answer)]}, requests)
        assert 'invalid_response_envelope' in caplog.text
    else:
        reply = await run({'tool_calls': [call(arguments=answer)]}, requests)
        assert reply.text == ANSWER['text'] and reply.spokenText == ANSWER['spokenText']
        assert reply.spokenOutline is None and reply.toolCalls == []
        assert bool(reply.narrationError) == (change != 'missing_outline')
    assert [request.method for request in requests] == ['GET', 'POST']
    assert 'Two notes support' not in caplog.text and 'fixture-secret' not in caplog.text


async def test_competing_text_is_not_silently_selected_over_delivered_answer():
    with pytest.raises(ServiceError):
        await run({'content': 'Another answer.', 'tool_calls': [call()]}, [])


async def test_final_mode_has_schema_and_no_task_presentation_or_control_tools():
    requests = []
    result = await run({'content': json.dumps(ANSWER)}, requests, mode='answer_only',
                      tools=[{'name': 'brain_search', 'description': 'Search.', 'parameters': {}}])
    payload = json.loads(requests[-1].content)
    assert payload['tool_choice'] == 'none' and 'tools' not in payload
    structured = payload['response_format']
    assert structured['type'] == 'json_schema' and structured['json_schema']['strict'] is True
    assert structured['json_schema']['name'] == 'delivered_answer'
    assert set(structured['json_schema']['schema']['required']) == {'text', 'spokenOutline', 'spokenText', 'references', 'understoodRequest'}
    assert result.spokenOutline.points[-1].sourceSections == [2]
    assert len(requests) == 2 and not result.toolCalls and result.controlProposal is None


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_presentation_wire_omits_nonblank_regex_without_weakening_other_bounds(mode):
    requests = []
    message = ({'content': json.dumps(ANSWER)} if mode == 'answer_only'
               else {'tool_calls': [call()]})
    task_parameters = {'type': 'object', 'properties': {
        'query': {'type': 'string', 'pattern': r'\S'},
        'identifier': {'type': 'string', 'pattern': r'^[a-z0-9-]+$'},
    }, 'required': ['query', 'identifier'], 'additionalProperties': False}
    await run(message, requests, mode=mode, tools=[{
        'name': 'brain_search', 'description': 'Search notes.', 'parameters': task_parameters}])
    payload = json.loads(requests[-1].content)
    if mode == 'answer_only':
        schema = payload['response_format']['json_schema']['schema']
        assert payload['response_format']['json_schema']['strict'] is True
        assert 'tools' not in payload and payload['tool_choice'] == 'none'
    else:
        tools = {tool['function']['name']: tool['function'] for tool in payload['tools']}
        schema = tools['deliver_answer']['parameters']
        # The adjustment is presentation-only, not a general schema sanitizer.
        assert tools['brain_search']['parameters'] == task_parameters

    def assert_no_pattern(value):
        if isinstance(value, dict):
            assert 'pattern' not in value
            for child in value.values():
                assert_no_pattern(child)
        elif isinstance(value, list):
            for child in value:
                assert_no_pattern(child)

    assert_no_pattern(schema)
    assert schema['additionalProperties'] is False
    assert set(schema['required']) == set(schema['properties'])
    assert schema['properties']['text']['minLength'] == 1
    assert schema['properties']['text']['maxLength'] == 32_000
    point = schema['$defs']['_DeliveredSpokenPoint']
    assert set(point['required']) == {'label', 'explanation', 'sourceSections'}
    assert point['properties']['explanation']['maxLength'] == 1200
    assert point['properties']['sourceSections']['items']['minimum'] == 1
    assert point['additionalProperties'] is False


@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_multiline_presentation_preserves_full_raw_fields_after_wire_adjustment(mode):
    answer = copy.deepcopy(ANSWER)
    answer['text'] = ('## Evidence\n' +
        'Both source notes support this quantity: 12.5 mg, not 125 mg.\n' * 100 +
        '\n## Limits\nThe estimate is >90%, not a guarantee. 中文 🌱\n')
    answer['spokenOutline']['overview'] = 'Evidence and limitations, with the corrected quantity.'
    answer['spokenOutline']['points'][0]['explanation'] = 'Two notes support 12.5 milligrams.\nThe earlier 125 was corrected.'
    answer['understoodRequest'] = 'Use the current corrected notes, keeping both evidence and limitations.'
    # The strict-JSON and tool-arguments routes both see the original complete
    # provider envelope, not an independently reconstructed shorter answer.
    raw = json.dumps(answer, ensure_ascii=False)
    message = ({'content': raw} if mode == 'answer_only' else {'tool_calls': [{
        'id': 'delivery', 'type': 'function', 'function': {
            'name': 'deliver_answer', 'arguments': raw}}]})
    requests = []
    result = await run(message, requests, mode=mode)
    assert result.model_dump(exclude={'toolCalls', 'controlProposal', 'narrationError'}) == answer
    assert result.toolCalls == [] and result.controlProposal is None
    assert [request.method for request in requests] == ['GET', 'POST']


@pytest.mark.parametrize('field', ['text', 'overview', 'label', 'explanation', 'understoodRequest'])
@pytest.mark.parametrize('blank', [' \t\r\n', '\u2003\u00a0'])
@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_presentation_nonblank_validation_remains_local_and_never_retries(field, blank, mode):
    answer = copy.deepcopy(ANSWER)
    if field in ('text', 'understoodRequest'):
        answer[field] = blank
    elif field == 'overview':
        answer['spokenOutline'][field] = blank
    else:
        answer['spokenOutline']['points'][0][field] = blank
    message = ({'content': json.dumps(answer)} if mode == 'answer_only'
               else {'tool_calls': [call(arguments=answer)]})
    requests = []
    if field in ('text', 'understoodRequest'):
        with pytest.raises(ServiceError, match='invalid text or tool calls'):
            await run(message, requests, mode=mode)
    else:
        result = await run(message, requests, mode=mode)
        assert result.text == ANSWER['text'] and result.spokenText == ANSWER['spokenText']
        assert result.spokenOutline is None and result.narrationError
    assert [request.method for request in requests] == ['GET', 'POST']


async def test_clients_cannot_override_presentation_tool_before_network():
    requests = []
    with pytest.raises(ServiceError, match='reserved'):
        await run({}, requests, tools=[{'name': 'deliver_answer', 'description': 'Spoof.', 'parameters': {}}])
    assert requests == []


async def test_legacy_answer_stays_readable_and_has_content_free_narration_diagnostic(caplog):
    caplog.set_level('INFO', logger='moolai_backend.providers')
    requests = []
    result = await run({'content': 'Older supported response.'}, requests)
    assert result.text == 'Older supported response.' and result.spokenOutline is None
    assert result.spokenText == result.text and result.narrationError is None
    assert 'complete_short_prose' in caplog.text
    assert 'Older supported response.' not in caplog.text and 'fixture-secret' not in caplog.text
    assert len(requests) == 2


@pytest.mark.parametrize('mode', ['tool', 'answer_only', 'legacy_envelope'])
async def test_encoded_outline_decodes_once_without_changing_answer_or_executing_tools(mode, caplog):
    answer = copy.deepcopy(ANSWER)
    answer['spokenOutline'] = json.dumps(answer['spokenOutline'])
    message = ({'tool_calls': [call(arguments=answer)]} if mode == 'tool'
               else {'content': json.dumps(answer)})
    requests = []
    caplog.set_level('INFO', logger='moolai_backend.providers')
    result = await run(message, requests, mode='answer_only' if mode == 'answer_only' else 'auto')
    assert result.text == ANSWER['text']
    assert result.spokenOutline.model_dump() == ANSWER['spokenOutline']
    assert [ref.model_dump() for ref in result.references] == ANSWER['references']
    assert result.toolCalls == [] and result.controlProposal is None
    assert [req.method for req in requests] == ['GET', 'POST']
    assert 'decoded_spoken_outline' in caplog.text
    assert 'Two notes support' not in caplog.text and 'fixture-secret' not in caplog.text


@pytest.mark.parametrize('encoded', [
    '{unfinished', '[]', 'null', 'true',
    json.dumps(json.dumps(ANSWER['spokenOutline'])),
    '{"overview":"first","overview":"second","points":[]}',
    '{"overview":"Overview","points":[{"label":"First","label":"Other"}]}',
    json.dumps({**ANSWER['spokenOutline'], 'toolCalls': [{'name': 'delete'}]}),
    json.dumps({'overview': 'Unsupported', 'points': [{
        'label': 'Missing explanation', 'sourceSections': [1]}]}),
    json.dumps({'overview': 'Unsupported', 'points': [{
        'label': 'Sections', 'explanation': 'Explanation.', 'sourceSections': ['1']}]}),
    json.dumps({'overview': ' ' * 128_001, 'points': []}),
])
@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_encoded_outline_never_repairs_invalid_generated_content(encoded, mode):
    answer = {**ANSWER, 'spokenOutline': encoded}
    requests = []
    message = ({'tool_calls': [call(arguments=answer)]} if mode == 'auto'
               else {'content': json.dumps(answer)})
    result = await run(message, requests, mode=mode)
    assert result.text == ANSWER['text'] and result.spokenText == ANSWER['spokenText']
    assert result.spokenOutline is None and result.narrationError
    assert result.toolCalls == [] and result.controlProposal is None
    assert [req.method for req in requests] == ['GET', 'POST']


@pytest.mark.parametrize('change', ['plain', 'malformed', 'extra_action', 'duplicate_key', 'fenced'])
async def test_explicit_answer_only_cannot_fall_through_to_legacy_prose(change):
    answer = copy.deepcopy(ANSWER)
    if change == 'missing_outline':
        del answer['spokenOutline']
    elif change == 'missing_sections':
        del answer['spokenOutline']['points'][0]['sourceSections']
    elif change == 'extra_action':
        answer['toolCalls'] = []
    content = json.dumps(answer)
    if change == 'plain':
        content = 'This does not follow the requested final-answer format.'
    elif change == 'malformed':
        content = content[:-1]
    elif change == 'duplicate_key':
        content = '{"text":"Competing text",' + content[1:]
    elif change == 'fenced':
        content = '```json\n' + content + '\n```'
    requests = []
    with pytest.raises(ServiceError):
        await run({'content': content}, requests, mode='answer_only')
    assert [req.method for req in requests] == ['GET', 'POST']


async def test_outline_compatibility_does_not_coerce_executable_arguments():
    encoded = json.dumps(ANSWER['spokenOutline'])
    args = {'spokenOutline': encoded, 'query': 'Evidence'}
    result = await run({'tool_calls': [call('brain_search', args)]}, [], tools=[{
        'name': 'brain_search', 'description': 'Search.', 'parameters': {'type': 'object'}}])
    assert result.toolCalls[0].arguments == args
    assert isinstance(result.toolCalls[0].arguments['spokenOutline'], str)


@pytest.mark.parametrize('content', [
    '<function>\n<name>conversation_history</name>\n<parameter><name>start</name>'
    '<value>2026-01-02</value></parameter>\n</function>\n</invoke>\n</minimax:tool_call>',
    '<minimax:tool_call><invoke name="search_notes"><parameter name="query">weather</parameter></invoke></minimax:tool_call>',
    '<tool_call>{"name":"search_notes","arguments":{"query":"weather"}}</tool_call>',
    '<function=search_notes>{"query":"weather"}</function>',
    '<think>I should search for the answer.</think>',
    json.dumps({'tool_calls': [{'name': 'search_notes', 'arguments': {'query': 'weather'}}]}),
    json.dumps({'function_call': {'name': 'search_notes', 'arguments': '{}'}}),
    '   ',
])
@pytest.mark.parametrize('mode', ['legacy', 'delivered', 'answer_only', 'legacy_envelope'])
async def test_tool_shaped_nonanswers_are_not_published_or_executed(content, mode, caplog):
    answer = {**ANSWER, 'text': content}
    message = ({'content': content} if mode == 'legacy'
               else {'tool_calls': [call(arguments=answer)]} if mode == 'delivered'
               else {'content': json.dumps(answer)})
    requests = []
    with pytest.raises(ServiceError, match='invalid text or tool calls'):
        await run(message, requests, mode='answer_only' if mode == 'answer_only' else 'auto',
                  tools=[{'name': 'search_notes', 'description': 'Search.', 'parameters': {}}])
    assert [req.method for req in requests] == ['GET', 'POST']
    assert 'invalid_response_envelope' in caplog.text
    assert all(value not in caplog.text for value in ['weather', '2026-01-02', 'fixture-secret'])


@pytest.mark.parametrize('content', [
    'The <function> element describes an operation; this is documentation.',
    '```xml\n<function><name>search_notes</name></function>\n```',
    '> <tool_call>{"name":"search_notes"}</tool_call>\n\nThis is a quoted example.',
    'Use `{"tool_calls": []}` as an example of an empty list.',
    'No matching notes were returned for that query.',
])
async def test_ordinary_explanations_and_explicit_code_examples_remain_content(content):
    result = await run({'content': content}, [])
    assert result.text == content and result.toolCalls == []


@pytest.mark.parametrize('mode', ['delivered', 'answer_only', 'legacy_envelope'])
async def test_corrected_request_is_separate_optional_presentation_in_the_existing_call(mode):
    interpreted = 'Search the notes for what Morgan said.'
    answer = {**ANSWER, 'understoodRequest': interpreted}
    message = ({'tool_calls': [call(arguments=answer)]} if mode == 'delivered'
               else {'content': json.dumps(answer)})
    requests = []
    result = await run(message, requests, mode='answer_only' if mode == 'answer_only' else 'auto')
    assert result.understoodRequest == interpreted
    assert result.text == ANSWER['text'] and result.toolCalls == []
    assert len(requests) == 2


@pytest.mark.parametrize('value', ['', ' ', 'x' * 501, 12, {'text': 'Invented'}])
async def test_corrected_request_does_not_bypass_presentation_bounds(value):
    with pytest.raises(ServiceError):
        await run({'tool_calls': [call(arguments={**ANSWER, 'understoodRequest': value})]}, [])


async def test_empty_legacy_envelope_cannot_bypass_nonempty_answer_guard():
    for text in ['', None, {'text': 'Nested'}]:
        with pytest.raises(ServiceError):
            await run({'content': json.dumps({'text': text})}, [])


@pytest.mark.parametrize('limit', [2400, 4096, 8192])
@pytest.mark.parametrize('mode', ['auto', 'answer_only'])
async def test_agent_allowance_is_explicit_bounded_and_does_not_override_reasoning(limit, mode):
    requests = []
    message = {'content': json.dumps(ANSWER)} if mode == 'answer_only' else {'tool_calls': [call()]}
    settings = replace(SETTINGS, agent_max_tokens=limit)
    async with httpx.AsyncClient(transport=provider_transport(message, requests)) as client:
        await NebiusProvider(Gateway(settings, client)).respond(RespondInput(
            messages=[{'role': 'user', 'content': 'Explain the evidence.'}], tools=[], responseMode=mode))
    body = json.loads(requests[-1].content)
    assert body['max_completion_tokens'] == limit and body['model'] == SETTINGS.agent_model
    assert 'reasoning_effort' not in body and 'chat_template_kwargs' not in body
    assert 'max_tokens' not in body and len(requests) == 2


async def test_reasoning_exhaustion_keeps_the_limit_and_does_not_retry(caplog):
    requests = []
    settings = replace(SETTINGS, agent_max_tokens=4096)
    def respond(req):
        requests.append(req)
        if req.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        return httpx.Response(200, json={'model': settings.agent_model, 'choices': [{
            'finish_reason': 'length', 'message': {'content': None, 'reasoning_content': 'PRIVATE_REASONING'}}],
            'usage': {'prompt_tokens': 1400, 'completion_tokens': 4096,
                      'completion_tokens_details': {'reasoning_tokens': 4096}}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='4,096-token output limit') as error:
            await NebiusProvider(Gateway(settings, client)).respond(RespondInput(
                messages=[{'role': 'user', 'content': 'PRIVATE_REQUEST'}], tools=[]))
    assert error.value.status == 422
    assert [req.method for req in requests] == ['GET', 'POST']
    assert 'reasoning_tokens' in caplog.text and '4096' in caplog.text
    assert all(secret not in caplog.text for secret in ['PRIVATE_REASONING', 'PRIVATE_REQUEST', 'fixture-secret'])


@pytest.mark.parametrize('limit', [0, 2399, 8193, True, 4096.5])
def test_agent_completion_configuration_rejects_invalid_bounds(limit):
    with pytest.raises(ValueError, match='Agent completion limit'):
        Settings(agent_max_tokens=limit)


def test_agent_allowance_environment_preserves_library_default(monkeypatch):
    monkeypatch.delenv('NEBIUS_AGENT_MAX_TOKENS', raising=False)
    assert Settings.from_env().agent_max_tokens == 2400
    monkeypatch.setenv('NEBIUS_AGENT_MAX_TOKENS', '4096')
    assert Settings.from_env().agent_max_tokens == 4096
    # Explicit fixture settings never inherit the process environment.
    assert Settings().agent_max_tokens == 2400
