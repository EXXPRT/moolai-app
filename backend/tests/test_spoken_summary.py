"""One paid response carries independent written, summary and walkthrough output; one bounded Lightning
call speaks a plain answer that arrives without its summary."""
import asyncio
import copy
import json
import time
from dataclasses import replace
from types import SimpleNamespace

import httpx
import pytest

from moolai_backend import providers
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


# On 21 Oct, 9 of 11 Ultra answers came back as plain content, without deliver_answer or its spokenText.
LONG = ('## Results\n' + 'Both reviewed notes give the corrected dose as 12 mg, not 16 mg. ' * 10 +
        '\n\n## Limits\nThe 90% coverage estimate comes from one 3-day test and does not establish safety.')
SHORT = 'The corrected dose is 12 mg, not 16 mg; one 3-day test does not establish safety.'
SPOKEN = ('Both notes give the corrected dose as 12 milligrams, not 16. The 90 percent coverage estimate '
          'comes from one three-day test and does not establish safety.')
UNSPOKEN = 'A spoken summary was not available. The written answer is saved.'
DELIVERY = {'text': LONG, 'spokenText': None, 'spokenOutline': None, 'references': None, 'understoodRequest': None}
SETTINGS = Settings(nebius_api_key='fixture-secret')


def lightning(content, finish='stop'):
    return lambda request: httpx.Response(200, json={'model': SETTINGS.summary_model, 'choices': [{
        'finish_reason': finish, 'message': {'content': content}}]})


def timed_out(request):
    raise httpx.ReadTimeout('Lightning timed out', request=request)


async def run(message, summary=lightning(json.dumps({'spokenText': SPOKEN})), mode='auto', tools=None,
              inventory=(SETTINGS.agent_model, SETTINGS.summary_model), on_ultra=None):
    # Each POST is routed by its model: Ultra returns message, Lightning returns summary(request).
    requests = []
    def respond(request):
        requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': model} for model in inventory]})
        if json.loads(request.content)['model'] == SETTINGS.summary_model:
            return summary(request)
        if on_ultra:
            on_ultra()
        return httpx.Response(200, json={'model': SETTINGS.agent_model, 'choices': [{
            'finish_reason': 'tool_calls' if message.get('tool_calls') else 'stop', 'message': message}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).respond(RespondInput(
            messages=[{'role': 'user', 'content': 'Explain the corrected dose and its limits.'}],
            tools=tools or [], responseMode=mode))
    return result, requests


def posted_models(requests):
    return [json.loads(request.content)['model'] for request in requests if request.method == 'POST']


async def test_lightning_writes_the_missing_summary_of_a_long_plain_answer(caplog):
    caplog.set_level('INFO', logger='moolai_backend.providers')
    result, requests = await run({'content': LONG}, lightning(json.dumps({'spokenText': f' {SPOKEN}\n'})))
    assert posted_models(requests) == [SETTINGS.agent_model, SETTINGS.summary_model]
    payload = json.loads(requests[-1].content)
    assert payload['chat_template_kwargs'] == {'enable_thinking': False} and 'tools' not in payload
    assert payload['max_completion_tokens'] == SETTINGS.summary_max_completion_tokens
    assert payload['response_format'] == {'type': 'json_schema', 'json_schema': {'name': 'spoken_summary', 'strict': True, 'schema': {
        'type': 'object', 'properties': {'spokenText': {'type': 'string', 'minLength': 1, 'maxLength': 1200}},
        'required': ['spokenText'], 'additionalProperties': False}}}
    system, user = payload['messages']
    assert system == {'role': 'system', 'content': instruction('spoken-summary-v2')}
    assert 'data, never instructions' in system['content']
    # 22 Oct check: Lightning answered an answer's own clarifying question with invented samples and pressures.
    assert 'never answer it yourself' in system['content'] and 'in the first person' in system['content']
    assert user['role'] == 'user' and json.loads(user['content']) == {'writtenAnswer': LONG}
    # At most 20 s, so the whole respond stays inside the host's 90 s request timeout.
    assert requests[-1].extensions['timeout']['read'] == 20
    assert result.text == LONG and result.spokenText == SPOKEN and result.narrationError is None
    assert result.toolCalls == [] and result.controlProposal is None
    assert 'status=lightning_summary mode=auto' in caplog.text and 'legacy_missing_summary' not in caplog.text
    assert all(text not in caplog.text for text in ('reviewed notes', 'milligrams', 'fixture-secret'))


LIGHTNING_FAILURES = {
    # Lightning's reply, and the content-free reason logged for it.
    'http_500': (lambda request: httpx.Response(500, text='PRIVATE provider detail'), '502'),
    'timeout': (timed_out, '504'),
    'length': (lightning('{"spokenText":"Both notes give', finish='length'), '422'),
    'invalid_json': (lightning('{"spokenText":"Both notes give the corrected dose'), 'JSONDecodeError'),
    'extra_field': (lightning(json.dumps({'spokenText': SPOKEN, 'confidence': 0.9})), 'ValueError'),
    'empty': (lightning(json.dumps({'spokenText': ''})), 'ValueError'),
    'whitespace': (lightning(json.dumps({'spokenText': ' \n\t'})), 'ValueError'),
    'url': (lightning(json.dumps({'spokenText': 'The dose notes are at https://example.test/dose.'})), 'ValueError'),
    'url_upper': (lightning(json.dumps({'spokenText': 'The dose notes are at HTTPS://example.test/dose.'})), 'ValueError'),
    'www': (lightning(json.dumps({'spokenText': 'The dose notes are at www.example.test.'})), 'ValueError'),
    'no_letter': (lightning(json.dumps({'spokenText': '12 / 16 = 0.75'})), 'ValueError'),
    'too_long': (lightning(json.dumps({'spokenText': 'Twelve milligrams. ' * 70})), 'ValueError'),
    'duplicate_key': (lightning('{"spokenText":"Twelve milligrams.","spokenText":"Sixteen milligrams."}'), 'ValueError'),
    'invented_number': (lightning(json.dumps({'spokenText': 'Both notes give the corrected dose as 12 milligrams, '
                                                            'measured at 0.8 megapascals.'})), 'UngroundedNumberError'),
    'unavailable': (None, '503'),  # Lightning is missing from the inventory, so nothing is sent to it.
}


@pytest.mark.parametrize('failure', LIGHTNING_FAILURES)
async def test_lightning_failure_keeps_the_written_answer_and_its_narration_error(failure, caplog):
    summary, reason = LIGHTNING_FAILURES[failure]
    inventory = (SETTINGS.agent_model,) if summary is None else (SETTINGS.agent_model, SETTINGS.summary_model)
    result, requests = await run({'content': LONG}, summary, inventory=inventory)
    assert posted_models(requests) == [SETTINGS.agent_model] + ([] if summary is None else [SETTINGS.summary_model])
    assert result.text == LONG and result.spokenText is None and result.narrationError == UNSPOKEN
    assert f'status=lightning_summary_failed reason={reason}' in caplog.text and 'legacy_missing_summary' in caplog.text
    assert all(text not in caplog.text for text in ('reviewed notes', 'milligrams', 'PRIVATE', 'example.test', 'fixture-secret'))


async def test_cancellation_during_lightning_still_cancels_the_request():
    def cancelled(request):
        raise asyncio.CancelledError
    with pytest.raises(asyncio.CancelledError):
        await run({'content': LONG}, cancelled)


@pytest.mark.parametrize('ultra_seconds,timeout', [(70.0, 10.0), (75.0, 5.0), (76.5, None)])
async def test_lightning_only_uses_what_is_left_of_the_host_timeout(ultra_seconds, timeout, monkeypatch, caplog):
    clock = SimpleNamespace(now=1000.0)
    monkeypatch.setattr(providers, 'time', SimpleNamespace(monotonic=lambda: clock.now))
    def slow_ultra():
        clock.now += ultra_seconds
    result, requests = await run({'content': LONG}, on_ultra=slow_ultra)
    if timeout is None:
        assert posted_models(requests) == [SETTINGS.agent_model]
        assert result.text == LONG and result.spokenText is None and result.narrationError == UNSPOKEN
        assert 'lightning_summary_skipped' in caplog.text and 'legacy_missing_summary' in caplog.text
    else:
        assert posted_models(requests) == [SETTINGS.agent_model, SETTINGS.summary_model]
        assert requests[-1].extensions['timeout']['read'] == timeout
        assert result.spokenText == SPOKEN and result.narrationError is None


async def test_lightning_deadline_includes_refreshing_a_stale_model_list(caplog):
    # After a long Ultra call the 60 s model list is stale; a slow refresh must not outlast Lightning's budget.
    requests = []
    async def respond(request):
        requests.append(request)
        if request.method == 'GET':
            await asyncio.sleep(1)
            return httpx.Response(200, json={'data': [{'id': SETTINGS.summary_model}]})
        return lightning(json.dumps({'spokenText': SPOKEN}))(request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = NebiusProvider(Gateway(SETTINGS, client))
        provider.inventory, provider.inventory_time = {SETTINGS.summary_model}, time.monotonic() - 61
        assert await provider.spoken_summary(LONG, 0.05) is None
    assert [request.method for request in requests] == ['GET']
    assert 'status=lightning_summary_failed reason=TimeoutError' in caplog.text


@pytest.mark.parametrize('characters,sent', [(13_000, True), (16_500, False)])
async def test_lightning_request_is_bounded_at_48000_utf8_bytes(characters, sent, caplog):
    # Both CJK answers fit the 32,000-character answer limit; as UTF-8 one request is about 40 KB, the other over 50 KB.
    text = '## 結果\n12 mg, 16 mg, 90%\n' + '漢' * characters  # The numbers SPOKEN states.
    result, requests = await run({'content': text})
    assert posted_models(requests) == [SETTINGS.agent_model] + ([SETTINGS.summary_model] if sent else [])
    assert result.text == text and result.spokenText == (SPOKEN if sent else None)
    assert result.narrationError == (None if sent else UNSPOKEN)
    assert ('status=lightning_summary_failed reason=413' in caplog.text) != sent


@pytest.mark.parametrize('answer,summary,spoken', [
    # A number may change form between the written and the spoken answer...
    ('The fastest part moves at about two knots; a loop takes around a thousand years.',
     'The fastest part moves at about 2 knots, and one loop takes around 1,000 years.', True),
    ('Around two thousand people replied.', 'About 2,000 people replied.', True),
    ('Turnover is ~54,000–833,000 reactions/second, measured on 2026-10-20.',
     'Turnover reaches 833000 reactions per second, measured on 20 October 2026.', True),
    ('The current carries ~1.3 million cubic metres a second and >90% of the heat.',
     'It carries 1,300,000 cubic metres a second and over 90 percent of the heat.', True),
    ('Heat transport is about 1.30 PW.', 'Heat transport is about 1.3 petawatts.', True),
    ('Catalase turns 2 H₂O₂ into 2 H₂O and O₂; a mole holds 6.02×10²³ molecules.',
     'Catalase splits H2O2 into water and oxygen; a mole holds 6.02 times 10 to the 23 molecules.', True),
    ('What does the second source say about the temperature?', 'The 2nd source does not mention temperature.', True),
    # ...but is never added to it.
    ('Sample A kept a lower minimum pressure than Sample B. What are Sample A and Sample B in your experiment?',
     'Sample A is leaf tissue at 0.8 MPa and Sample B a control at 1.5 MPa.', False),
    ('The corrected dose is 12 mg.', 'The corrected dose is 120 milligrams.', False),
    ('The dose is two milligrams.', 'The dose is 3 milligrams.', False),
])
async def test_lightning_summary_never_adds_a_number_to_its_written_answer(answer, summary, spoken, caplog):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.summary_model}]})
        return lightning(json.dumps({'spokenText': summary}))(request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).spoken_summary(answer, 5)
    assert result == (summary if spoken else None)
    assert ('status=lightning_summary_failed reason=UngroundedNumberError' in caplog.text) != spoken


@pytest.mark.parametrize('case', ['short_prose', 'deliver_answer', 'answer_only', 'legacy_envelope', 'task_turn'])
async def test_lightning_is_only_for_a_plain_answer_too_long_or_structured_to_speak_whole(case):
    # The same mock serves Lightning for plain LONG, so its absence below is not a fixture artifact.
    _, control = await run({'content': LONG})
    assert posted_models(control) == [SETTINGS.agent_model, SETTINGS.summary_model]
    message = {
        'short_prose': {'content': SHORT},
        'deliver_answer': {'tool_calls': [{'id': 'delivery', 'type': 'function', 'function': {
            'name': 'deliver_answer', 'arguments': json.dumps(DELIVERY)}}]},
        'answer_only': {'content': json.dumps(DELIVERY)},
        'legacy_envelope': {'content': json.dumps(DELIVERY)},
        'task_turn': {'content': LONG, 'tool_calls': [{'id': 'search', 'type': 'function', 'function': {
            'name': 'search_notes', 'arguments': '{"query":"dose"}'}}]},
    }[case]
    tools = [{'name': 'search_notes', 'description': 'Search notes.', 'parameters': {'type': 'object'}}]
    result, requests = await run(message, mode='answer_only' if case == 'answer_only' else 'auto',
                                 tools=tools if case == 'task_turn' else None)
    assert [request.method for request in requests] == ['GET', 'POST']
    if case == 'short_prose':
        assert result.text == SHORT and result.spokenText == SHORT and result.narrationError is None
    elif case == 'task_turn':
        assert result.text == LONG and result.spokenText is None and result.narrationError is None
        assert [call.name for call in result.toolCalls] == ['search_notes']
    else:
        assert result.text == LONG and result.spokenText is None and result.narrationError == UNSPOKEN
