"""Output exhaustion retains source and never causes a second paid dispatch."""
import json

import httpx
import pytest

from moolai_backend.providers import CompletionLimitError, Gateway, NebiusProvider
from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings


@pytest.mark.parametrize('field', ['content', 'reasoning_content'])
@pytest.mark.parametrize('repeated', [False, True])
async def test_exhaustion_diagnosis_distinguishes_unknown_token_runs(field, repeated, caplog):
    settings = Settings(nebius_api_key='PRIVATE_KEY', agent_max_tokens=4096)
    messages = [{'role': 'user', 'content': 'PRIVATE_REQUEST'}]
    output = 'PRIVATE_OUTPUT' + ('<unk>' * 64 if repeated else ' unfinished reasoning')
    requests = []

    def transport(request):
        requests.append(request)
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        return httpx.Response(200, json={
            'model': settings.agent_model,
            'choices': [{'finish_reason': 'length', 'message': {field: output}}],
            'usage': {'completion_tokens': 4096, 'completion_tokens_details': {'reasoning_tokens': 4096}},
        })

    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        with pytest.raises(CompletionLimitError) as error:
            await NebiusProvider(Gateway(settings, client)).respond(RespondInput(messages=messages, tools=[]))
    assert error.value.status == 422
    assert ('repeated unknown tokens' in str(error.value)) is repeated
    assert 'Explicit retry required' in str(error.value)
    assert [request.method for request in requests] == ['GET', 'POST']
    assert messages == [{'role': 'user', 'content': 'PRIVATE_REQUEST'}]
    payload = json.loads(requests[-1].content)
    assert payload['max_completion_tokens'] == 4096
    assert 'reasoning_effort' not in payload and 'chat_template_kwargs' not in payload
    assert f'repeated_unknown_tokens={repeated}' in caplog.text
    assert all(text not in caplog.text + str(error.value) for text in ['PRIVATE_OUTPUT', 'PRIVATE_REQUEST', 'PRIVATE_KEY'])


async def test_complete_quoted_token_example_is_content_not_a_generation_failure():
    settings = Settings(nebius_api_key='fixture')
    text = 'The log contains this literal token sequence:\n```text\n' + '<unk>' * 40 + '\n```'
    def transport(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.agent_model}]})
        return httpx.Response(200, json={'model': settings.agent_model, 'choices': [{
            'finish_reason': 'stop', 'message': {'content': text}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(transport)) as client:
        result = await NebiusProvider(Gateway(settings, client)).respond(RespondInput(
            messages=[{'role': 'user', 'content': 'Quote the diagnostic token sequence exactly.'}], tools=[]))
    assert result.text == text
