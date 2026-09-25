import json

import httpx
import pytest
from pydantic import ValidationError

from moolai_backend.providers import Gateway, JevProvider, NebiusProvider, ServiceError, TavilyProvider, validate_vision
from moolai_backend.schemas import ConnectInput, RespondInput, RouteDecision, RouteInput, Summary, TagInput, VisionInput
from moolai_backend.settings import Settings


SETTINGS = Settings(typesafe_api_key='fixture-jev', nebius_api_key='fixture-nebius', tavily_api_key='fixture-tavily')


def choice(options, chosen, confidence=.96):
    return {'type': 'choice', 'choice': chosen, 'confidence': confidence,
            'probabilities': {name: 1.0 if name == chosen else 0.0 for name in options}}


async def test_route_uses_native_typesafe_shape_and_full_context():
    captured = []
    latest_text = 'Yes please.\nKeep the original constraint: use only my notes.'

    def respond(request):
        assert str(request.url) == 'https://api.typesafe.ai/v1/systemone'
        assert request.headers['authorization'] == 'Bearer fixture-jev'
        body = json.loads(request.content)
        captured.append(body)
        question = body['questions']['route']
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(question['criteria'], 'accept_help'),
        }})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = JevProvider(Gateway(SETTINGS, client))
        result = await provider.route(RouteInput(text=latest_text, recentContext='Earlier context ' * 500,
            activeConversation=False, pendingOffer={'kind': 'help', 'recordId': 'doubt-1'}))
    assert result.route == 'start_agent' and result.helpAccepted is True
    assert len(captured) == 1
    state = json.loads(captured[0]['state'])
    assert list(state) == ['activeConversation', 'pendingOffer', 'recentContext', 'latestUserUtterance']
    assert state['latestUserUtterance'] == latest_text
    assert state['recentContext'] == 'Earlier context ' * 500
    assert state['pendingOffer']['recordId'] == 'doubt-1'
    assert 'quoted' in captured[0]['questions']['route']['instructions'].lower()
    assert captured[0]['questions']['route']['instructions'].startswith(
        'Identify the intended action of the current transcription using the conversation state and relevant preceding context:')
    assert 'dictated or discussed' in captured[0]['questions']['route']['instructions']


async def test_end_action_question_is_independent_and_ambiguous_action_is_unclear():
    def respond(request):
        questions = json.loads(request.content)['questions']
        assert 'end_action' in questions
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(questions['route']['criteria'], 'end_agent'),
            'end_action': choice(questions['end_action']['criteria'], 'unclear', .2),
        }})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
            text='perhaps', recentContext='finish, cancel, or continue?', activeConversation=True,
            pendingOffer={'kind': 'end_work'}))
    assert result.route == 'unclear' and result.endAction is None
    assert result.confidence == .2


async def test_unrelated_moo_request_does_not_accept_pending_help():
    def respond(request):
        questions = json.loads(request.content)['questions']
        assert set(questions) == {'route'}  # Same gate; no second classifier call.
        assert 'accept_help' in questions['route']['criteria']
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(questions['route']['criteria'], 'start_agent'),
        }})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
            text='Moo, tell me something else', recentContext='Would you like help?', activeConversation=False,
            pendingOffer={'kind': 'help', 'recordId': 'saved-doubt'}))
    assert result.route == 'start_agent' and result.helpAccepted is None


@pytest.mark.parametrize(('active', 'offer', 'text', 'selected', 'end_action'), [
    (False, None, 'Can you tell me how this happened?', 'start_agent', None),
    (False, None, 'What is even going on?', 'offer_help', None),
    (False, None, 'The goalpost is 5m wide.', 'dictate', None),
    (False, None, 'Yes, please.', 'no_action', None),
    (False, {'kind': 'help', 'recordId': 'doubt'}, 'Explain something else', 'start_agent', None),
    (False, {'kind': 'general_help', 'recordId': 'doubt'}, 'No, just save it', 'no_action', None),
    (False, {'kind': 'clarification', 'recordId': 'request'}, 'I want an explanation', 'start_agent', None),
    (True, None, 'That is all.', 'end_agent', None),
    (True, None, 'The goalpost is 5m wide.', 'continue_agent', None),
    (True, None, 'The phrase "That is all" is an example', 'continue_agent', None),
    (True, None, 'Do not finish the conversation', 'no_action', None),
    (True, None, 'Maybe finish?', 'unclear', None),
    (True, {'kind': 'clarification', 'recordId': 'request'}, 'Keep explaining the example', 'continue_agent', None),
    (True, {'kind': 'end_work'}, 'Finish the pending work', 'end_agent', 'finish'),
    (True, {'kind': 'end_work'}, 'Cancel the pending work', 'end_agent', 'cancel'),
    (True, {'kind': 'end_work'}, 'Continue the conversation', 'no_action', 'continue'),
])
async def test_route_choices_follow_conversation_state_without_forcing_closure(active, offer, text, selected, end_action):
    captured = []
    pending_kind = offer['kind'] if offer else None
    if pending_kind == 'end_work':
        allowed = {'end_agent', 'no_action', 'unclear'}
    elif pending_kind in ('help', 'general_help'):
        allowed = {'start_agent', 'dictate', 'no_action', 'unclear', 'accept_help'}
    elif active:
        allowed = {'end_agent', 'continue_agent', 'no_action', 'unclear'}
    else:
        allowed = {'start_agent', 'offer_help', 'offer_screen_help', 'dictate', 'no_action', 'unclear'}

    def respond(request):
        body = json.loads(request.content)
        captured.append(body)
        questions = body['questions']
        criteria = questions['route']['criteria']
        assert set(criteria) == allowed
        assert 'exact command' in questions['route']['instructions']
        answers = {'route': choice(criteria, selected)}
        if end_action:
            assert set(questions) == {'route', 'end_action'}
            answers['end_action'] = choice(questions['end_action']['criteria'], end_action)
        elif active:
            assert set(questions) == {'route', 'substantive_content'}
            answers['substantive_content'] = {'type': 'noul', 'noul': .1}
        else:
            assert set(questions) == {'route'}
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': answers})

    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
            text=text, recentContext='Earlier request and constraints remain available.',
            activeConversation=active, pendingOffer=offer))
    assert len(captured) == 1
    assert json.loads(captured[0]['state'])['latestUserUtterance'] == text
    assert result.route == selected and result.endAction == end_action
    assert result.helpAccepted is None
    assert result.substantiveContentProbability == (.1 if selected == 'end_agent' and not end_action else None)


@pytest.mark.parametrize('kind', ['help', 'general_help'])
async def test_help_acceptance_links_to_the_correct_offer_kind(kind):
    def respond(request):
        body = json.loads(request.content)
        assert json.loads(body['state'])['pendingOffer'] == {'kind': kind, 'recordId': 'original-thought'}
        questions = body['questions']
        assert set(questions) == {'route'}
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(questions['route']['criteria'], 'accept_help'),
        }})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
            text='Yes please', recentContext='Would you like help?', activeConversation=False,
            pendingOffer={'kind': kind, 'recordId': 'original-thought'}))
    assert result.route == 'start_agent' and result.helpAccepted is True


async def test_j1_rejects_a_route_not_allowed_in_the_current_state():
    def respond(request):
        questions = json.loads(request.content)['questions']
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(questions['route']['criteria'], 'end_agent'),
        }})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='unknown choice'):
            await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
                text='That is all', recentContext='', activeConversation=False))


async def test_closing_content_assessment_shares_request_and_preserves_uncertainty():
    cases = [
        ('Boo.\n Finish conversation.', .05),
        ('Explain the final example. Moo, finish conversation.', .95),
        ('One more thing, finish conversation.', .5),
    ]
    for text, content_probability in cases:
        requests = []

        def respond(request):
            body = json.loads(request.content)
            requests.append(body)
            questions = body['questions']
            assert set(questions) == {'route', 'substantive_content'}
            assert questions['substantive_content']['type'] == 'noul'
            assert json.loads(body['state'])['latestUserUtterance'] == text
            return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
                'route': choice(questions['route']['criteria'], 'end_agent', .93),
                'substantive_content': {'type': 'noul', 'noul': content_probability},
            }})

        async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
            result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
                text=text, recentContext='Earlier substantive request remains in history.', activeConversation=True))
        assert len(requests) == 1
        assert result.route == 'end_agent' and result.confidence == .93
        assert result.substantiveContentProbability == content_probability


def test_closing_content_probability_is_optional_and_bounded():
    assert RouteDecision(route='end_agent', confidence=.9).substantiveContentProbability is None
    for invalid in [-.01, 1.01]:
        with pytest.raises(ValidationError):
            RouteDecision(route='end_agent', confidence=.9, substantiveContentProbability=invalid)


def test_j7_allows_runtime_thirty_topic_candidates(record):
    item = TagInput(record=record, topicCandidates=[f'Topic {index}' for index in range(30)])
    assert len(item.topicCandidates) == 30


async def test_j7_keeps_doubt_independent_of_purpose_and_relevance(record):
    def respond(request):
        body = json.loads(request.content)
        assert json.loads(body['state'])['node']['segments'][0]['speaker'] == 'user'
        questions = body['questions']
        assert set(questions) == {'purpose', 'doubt', 'faithful', 'understandable', 'relevant'}
        assert set(json.loads(body['state'])['node']) == {'title', 'summary', 'segments'}
        assert set(questions['purpose']['criteria']) == {'Question', 'Reference', 'Idea', 'Action', 'unclear'}
        answers = {name: {'type': 'noul', 'noul': .95} for name in questions if name != 'purpose'}
        answers['relevant']['noul'] = .04
        answers['purpose'] = choice(questions['purpose']['criteria'], 'Reference')
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': answers})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).tag(TagInput(
            record=record, currentSubject='Physics', topicCandidates=['Gardening']))
    assert result.purpose == 'Reference'
    assert result.doubt == .95 and result.relevant == .04
    assert result.topics == {}  # Flexible topic suggestions belong to Nano, not J7.
    assert record.segments[0].text.startswith('I think')  # Providers never mutate source.


async def test_missing_jev_answers_and_invalid_probabilities_fail_visibly(record):
    count = 0

    def respond(request):
        nonlocal count
        count += 1
        questions = json.loads(request.content)['questions']
        answers = {name: {'type': 'noul', 'noul': 1.2} for name in questions}
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': answers})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = JevProvider(Gateway(SETTINGS, client))
        candidate = record.model_copy(update={'id': 'candidate'})
        with pytest.raises(ServiceError, match='probability'):
            await provider.connect(ConnectInput(record=record, candidates=[candidate]))
        assert await provider.connect(ConnectInput(record=record, candidates=[])) == {}
    assert count == 1


async def test_connections_refer_to_exact_candidate_identity(record):
    def respond(request):
        body = json.loads(request.content)
        assert 'candidate-a' in body['questions']['candidate_0']['instructions']
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'candidate_0': {'type': 'noul', 'noul': .9},
            'candidate_1': {'type': 'noul', 'noul': .1},
        }})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).connect(ConnectInput(
            record=record, candidates=[record.model_copy(update={'id': 'candidate-a'}), record.model_copy(update={'id': 'candidate-b'})]))
    assert result == {'candidate-a': .9, 'candidate-b': .1}


def completion(model, content=None, tool_calls=None, finish='stop'):
    return {'model': model, 'choices': [{'finish_reason': finish, 'message': {'content': content, 'tool_calls': tool_calls}}]}


async def test_summary_checks_inventory_and_enforces_output_schema(record):
    requests = []

    def respond(request):
        requests.append(request)
        if request.url.path.endswith('/models'):
            return httpx.Response(200, json={'data': [{'id': SETTINGS.summary_model}]})
        body = json.loads(request.content)
        assert body['model'] == SETTINGS.summary_model and body['max_completion_tokens'] == 1200
        assert 'max_tokens' not in body and body['store'] is False
        assert body['response_format']['type'] == 'json_schema'
        summary_format = body['response_format']['json_schema']
        assert summary_format['strict'] is True
        assert set(summary_format['schema']['required']) == {'title', 'summary', 'topicSuggestion', 'topicSuggestions'}
        assert summary_format['schema']['additionalProperties'] is False
        assert json.loads(body['messages'][1]['content'])['transcript'][0]['speaker'] == 'user'
        return httpx.Response(200, json=completion(SETTINGS.summary_model,
            json.dumps({'title': 'Garden shade', 'summary': 'The user thinks more shade may help.', 'topicSuggestion': 'Gardening'})))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).summarize(record)
    assert result.title == 'Garden shade' and len(requests) == 2


async def test_summary_uses_source_only_and_preserves_fidelity_instructions(record):
    original = record.model_copy(deep=True)
    record.summary = 'Incorrect generated claim about intended volume.'
    record.qualityReasons = ['INTERNAL_PROCESSING_SENTINEL']
    record.error = 'INTERNAL_PROVIDER_ERROR'
    record.topics = ['INTERNAL_OLD_TAG']
    record.title = 'Exact supplied title'
    record.manualFields = ['title']
    record.segments[0].text = 'I used 12 mL, not 120 mL. I may repeat this tomorrow; it is not done.'
    wire = []

    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.summary_model}]})
        body = json.loads(request.content)
        wire.append(body)
        return httpx.Response(200, json=completion(SETTINGS.summary_model, json.dumps({
            'title': 'Exact supplied title', 'summary': 'The user used 12 mL, not 120 mL, and may repeat this tomorrow.',
            'topicSuggestions': ['Volume measurement', 'Experimental method'], 'topicSuggestion': None,
        })))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).summarize(record)
    state = json.loads(wire[0]['messages'][1]['content'])
    assert state == {'transcript': [{'speaker': 'user', 'text': record.segments[0].text}],
                     'suppliedTitle': 'Exact supplied title'}
    assert 'INTERNAL_' not in wire[0]['messages'][1]['content']
    instructions = wire[0]['messages'][0]['content']
    for required in ['quantities and units', 'negation', 'speaker attribution', 'cancelled',
                     'rejected quantity', 'up to three', 'editable suggestions']:
        assert required in instructions
    assert result.topicSuggestions == ['Volume measurement', 'Experimental method']
    assert original.summary != record.summary  # Only this test modified the input fixture.


def test_summary_suggestions_are_bounded_and_legacy_payloads_still_work():
    legacy = Summary(title='Title', summary='Summary', topicSuggestion='Physics')
    assert legacy.topicSuggestion == 'Physics' and legacy.topicSuggestions == []
    for topics in [['One', 'Two', 'Three', 'Four'], [''], ['x' * 81]]:
        with pytest.raises(ValidationError):
            Summary(title='Title', summary='Summary', topicSuggestions=topics)


async def test_no_model_substitution_and_no_paid_call_when_model_is_missing(record):
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(200, json={'data': [{'id': 'some-other-model'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='unavailable'):
            await NebiusProvider(Gateway(SETTINGS, client)).summarize(record)
    assert len(requests) == 1 and requests[0].method == 'GET'


@pytest.mark.parametrize('fault', ['malformed', 'truncated', 'model_swap'])
async def test_bad_generation_never_becomes_success(record, fault):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.summary_model}]})
        body = completion(SETTINGS.summary_model, '{not-json}')
        if fault == 'truncated':
            body['choices'][0]['finish_reason'] = 'length'
        if fault == 'model_swap':
            body['model'] = 'wrong-model'
        return httpx.Response(200, json=body)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError):
            await NebiusProvider(Gateway(SETTINGS, client)).summarize(record)


async def test_agent_tool_protocol_roundtrip_and_unknown_tool_rejection():
    invalid = False

    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        body = json.loads(request.content)
        assert body['max_completion_tokens'] == 2400 and body['store'] is False
        assert body['tool_choice'] == 'auto'
        assert body['messages'][0]['tool_calls'][0]['function']['arguments'] == '{"query": "shade"}'
        assert body['messages'][1]['tool_call_id'] == 'old-call'
        name = 'dangerous_tool' if invalid else 'brain_search'
        return httpx.Response(200, json=completion(SETTINGS.agent_model, tool_calls=[{
            'id': 'next-call', 'type': 'function', 'function': {'name': name, 'arguments': '{"query":"shade"}'},
        }], finish='tool_calls'))
    item = RespondInput(messages=[
        {'role': 'assistant', 'content': '', 'toolCalls': [{'id': 'old-call', 'name': 'brain_search', 'arguments': {'query': 'shade'}}]},
        {'role': 'tool', 'content': 'No notes found', 'toolCallId': 'old-call'},
    ], tools=[{'name': 'brain_search', 'description': 'Find a note', 'parameters': {'type': 'object'}}])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = NebiusProvider(Gateway(SETTINGS, client))
        result = await provider.respond(item)
        assert result.toolCalls[0].name == 'brain_search'
        invalid = True
        with pytest.raises(ServiceError, match='invalid text or tool calls'):
            await provider.respond(item)


@pytest.mark.parametrize('with_task', [False, True])
async def test_agent_control_proposal_is_separate_from_task_tools(with_task):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        body = json.loads(request.content)
        control = next(tool['function'] for tool in body['tools']
                       if tool['function']['name'] == 'propose_end_conversation')
        assert control['parameters']['additionalProperties'] is False
        assert control['parameters']['required'] == ['reason']
        assert 'latest actual user turn' in control['description']
        assert 'task completion' in control['description']
        calls = [{'id': 'close-1', 'type': 'function', 'function': {
            'name': 'propose_end_conversation', 'arguments': '{"reason":"The user says that is all."}',
        }}]
        if with_task:
            calls.insert(0, {'id': 'task-1', 'type': 'function', 'function': {
                'name': 'search_notes', 'arguments': '{"query":"goalpost"}',
            }})
        return httpx.Response(200, json=completion(SETTINGS.agent_model, tool_calls=calls, finish='tool_calls'))
    tools = [{'name': 'search_notes', 'description': 'Read notes', 'parameters': {'type': 'object'}}] if with_task else []
    item = RespondInput(messages=[{'role': 'user', 'content': 'That is all.'}], tools=tools)
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).respond(item)
    assert result.controlProposal.action == 'end_conversation'
    assert result.controlProposal.reason == 'The user says that is all.'
    assert [call.name for call in result.toolCalls] == (['search_notes'] if with_task else [])
    assert result.text == ''  # A proposal is valid without invented confirmation text.


@pytest.mark.parametrize('arguments', [
    '{}', '{"reason":""}', '{"reason":"  "}', '{"reason":true}',
    '{"reason":"done","action":"end_conversation"}', '{"reason":"done","execute":true}',
    '{"reason":"' + 'x' * 1001 + '"}', '[]', 'null', '{invalid',
])
async def test_agent_rejects_malformed_control_proposals(arguments):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        return httpx.Response(200, json=completion(SETTINGS.agent_model, tool_calls=[{
            'id': 'close-1', 'type': 'function', 'function': {
                'name': 'propose_end_conversation', 'arguments': arguments,
            },
        }], finish='tool_calls'))
    item = RespondInput(messages=[{'role': 'user', 'content': 'That is all.'}], tools=[])
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='invalid text or tool calls'):
            await NebiusProvider(Gateway(SETTINGS, client)).respond(item)


@pytest.mark.parametrize('duplicate_id', [False, True])
async def test_agent_rejects_multiple_or_duplicate_control_calls(duplicate_id):
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        calls = [{'id': 'one' if duplicate_id else f'call-{index}', 'type': 'function', 'function': {
            'name': 'propose_end_conversation', 'arguments': '{"reason":"The user is done."}',
        }} for index in range(2)]
        return httpx.Response(200, json=completion(SETTINGS.agent_model, tool_calls=calls, finish='tool_calls'))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='invalid text or tool calls'):
            await NebiusProvider(Gateway(SETTINGS, client)).respond(RespondInput(
                messages=[{'role': 'user', 'content': 'That is all.'}], tools=[]))


async def test_control_name_cannot_be_overridden_by_a_client_task_tool():
    def respond(_request):
        pytest.fail('Reserved name must fail before a provider request')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='reserved'):
            await NebiusProvider(Gateway(SETTINGS, client)).respond(RespondInput(
                messages=[{'role': 'user', 'content': 'Hello'}], tools=[{
                    'name': 'propose_end_conversation', 'description': 'Override', 'parameters': {},
                }]))


async def test_answer_only_omits_task_and_closure_tools_and_keeps_auto_default():
    payloads = []

    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        payloads.append(json.loads(request.content))
        return httpx.Response(200, json=completion(SETTINGS.agent_model, 'A supported final answer.'))
    item = RespondInput(messages=[{'role': 'user', 'content': 'Explain the note.'}], tools=[{
        'name': 'brain_search', 'description': 'Search notes', 'parameters': {'type': 'object'},
    }])
    assert item.responseMode == 'auto'
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = NebiusProvider(Gateway(SETTINGS, client))
        await provider.respond(item)
        final = await provider.respond(item.model_copy(update={'responseMode': 'answer_only'}))
    assert [tool['function']['name'] for tool in payloads[0]['tools']] == ['brain_search', 'propose_end_conversation']
    assert payloads[0]['tool_choice'] == 'auto'
    assert 'tools' not in payloads[1] and payloads[1]['tool_choice'] == 'none'
    assert payloads[1]['max_completion_tokens'] == 2400
    assert final.text == 'A supported final answer.' and not final.toolCalls and final.controlProposal is None


@pytest.mark.parametrize('name', ['brain_search', 'propose_end_conversation'])
async def test_answer_only_rejects_provider_tool_proposals(name):
    calls = []

    def respond(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.agent_model}]})
        return httpx.Response(200, json=completion(SETTINGS.agent_model, 'Text does not authorize tools.', [{
            'id': 'invalid', 'type': 'function', 'function': {'name': name, 'arguments': '{"reason":"done"}'},
        }]))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='invalid text or tool calls'):
            await NebiusProvider(Gateway(SETTINGS, client)).respond(RespondInput(
                messages=[{'role': 'user', 'content': 'Finish the answer.'}], tools=[], responseMode='answer_only'))
    assert calls == ['GET', 'POST']


async def test_vision_sends_private_image_bytes():
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.vision_model}]})
        body = json.loads(request.content)
        assert body['max_completion_tokens'] == 1600 and body['store'] is False
        assert body['messages'][1]['content'][1]['image_url']['url'] == 'data:image/png;base64,YWJj'
        return httpx.Response(200, json=completion(SETTINGS.vision_model, 'Visible equation: x = 2.'))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).vision(VisionInput(
            image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}, question='Read this'))
    assert result.raw == 'Visible equation: x = 2.'
    assert not result.validated and result.observations == [] and result.validationErrors


def vision_raw(**observation):
    return json.dumps({'observations': [observation], 'interpretation': ''})


def test_vision_readable_field_requires_value_and_visible_label_support():
    raw = vision_raw(field='Batch lot', status='readable', value='L-245',
                     label='Batch lot', sourceExcerpt='Batch lot: L-245')
    evidence = validate_vision(raw)
    assert evidence.validated and evidence.validationErrors == []
    assert evidence.observations[0].value == 'L-245' and evidence.raw == raw


@pytest.mark.parametrize('status', ['unreadable', 'absent'])
async def test_vision_preserves_contradictions_but_never_exposes_their_value(status):
    raw = vision_raw(field='Calibration value', status=status, value='9.31',
                     label='Calibration value', sourceExcerpt='Footer: 9.31')
    calls = []

    def respond(request):
        calls.append(request.method)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.vision_model}]})
        body = json.loads(request.content)
        instructions = body['messages'][0]['content']
        assert 'unreadable' in instructions and 'absent' in instructions and 'footer' in instructions
        return httpx.Response(200, json=completion(SETTINGS.vision_model, raw))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        evidence = await NebiusProvider(Gateway(SETTINGS, client)).vision(VisionInput(
            image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}, question='What is the calibration value?'))
    assert calls == ['GET', 'POST']  # Normalization never retries the model.
    assert evidence.raw == raw and evidence.observations[0].value is None
    assert not evidence.validated and f'{status} observation supplied a value' in evidence.validationErrors[0]


@pytest.mark.parametrize(('field', 'label', 'value', 'excerpt'), [
    ('Batch lot', 'Receipt number', 'R-619', 'Receipt number: R-619'),
    ('Batch number', 'Receipt number', 'R-619', 'Receipt number: R-619'),
    ('Calibration value', 'Calibration value', '9.31', 'Calibration value: [hidden]; Footer: 8.17'),
    ('Batch lot', 'Batch lot', 'R-619', 'Receipt number: R-619'),
    ('Temperature', 'Temperature', '5 C', 'Temperature: -5 C'),
    ('Amount', 'Amount', '12', 'Amount: 12.5'),
    ('Temperature', None, '5 C', '5 C'),
])
def test_vision_rejects_substituted_or_unsupported_field_values(field, label, value, excerpt):
    evidence = validate_vision(vision_raw(field=field, label=label, value=value, status='readable', sourceExcerpt=excerpt))
    assert not evidence.validated and evidence.validationErrors
    assert evidence.observations[0].value is None


@pytest.mark.parametrize(('value', 'excerpt'), [
    ('-5 °C', 'Temperature: -5 °C.'),
    ('12.5', 'Amount: 12.5.'),
    ('5 mL', 'Amount: 5 mL.'),
])
def test_vision_preserves_literal_quantities_units_and_signs(value, excerpt):
    label = excerpt.split(':')[0]
    evidence = validate_vision(vision_raw(field=label, label=label, value=value,
                                       status='readable', sourceExcerpt=excerpt))
    assert evidence.validated and evidence.observations[0].value == value


def test_vision_valid_absence_contains_no_usable_value():
    evidence = validate_vision(vision_raw(field='Batch lot', status='absent', value=None,
                                        label=None, sourceExcerpt=None))
    assert evidence.validated and evidence.observations[0].value is None


def test_vision_duplicate_field_disagreement_invalidates_both_observations():
    observations = [dict(field='Batch lot', status='readable', value=value,
                         label='Batch lot', sourceExcerpt=f'Batch lot: {value}') for value in ['A-1', 'B-2']]
    raw = json.dumps({'observations': observations, 'interpretation': 'Unverified interpretation is separate.'})
    evidence = validate_vision(raw)
    assert not evidence.validated and all(item.value is None for item in evidence.observations)
    assert evidence.raw == raw and evidence.interpretation == 'Unverified interpretation is separate.'


@pytest.mark.parametrize('raw', ['Plain prose with a value.', '{invalid', '{}',
                              '{"observations":[],"interpretation":"Nothing read"}',
                              '{"observations":[],"interpretation":"","validated":true}'])
def test_vision_legacy_malformed_or_model_self_validated_output_is_unvalidated(raw):
    evidence = validate_vision(raw)
    assert evidence.raw == raw and not evidence.validated and evidence.validationErrors
    assert evidence.observations == []


async def test_web_extraction_partial_failure_is_not_silenced():
    def respond(request):
        assert request.headers['authorization'] == 'Bearer fixture-tavily'
        if request.url.path == '/search':
            body = json.loads(request.content)
            assert body['max_results'] == 5 and not body['include_answer']
            assert body['search_depth'] == 'basic' and body['auto_parameters'] is False
            return httpx.Response(200, json={'results': [{'url': 'https://example.org/source', 'title': 'Source', 'content': 'Source text'}]})
        return httpx.Response(200, json={'results': [], 'failed_results': [{'url': 'https://example.org/source', 'error': 'blocked'}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        provider = TavilyProvider(Gateway(SETTINGS, client))
        assert (await provider.search('shade'))[0].url == 'https://example.org/source'
        with pytest.raises(ServiceError, match='every requested page'):
            await provider.extract(['https://example.org/source'])


async def test_provider_error_is_sanitized_and_not_retried():
    requests = []

    def respond(request):
        requests.append(request)
        return httpx.Response(429, json={'error': 'secret-key user-private-transcript'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError) as caught:
            await TavilyProvider(Gateway(SETTINGS, client)).search('retained locally')
    assert len(requests) == 1 and 'secret' not in str(caught.value) and caught.value.status == 503


async def test_excess_context_rejected_without_truncation_or_provider_call():
    def respond(_request):
        pytest.fail('oversized context must not be sent')
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        gateway = Gateway(Settings(max_context_chars=100), client)
        with pytest.raises(ServiceError) as caught:
            await JevProvider(gateway).route(RouteInput(text='x' * 200, recentContext='', activeConversation=False))
    assert caught.value.status == 413


async def test_screen_help_is_one_existing_j1_choice_and_preserves_offer_context():
    def respond(request):
        questions = json.loads(request.content)['questions']
        assert set(questions) == {'route'}
        return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': {
            'route': choice(questions['route']['criteria'], 'offer_screen_help')}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(SETTINGS, client)).route(RouteInput(
            text='What breed is this bird?', recentContext='', activeConversation=False))
    assert result.route == 'offer_help' and result.screenHelp is True
    assert result.helpAccepted is None


def visual_raw(status='observed', refs=None):
    return json.dumps(dict(observations=[], interpretation='', scene=dict(status=status,
        features=[dict(id='f1', description='Red breast, brown wings', region='center')],
        hypotheses=[dict(label='Possibly a robin', featureIds=refs or ['f1'], confidence='medium')],
        limitation='Location would help.')))


def test_visual_identification_has_feature_support_without_printed_labels():
    evidence = validate_vision(visual_raw())
    assert evidence.validated and evidence.scene.hypotheses[0].label == 'Possibly a robin'
    assert evidence.observations == []


@pytest.mark.parametrize('status,refs', [('absent', None), ('unclear', None), ('observed', ['missing'])])
def test_visual_contradictions_withhold_hypotheses_preserve_raw(status, refs):
    raw = visual_raw(status, refs)
    evidence = validate_vision(raw)
    assert evidence.scene.hypotheses == [] and not evidence.validated and evidence.raw == raw


def test_scene_only_response_does_not_need_unused_ocr_fields():
    raw = json.dumps({'scene': json.loads(visual_raw())['scene']})
    evidence = validate_vision(raw)
    assert evidence.validated and evidence.scene.hypotheses[0].label == 'Possibly a robin'


def test_partial_ocr_contradiction_is_withheld_without_losing_readable_neighbor():
    raw = json.dumps(dict(observations=[
        dict(field='Container',status='readable',value='PV-9',label='Container',sourceExcerpt='Container: PV-9'),
        dict(field='Volume',status='readable',value='175 mL',label='Volume',sourceExcerpt='Volume: 175 mL')],
        interpretation='The container identifier is partially obscured. The volume is clear.',
        scene=json.loads(visual_raw())['scene']))
    evidence = validate_vision(raw)
    assert evidence.observations[0].value is None and evidence.observations[1].value == '175 mL'
    assert evidence.scene is None and evidence.raw == raw and not evidence.validated


def test_requested_ocr_mode_rejects_scene_only_output():
    evidence = validate_vision(visual_raw(), 'ocr')
    assert evidence.scene is None and not evidence.validated
    assert 'OCR mode' in evidence.validationErrors[0]


async def test_visual_mode_keeps_image_question_and_returns_scene():
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': SETTINGS.vision_model}]})
        body = json.loads(request.content)
        assert 'Requested analysis mode: visual.' in body['messages'][0]['content']
        assert body['messages'][1]['content'][0]['text'] == 'Original request: What is this bird? Yes, notes only.'
        assert body['messages'][1]['content'][1]['image_url']['url'] == 'data:image/png;base64,YWJj'
        return httpx.Response(200, json=completion(SETTINGS.vision_model,visual_raw()))
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await NebiusProvider(Gateway(SETTINGS, client)).vision(VisionInput(
            image={'mimeType':'image/png','dataBase64':'YWJj'},question='Original request: What is this bird? Yes, notes only.',mode='visual'))
    assert result.validated and result.scene.hypotheses
