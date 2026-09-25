import httpx
import pytest

from moolai_backend.app import create_app
from moolai_backend.settings import Settings


def no_network(_request):
    pytest.fail('API contract test unexpectedly called a provider')


async def test_auth_health_unconfigured_models_and_no_secrets():
    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as upstream:
        app = create_app(Settings(backend_token='local-test-token'), http_client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            assert (await client.get('/health')).json() == {'status': 'ok', 'service': 'moolai-backend'}
            assert (await client.get('/v1/models')).status_code == 401
            result = await client.get('/v1/models', headers={'Authorization': 'Bearer local-test-token'})
            assert result.status_code == 200
            assert result.json()['nebius']['verified'] is False
            assert 'local-test-token' not in result.text
            assert (await client.get('/docs')).status_code == 404


async def test_unconfigured_server_fails_closed():
    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as upstream:
        app = create_app(Settings(), http_client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test') as client:
            response = await client.post('/v1/route', json={'text': 'hello', 'recentContext': '', 'activeConversation': False})
            assert response.status_code == 503


async def test_accept_wire_and_empty_connections(record):
    class FixtureStore:
        async def accept(self, submitted, operation):
            assert submitted == record and operation == 'op-1'
            return submitted.revision

    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as upstream:
        app = create_app(Settings(backend_token='token'), http_client=upstream, store=FixtureStore())
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'Authorization': 'Bearer token'}) as client:
            response = await client.post('/v1/records/accept', json={'record': record.model_dump(exclude_none=True), 'operationId': 'op-1'})
            assert response.status_code == 200 and response.json() == {'revision': 3}
            response = await client.post('/v1/connect', json={'record': record.model_dump(exclude_none=True), 'candidates': []})
            assert response.status_code == 200 and response.json() == {}


async def test_validation_redacts_input_and_blocks_local_extraction():
    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as upstream:
        app = create_app(Settings(backend_token='token'), http_client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'Authorization': 'Bearer token'}) as client:
            for url in ['file:///secret', 'http://127.0.0.1/private', 'http://localhost/private', 'https://user:password@example.org']:
                response = await client.post('/v1/extract', json={'urls': [url]})
                assert response.status_code == 422 and url not in response.text
            response = await client.post('/v1/vision', json={'image': {'mimeType': 'image/png', 'dataBase64': 'private-secret-is-not-base64'}, 'question': 'read'})
            assert response.status_code == 422 and 'private-secret' not in response.text


async def test_missing_key_is_visible_without_network():
    async with httpx.AsyncClient(transport=httpx.MockTransport(no_network)) as upstream:
        app = create_app(Settings(backend_token='token'), http_client=upstream)
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='http://test', headers={'Authorization': 'Bearer token'}) as client:
            response = await client.post('/v1/search', json={'query': 'retained thought'})
            assert response.status_code == 503 and response.json()['detail'] == 'Tavily is not configured'
