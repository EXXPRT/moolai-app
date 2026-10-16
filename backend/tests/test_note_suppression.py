"""J1 identifies intent; source scope and the action threshold stay in the host."""
import json
import httpx
import pytest
from pydantic import ValidationError
from moolai_backend.providers import Gateway, JevProvider
from moolai_backend.schemas import BrainRecord, RouteInput
from moolai_backend.settings import Settings


@pytest.mark.parametrize('active', [False, True])
@pytest.mark.parametrize('text,selected,confidence', [
    ("Don't save that.", 'suppress_note', .94),
    ("Don't save that.", 'suppress_note', .61),
    ('The title is "don\'t save that".', 'continue_agent', .92),
    ('We should discuss the command "do not keep this note".', 'dictate', .92),
])
async def test_same_j1_gate_exposes_suppression_in_both_states_without_executing_it(active, text, selected, confidence):
    if selected in ('continue_agent', 'dictate'):
        selected = 'continue_agent' if active else 'dictate'
    requests = []
    settings = Settings(typesafe_api_key='fixture')
    def respond(request):
        body = json.loads(request.content); requests.append(body)
        criteria = body['questions']['route']['criteria']
        assert 'suppress_note' in criteria
        assert 'quoted' in criteria['suppress_note'] and 'transcript' in criteria['suppress_note']
        answers = {'route': {'type': 'choice', 'choice': selected, 'confidence': confidence,
                            'probabilities': {name: float(name == selected) for name in criteria}}}
        if 'substantive_content' in body['questions']:
            answers['substantive_content'] = {'type': 'noul', 'noul': 0}
        return httpx.Response(200, json={'model': settings.jev_model, 'answers': answers})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(settings, client)).route(RouteInput(text=text, recentContext='Current thought is retained.', activeConversation=active))
    assert result.route == selected and result.confidence == confidence
    assert len(requests) == 1 and json.loads(requests[0]['state'])['latestUserUtterance'] == text


@pytest.mark.parametrize('text,selected', [('Yes.', 'suppress_note'), ('No, keep the note.', 'no_action'), ('The other thought.', 'unclear')])
async def test_pending_suppression_is_a_scoped_reply_not_a_start_or_close(text, selected):
    settings = Settings(typesafe_api_key='fixture')
    pending = {'kind': 'note_suppression', 'proposalId': 'proposal-1', 'question': 'Do not keep this growing note and the new speech?'}
    def respond(request):
        body = json.loads(request.content)
        assert json.loads(body['state'])['pendingOffer'] == pending
        assert set(body['questions']) == {'route'}
        assert set(body['questions']['route']['criteria']) == {'suppress_note', 'no_action', 'unclear'}
        return httpx.Response(200, json={'model': settings.jev_model, 'answers': {'route': {
            'type': 'choice', 'choice': selected, 'confidence': .95,
            'probabilities': {name: float(name == selected) for name in body['questions']['route']['criteria']}}}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(settings, client)).route(RouteInput(text=text, recentContext='', activeConversation=True, pendingOffer=pending))
    assert result.route == selected


def test_suppression_metadata_is_backward_compatible_and_not_a_deletion(record):
    original = record.model_dump(exclude_none=True)
    assert BrainRecord.model_validate(original).suppressed is None
    metadata = {'at': '2026-10-10T15:00:00Z', 'operationId': 'suppression-1', 'sessionId': 'session-1'}
    restored = BrainRecord.model_validate({**original, 'suppressed': metadata})
    assert restored.suppressed.model_dump() == metadata
    assert restored.segments == record.segments and restored.archived is False
    with pytest.raises(ValidationError):
        BrainRecord.model_validate({**original, 'suppressed': {**metadata, 'deleteSource': True}})


async def test_suppression_during_pending_work_is_not_reinterpreted_as_closure():
    settings = Settings(typesafe_api_key='fixture')
    def respond(request):
        questions = json.loads(request.content)['questions']
        return httpx.Response(200, json={'model': settings.jev_model, 'answers': {
            'route': {'type': 'choice', 'choice': 'suppress_note', 'confidence': .93,
                      'probabilities': {name: float(name == 'suppress_note') for name in questions['route']['criteria']}},
            'end_action': {'type': 'choice', 'choice': 'unclear', 'confidence': .4,
                           'probabilities': {name: float(name == 'unclear') for name in questions['end_action']['criteria']}}}})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        result = await JevProvider(Gateway(settings, client)).route(RouteInput(text="Don't save that.",
            recentContext='', activeConversation=True, pendingOffer={'kind': 'end_work'}))
    assert result.route == 'suppress_note' and result.confidence == .93 and result.endAction is None
