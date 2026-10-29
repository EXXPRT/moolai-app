"""The demo gateway end to end: dispatch, guards, metering and settlement, sessions, speech, and every
fail-closed path. All outbound traffic reaches an httpx.MockTransport; nothing touches the network."""
import asyncio
import base64
import hashlib
import inspect
import json
import math
import struct
import uuid
from dataclasses import replace
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

import httpx
import pytest

from moolai_backend import demo_gateway
from moolai_backend.demo_counters import (
    MINT, RESERVE, SETTLE, URLS, Caps, Keys, MemoryCounters, Reservation, utc_day, utc_hour,
)
from moolai_backend.demo_gateway import (
    DEMO_OVERRIDES, FLOOR_MICRO, PRICES_NANO, WORKSHEET_SHA256, DemoConfig, Meter, MeteredClient, ProviderCall,
    Session, create_demo_app, ip_key, mint_token, recover_path, reserve_micro, speech_micro, transcribe_micro,
    url_key, verify_token,
)
from moolai_backend.settings import Settings

NOW = datetime(2026, 10, 29, 12, 30, tzinfo=timezone.utc).timestamp()
DAY = utc_day(NOW)
FIXTURES = Path(__file__).resolve().parents[2] / 'experiments' / 'fixtures' / 'full-workflow-ocr'
WORKSHEET = (FIXTURES / '02-math-table.png').read_bytes()
FOREIGN = (FIXTURES / '01-clear-text.png').read_bytes()
SECRET = 'demo-session-secret-' + 'x' * 44
TURNSTILE_SECRET = '0x4AAAAAAA-turnstile-secret-value'
UPSTASH_TOKEN = 'upstash-secret-value'
PROVIDER_KEYS = {'NEBIUS_API_KEY': 'nebius-secret-value', 'TYPESAFE_API_KEY': 'typesafe-secret-value',
                 'TAVILY_API_KEY': 'tavily-secret-value', 'OPENAI_API_KEY': 'openai-secret-value'}
BASE_ENV = {**PROVIDER_KEYS, 'DEMO_ENABLED': 'on', 'DEMO_SESSION_SECRET': SECRET,
            'TURNSTILE_SITE_KEY': '0x4AAAAAAA-site-key', 'TURNSTILE_SECRET_KEY': TURNSTILE_SECRET,
            'DEMO_ALLOWED_HOSTNAMES': 'demo.test'}
VERCEL_ENV = {**BASE_ENV, 'DEMO_ALLOWED_HOSTNAMES': None, 'VERCEL': '1', 'VERCEL_ENV': 'production',
              'VERCEL_PROJECT_PRODUCTION_URL': 'moolai-app.vercel.app', 'KV_REST_API_URL': 'https://kv.upstash.test',
              'KV_REST_API_TOKEN': UPSTASH_TOKEN}
SETTINGS = Settings()
DEMO_SETTINGS = replace(SETTINGS, **DEMO_OVERRIDES)
ULTRA, LIGHTNING, OCR = SETTINGS.agent_model, SETTINGS.summary_model, SETTINGS.ocr_model
NEBIUS = 'api.tokenfactory.nebius.com'
PROVIDER_HOSTS = (NEBIUS, 'api.typesafe.ai', 'api.tavily.com', 'api.openai.com')
SUMMARY = json.dumps({'title': 'Garden shade', 'summary': 'The garden needs more shade.', 'topicSuggestion': None,
                      'topicSuggestions': []})
LONG_ANSWER = '## Results\nThe corrected quantity is 12 mg.\n\n## Limits\nIt remains a proposal.'
SPOKEN = 'The corrected quantity is 12 milligrams.'
SEARCH_RESULTS = ['https://Example.org/osmosis?part=2', 'https://other.example/dilution']
RESPOND = {'messages': [{'role': 'user', 'content': 'Explain the corrected quantity.'}], 'tools': []}
ROUTE = {'text': 'Osmosis moves water toward more solute.', 'recentContext': '', 'activeConversation': False}
OMIT = object()


class Clock:
    def __init__(self, now: float = NOW):
        self.now = now

    def __call__(self) -> float:
        return self.now


def micro(nano: int) -> int:
    return -(-nano // 1_000)


def priced(model: str, tokens_in: int, tokens_out: int) -> int:
    return micro(tokens_in * PRICES_NANO[model][0] + tokens_out * PRICES_NANO[model][1])


def worst(model: str, sent: int, tokens_out: int, image: bool = False) -> int:
    return priced(model, math.ceil(sent * 5 / 4) + (4_096 if image else 0), tokens_out)


def completion(model, content, usage=(20_000, 1_000), finish='stop'):
    body = {'model': model, 'choices': [{'finish_reason': finish, 'message': {'content': content}}]}
    if isinstance(usage, tuple):
        body['usage'] = {'prompt_tokens': usage[0], 'completion_tokens': usage[1], 'total_tokens': sum(usage)}
    elif usage is not OMIT:
        body['usage'] = usage
    return httpx.Response(200, json=body)


def jev(request):
    answers = {}
    for name, question in json.loads(request.content)['questions'].items():
        if question['type'] == 'noul':
            answers[name] = {'type': 'noul', 'noul': 0.4}
        else:
            options = list(question['criteria'])
            answers[name] = {'type': 'choice', 'choice': options[0], 'confidence': 0.9,
                             'probabilities': {option: float(option == options[0]) for option in options}}
    return httpx.Response(200, json={'model': SETTINGS.jev_model, 'answers': answers})


def tavily(request):
    if request.url.path == '/search':
        return httpx.Response(200, json={'results': [{'url': url, 'title': 'Source', 'content': 'Osmosis.'}
                                                     for url in SEARCH_RESULTS]})
    return httpx.Response(200, json={'results': [{'url': url, 'title': 'Page', 'raw_content': 'Full page.'}
                                                 for url in json.loads(request.content)['urls']]})


def openai(request):
    if request.url.path == '/v1/audio/transcriptions':
        return httpx.Response(200, json={'text': 'Osmosis moves water.'})
    return httpx.Response(200, content=b'ID3-fake-mp3')


PASS = {'success': True, 'action': 'moolai-demo', 'hostname': 'demo.test', 'error-codes': []}


class Turnstile:
    def __init__(self, *replies):
        self.requests: list[dict] = []
        self.replies = list(replies)

    def __call__(self, request):
        self.requests.append(json.loads(request.content))
        reply = self.replies.pop(0) if self.replies else PASS
        if isinstance(reply, Exception):
            raise reply
        return reply if isinstance(reply, httpx.Response) else httpx.Response(200, json=reply)


def command_kind(command: list[str]) -> str:
    if command[0] == 'EVAL':
        return {RESERVE: 'RESERVE', SETTLE: 'SETTLE', MINT: 'MINT', URLS: 'URLS'}[command[1]]
    return command[0]


class Upstash:
    """Enough of Upstash's REST API for the gateway: fixed replies, scripted failures, every command kept."""

    def __init__(self, status=(None, None, None, None)):
        self.commands: list[list[str]] = []
        self.status = list(status)
        self.fail: dict[str, list] = {}

    def __call__(self, request):
        assert request.headers['authorization'] == f'Bearer {UPSTASH_TOKEN}'
        command = json.loads(request.content)
        self.commands.append(command)
        kind = command_kind(command)
        if self.fail.get(kind):
            failure = self.fail[kind].pop(0)
            if isinstance(failure, Exception):
                raise failure
            return failure
        result = {'MGET': self.status, 'PING': 'PONG', 'RESERVE': [1, 1], 'SETTLE': 1, 'MINT': 1, 'URLS': 1,
                  'SET': 'OK', 'SMISMEMBER': [1] * (len(command) - 2)}[kind]
        return httpx.Response(200, json={'result': result})

    def kinds(self) -> list[str]:
        return [command_kind(command) for command in self.commands]


class Upstream:
    """Every outbound request, answered per host."""

    def __init__(self, chat=None):
        self.requests: list[httpx.Request] = []
        self.chat = chat or (lambda request, payload: completion(payload['model'], SUMMARY))
        self.handlers = {NEBIUS: self.nebius, 'api.typesafe.ai': jev, 'api.tavily.com': tavily,
                         'api.openai.com': openai, 'challenges.cloudflare.com': Turnstile()}

    async def __call__(self, request):
        self.requests.append(request)
        handler = self.handlers.get(request.url.host)
        if handler is None:
            return httpx.Response(599, text='unexpected host')
        result = handler(request)
        return await result if inspect.isawaitable(result) else result

    def nebius(self, request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': model} for model in PRICES_NANO]})
        return self.chat(request, json.loads(request.content))

    def to(self, host, path=None):
        return [request for request in self.requests if request.url.host == host
                and (path is None or request.url.path == path)]

    @property
    def providers(self):
        return [request for request in self.requests if request.url.host in PROVIDER_HOSTS]

    @property
    def chats(self):
        return [request for request in self.to(NEBIUS) if request.method == 'POST']


class Counting:
    """Counts the counter calls the gateway makes."""

    def __init__(self, inner):
        self.inner, self.keys, self.calls = inner, inner.keys, []

    @property
    def values(self):
        return self.inner.values

    def selftest(self):
        return self.inner.selftest()

    def __getattr__(self, name):
        method = getattr(self.inner, name)

        async def counted(*args, **kwargs):
            self.calls.append(name)
            return await method(*args, **kwargs)
        return counted


class Demo:
    def __init__(self, env=None, *, counters='memory', local=False, upstream=None, clock=None, base=BASE_ENV):
        self.clock = clock or Clock()
        self.upstream = upstream or Upstream()
        environment = {name: value for name, value in {**base, **(env or {})}.items() if value is not None}
        self.counters = MemoryCounters(Keys('local'), clock=self.clock) if counters == 'memory' else counters
        self.app = create_demo_app(environment, transport=httpx.MockTransport(self.upstream), counters=self.counters,
                                   local=local, clock=self.clock)
        self.token = self.mint()

    def mint(self, now=None) -> str:
        return mint_token(SECRET.encode(), self.clock() if now is None else now)[0]

    async def __aenter__(self):
        self.client = httpx.AsyncClient(transport=httpx.ASGITransport(app=self.app), base_url='https://demo.test')
        return self

    async def __aexit__(self, *_):
        await self.client.aclose()

    def auth(self, token=None) -> dict[str, str]:
        return {'Authorization': f'Bearer {token or self.token}'}

    async def call(self, name, body, *, token=None, **options):
        return await self.client.post(f'/api/v1/{name}', json=body, headers=self.auth(token), **options)

    def spend(self, token=None) -> int:
        sid = (token or self.token).split('.')[1]
        return (self.counters.values.get(self.counters.keys.session(sid)) or {}).get('spend', 0)

    async def totals(self) -> tuple[int, int]:
        status = await self.counters.inner.status(DAY) if isinstance(self.counters, Counting) else \
            await self.counters.status(DAY)
        return status.total, status.day


def vercel_demo(env=None, *, upstash=None, turnstile=None, **options) -> Demo:
    upstream = Upstream()
    upstream.handlers['kv.upstash.test'] = upstash or Upstash()
    upstream.handlers['challenges.cloudflare.com'] = turnstile or Turnstile({**PASS, 'hostname': 'moolai-app.vercel.app'})
    demo = Demo(env, counters=options.pop('counters', None), upstream=upstream, base=VERCEL_ENV, **options)
    demo.upstash = upstream.handlers['kv.upstash.test']
    return demo


async def asgi(app, method, path, *, query=b'', headers=(), body=b'', messages=None, client=('203.0.113.9', 4000)):
    """One raw ASGI request, for paths and headers httpx would normalise or refuse to send."""
    scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': method, 'scheme': 'https',
             'path': path, 'raw_path': path.encode(), 'query_string': query, 'root_path': '',
             'headers': [(name.lower(), value) for name, value in headers], 'client': client,
             'server': ('demo.test', 443)}
    incoming = list(messages if messages is not None else [{'type': 'http.request', 'body': body, 'more_body': False}])
    sent = []

    async def receive():
        if incoming:
            return incoming.pop(0)
        await asyncio.Event().wait()

    async def send(message):
        sent.append(message)
    await app(scope, receive, send)
    start = next(message for message in sent if message['type'] == 'http.response.start')
    return (start['status'], dict(start['headers']),
            b''.join(message.get('body', b'') for message in sent if message['type'] == 'http.response.body'))


def json_headers(token):
    return [(b'authorization', f'Bearer {token}'.encode()), (b'content-type', b'application/json')]


def wav(seconds: float) -> bytes:
    data = b'\x01\x02' * round(seconds * 16_000)
    fmt = b'fmt ' + struct.pack('<IHHIIHH', 16, 1, 1, 16_000, 32_000, 2, 16)
    chunks = fmt + b'data' + struct.pack('<I', len(data)) + data
    return b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks


def image_body(data: bytes, mime='image/png') -> dict:
    return {'image': {'mimeType': mime, 'dataBase64': base64.b64encode(data).decode()}, 'question': 'What is V2?',
            'mode': 'ocr'}


# ---- 1, 2: dispatch ----

@pytest.mark.parametrize('path,query', [
    ('/api/v1/route', b''),
    ('/api', b'__path=v1/route'),
    ('/api/index', b'__path=v1/route'),
    ('/api', b'from=page&__path=v1%2Froute'),
])
async def test_original_and_rewritten_paths_reach_the_guard(path, query):
    demo = Demo()
    status, _, body = await asgi(demo.app, 'POST', path, query=query,
                                 headers=[(b'content-type', b'application/json')], body=b'{}')
    assert (status, json.loads(body)) == (401, {'detail': 'invalid_session'})
    status, _, body = await asgi(demo.app, 'POST', path, query=query, headers=json_headers(demo.token),
                                 body=json.dumps(ROUTE).encode())
    assert status == 200 and json.loads(body)['route'] == 'start_agent'


@pytest.mark.parametrize('path,query', [
    ('/api/v1/../v1/route', b''), ('/api/v1/%2e%2e/v1/route', b''), ('/api//v1/route', b''), ('/api/v1/route/', b''),
    ('/API/v1/route', b''), ('/api', b''), ('/api/index', b''), ('/api', b'__path=v1/../v1/route'),
    ('/api', b'__path=v1/%2e%2e/route'), ('/api', b'__path=v1//route'), ('/api', b'__path=/v1/route'),
    ('/api', b'__path=V1/route'), ('/api', b'__path=v1/route&__path=v1/tag'), ('/api', b'__path=' + b'a/' * 32 + b'b'),
    ('/api/index.py', b'__path=v1/route'),
])
async def test_traversal_and_malformed_paths_are_404(path, query):
    demo = Demo()
    status, _, body = await asgi(demo.app, 'POST', path, query=query, headers=json_headers(demo.token), body=b'{}')
    assert (status, json.loads(body)) == (404, {'detail': 'not_found'})
    assert demo.upstream.requests == [] and demo.counters.values == {}


@pytest.mark.parametrize('method,path', [
    ('GET', '/api/v1/models'), ('POST', '/api/v1/models'), ('POST', '/api/v1/records/accept'),
    ('POST', '/api/v1/plan-thoughts'), ('GET', '/api/v1/health'), ('GET', '/health'), ('POST', '/v1/route'),
    ('GET', '/docs'), ('GET', '/api/docs'), ('GET', '/api/openapi.json'), ('GET', '/'),
])
async def test_unexposed_routes_are_404_with_no_counter_or_provider_traffic(method, path):
    async with Demo() as demo:
        response = await demo.client.request(method, path, headers=demo.auth(), json={})
    assert response.status_code == 404 and response.json() == {'detail': 'not_found'}
    assert demo.upstream.requests == [] and demo.counters.values == {}


@pytest.mark.parametrize('method,path,allow', [
    ('GET', '/api/v1/route', 'POST'), ('PUT', '/api/v1/respond', 'POST'), ('GET', '/api/v1/speech', 'POST'),
    ('GET', '/api/demo/session', 'POST'), ('POST', '/api/demo/config', 'GET'), ('HEAD', '/api/health', 'GET'),
])
async def test_the_wrong_method_is_405(method, path, allow):
    async with Demo() as demo:
        response = await demo.client.request(method, path, headers=demo.auth())
    assert response.status_code == 405 and response.headers['allow'] == allow
    assert demo.upstream.requests == [] and demo.counters.values == {}


def test_recover_path_reports_how_the_path_arrived():
    assert recover_path({'path': '/api/v1/route', 'query_string': b'__path=v1/tag'}) == ('/api/v1/route', 'original')
    assert recover_path({'path': '/api', 'query_string': b'__path=demo/config'}) == ('/api/demo/config', 'rewrite')
    assert recover_path({'path': '/api/index', 'query_string': b'a=1&__path=v1/speech'}) == ('/api/v1/speech', 'rewrite')
    assert recover_path({'path': '/api', 'query_string': b'__path=v1/route?x'}) is None


async def test_health_needs_no_session_and_makes_no_calls():
    async with Demo() as demo:
        response = await demo.client.get('/api/health')
    assert response.json() == {'status': 'ok', 'service': 'moolai-demo-gateway'}
    assert response.headers['cache-control'] == 'no-store' and demo.upstream.requests == []


# ---- 3, 4: sessions on guarded calls ----

def test_tokens_have_the_fixed_shape_and_verify():
    token, exp = mint_token(SECRET.encode(), NOW)
    version, sid, expiry, mac = token.split('.')
    assert (version, len(sid), expiry, len(mac)) == ('v1', 22, str(int(NOW) + 7_200), 43) and exp == int(NOW) + 7_200
    assert verify_token([(b'authorization', f'Bearer {token}'.encode())], SECRET.encode(), NOW) == Session(sid, exp)
    # The signature covers the expiry exactly as sent, so a signed zero-padded one is still checked as itself.
    padded = f'v1.{sid}.0000000001.{demo_gateway._signature(SECRET.encode(), sid, "0000000001")}'
    assert verify_token([(b'authorization', f'Bearer {padded}'.encode())], SECRET.encode(), NOW) == 'expired'


def bad_headers(token: str) -> list[tuple[str, list[tuple[bytes, bytes]], str]]:
    version, sid, exp, mac = token.split('.')
    other = mint_token(b'another-secret-' + b'y' * 40, NOW)[0]
    flipped = mac[:-2] + ('A' if mac[-2] != 'A' else 'B') + mac[-1]
    expired = mint_token(SECRET.encode(), NOW - 7_201)[0]
    future = mint_token(SECRET.encode(), NOW + 120)[0]
    auth = b'authorization'
    return [
        ('missing', [], 'invalid_session'),
        ('non-ascii', [(auth, b'Bearer \xe9')], 'invalid_session'),
        ('two headers', [(auth, f'Bearer {token}'.encode())] * 2, 'invalid_session'),
        ('tampered mac', [(auth, f'Bearer {version}.{sid}.{exp}.{flipped}'.encode())], 'invalid_session'),
        ('tampered expiry', [(auth, f'Bearer {version}.{sid}.{int(exp) + 1}.{mac}'.encode())], 'invalid_session'),
        ('tampered sid', [(auth, f'Bearer {version}.{sid[::-1]}.{exp}.{mac}'.encode())], 'invalid_session'),
        ('another secret', [(auth, f'Bearer {other}'.encode())], 'invalid_session'),
        ('expired', [(auth, f'Bearer {expired}'.encode())], 'session_expired'),
        ('far future', [(auth, f'Bearer {future}'.encode())], 'invalid_session'),
        ('lowercase scheme', [(auth, f'bearer {token}'.encode())], 'invalid_session'),
        ('trailing newline', [(auth, f'Bearer {token}\n'.encode())], 'invalid_session'),
        ('trailing text', [(auth, f'Bearer {token} x'.encode())], 'invalid_session'),
        ('oversized', [(auth, f'Bearer {token}'.encode() + b' ' * 200)], 'invalid_session'),
        ('v2', [(auth, f'Bearer v2.{sid}.{exp}.{mac}'.encode())], 'invalid_session'),
    ]


async def test_every_bad_session_header_is_401_and_never_500():
    demo = Demo()
    for name, headers, detail in bad_headers(demo.token):
        for path in ('/api/v1/route', '/api/v1/transcribe', '/api/v1/speech'):
            status, _, body = await asgi(demo.app, 'POST', path, body=json.dumps(ROUTE).encode(),
                                         headers=headers + [(b'content-type', b'application/json')])
            assert (status, json.loads(body)) == (401, {'detail': detail}), (name, path)
    assert demo.upstream.requests == [] and demo.counters.values == {}


async def test_the_inner_app_sees_exactly_one_authorization_the_internal_token(record):
    demo = Demo()
    seen = []
    inner = demo.app.inner

    async def spy(scope, receive, send):
        seen.append(scope)
        await inner(scope, receive, send)
    demo.app.inner = spy
    body = json.dumps({'record': record.model_dump(exclude_none=True), 'candidates': []}).encode()
    status, _, response = await asgi(demo.app, 'POST', '/api', query=b'__path=v1/connect&x=1', body=body, headers=[
        *json_headers(demo.token), (b'content-length', b'999'), (b'transfer-encoding', b'chunked'),
        (b'content-encoding', b'identity'), (b'x-visitor', b'kept')])
    assert (status, response) == (200, b'{}')
    (scope,) = seen
    names = [name for name, _ in scope['headers']]
    assert [value for name, value in scope['headers'] if name == b'authorization'] == [
        f'Bearer {demo.app.internal_token}'.encode()]
    assert [value for name, value in scope['headers'] if name == b'content-length'] == [str(len(body)).encode()]
    assert b'transfer-encoding' not in names and b'content-encoding' not in names and b'x-visitor' in names
    assert (scope['path'], scope['raw_path'], scope['root_path'], scope['query_string']) == (
        '/v1/connect', b'/v1/connect', '', b'')
    assert demo.app.internal_token not in demo.token and len(demo.app.internal_token) >= 32


# ---- 5, 6: refusals and limits ----

async def chunks(data: bytes):
    for start in range(0, len(data), 50_000):
        yield data[start:start + 50_000]


async def test_refused_requests_reserve_nothing_and_send_nothing():
    async with Demo() as demo:
        oversized = b'{"text": "' + b'x' * 200_001 + b'"}'
        declared = await demo.client.post('/api/v1/respond', content=oversized,
                                          headers={**demo.auth(), 'content-type': 'application/json'})
        chunked = await demo.client.post('/api/v1/respond', content=chunks(oversized),
                                         headers={**demo.auth(), 'content-type': 'application/json'})
        wrong_type = await demo.client.post('/api/v1/route', content=json.dumps(ROUTE),
                                            headers={**demo.auth(), 'content-type': 'text/plain'})
        no_type = await demo.client.post('/api/v1/route', content=json.dumps(ROUTE), headers=demo.auth())
        malformed = await demo.client.post('/api/v1/route', content=b'{"text": ',
                                           headers={**demo.auth(), 'content-type': 'application/json'})
        not_object = await demo.client.post('/api/v1/route', content=b'["text"]',
                                            headers={**demo.auth(), 'content-type': 'application/json'})
        deep = await demo.client.post('/api/v1/route', content=b'[' * 100_000,
                                      headers={**demo.auth(), 'content-type': 'application/json'})
        not_utf8 = await demo.client.post('/api/v1/route', content=b'{"text": "\xff"}',
                                          headers={**demo.auth(), 'content-type': 'application/json'})
    assert 'content-length' not in chunked.request.headers
    assert [(r.status_code, r.json()['detail']) for r in (declared, chunked, wrong_type, no_type, malformed, not_object,
                                                          deep, not_utf8)] == [
        (413, 'body_too_large'), (413, 'body_too_large'), (415, 'unsupported_media_type'),
        (415, 'unsupported_media_type'), (422, 'invalid_json'), (422, 'invalid_json'), (422, 'invalid_json'),
        (422, 'invalid_json')]
    assert demo.upstream.requests == [] and demo.counters.values == {}


async def test_the_session_quota_is_429_and_sends_nothing_more():
    async with Demo() as demo:
        for _ in range(6):
            assert (await demo.call('search', {'query': 'osmosis'})).status_code == 200
        refused = await demo.call('search', {'query': 'osmosis'})
        other = await demo.call('search', {'query': 'osmosis'}, token=demo.mint())
    assert (refused.status_code, refused.json()) == (429, {'detail': 'session_limit'})
    assert other.status_code == 200 and len(demo.upstream.to('api.tavily.com')) == 7


async def test_the_session_budget_is_429_before_any_provider_call():
    async with Demo({'DEMO_SESSION_BUDGET_USD': '0.03'}) as demo:
        refused = await demo.call('respond', RESPOND)
    assert reserve_micro('respond', len(json.dumps(RESPOND)), DEMO_SETTINGS, demo.app.cfg) > 30_000
    assert (refused.status_code, refused.json()) == (429, {'detail': 'session_limit'})
    assert demo.upstream.requests == [] and await demo.totals() == (0, 0)


@pytest.mark.parametrize('env,prefill,detail', [
    ({'DEMO_BUDGET_DAILY_USD': '1'}, 'spend', 'demo_budget_exhausted'),
    ({'DEMO_BUDGET_TOTAL_USD': '1'}, 'spend', 'demo_budget_exhausted'),
    ({}, 'off', 'demo_unavailable'),
])
async def test_day_total_and_kill_switch_refusals_are_503_and_cached_in_process(env, prefill, detail):
    clock = Clock()
    counters = Counting(MemoryCounters(Keys('local'), clock=clock))
    async with Demo(env, counters=counters, clock=clock) as demo:
        if prefill == 'off':
            counters.values[counters.keys.off()] = '1'
        else:
            await counters.inner.reserve(Reservation('route', 'other', DAY, 995_000), Caps(10 ** 9, 10 ** 9, 10 ** 9), 9)
        first = await demo.call('search', {'query': 'osmosis'})
        second = await demo.call('tag', {'record': {}}, token=demo.mint())
        assert [(r.status_code, r.json()) for r in (first, second)] == [(503, {'detail': detail})] * 2
        assert counters.calls == ['reserve'] and demo.upstream.requests == []
        clock.now += 31
        await demo.call('search', {'query': 'osmosis'})
        assert counters.calls == ['reserve', 'reserve']


# ---- 7: settlement ----

async def test_a_nebius_call_is_settled_from_its_usage_and_the_model_list_is_free(record):
    async with Demo() as demo:
        response = await demo.call('summarize', {'record': record.model_dump(exclude_none=True)})
    assert response.status_code == 200 and response.json()['title'] == 'Garden shade'
    assert [request.method for request in demo.upstream.to(NEBIUS)] == ['GET', 'POST']
    assert demo.spend() == priced(LIGHTNING, 20_000, 1_000) == 1_440
    assert await demo.totals() == (1_440, 1_440)


async def test_respond_settles_both_ultra_and_its_lightning_spoken_summary():
    def chat(request, payload):
        if payload['model'] == ULTRA:
            return completion(ULTRA, LONG_ANSWER, usage=(10_000, 2_000))
        return completion(LIGHTNING, json.dumps({'spokenText': SPOKEN}), usage=(3_000, 100))
    async with Demo(upstream=Upstream(chat)) as demo:
        response = await demo.call('respond', RESPOND)
    assert response.status_code == 200 and response.json()['spokenText'] == SPOKEN
    assert [json.loads(request.content)['model'] for request in demo.upstream.chats] == [ULTRA, LIGHTNING]
    assert demo.spend() == micro(10_000 * 1_000 + 2_000 * 3_000 + 3_000 * 60 + 100 * 240) == 16_204


async def test_a_422_raised_before_sending_is_refunded_to_the_floor():
    tool = {'name': 'search_notes', 'description': 'Search.', 'parameters': {'type': 'object'}}
    async with Demo() as demo:
        response = await demo.call('respond', {**RESPOND, 'tools': [tool, tool]})
    assert response.status_code == 422 and response.json()['detail'] == 'Tool names must be unique'
    assert demo.upstream.requests == [] and demo.spend() == FLOOR_MICRO and await demo.totals() == (500, 500)


async def test_a_422_after_sending_is_charged_by_its_usage():
    upstream = Upstream(lambda request, payload: completion(ULTRA, 'partial', usage=(8_000, 4_096), finish='length'))
    async with Demo(upstream=upstream) as demo:
        response = await demo.call('respond', RESPOND)
    assert response.status_code == 422 and 'output limit' in response.json()['detail']
    assert demo.spend() == priced(ULTRA, 8_000, 4_096) == 20_288


async def test_a_read_timeout_keeps_that_calls_worst_case():
    def timeout(request, payload):
        raise httpx.ReadTimeout('slow', request=request)
    async with Demo(upstream=Upstream(timeout)) as demo:
        response = await demo.call('respond', RESPOND)
    assert response.status_code == 504
    (sent,) = demo.upstream.chats
    assert demo.spend() == worst(ULTRA, len(sent.content), 4_096)
    assert demo.spend() > reserve_micro('respond', 0, DEMO_SETTINGS, demo.app.cfg) / 4


async def test_jev_is_charged_per_started_32_kb_of_what_was_sent(record):
    async with Demo() as demo:
        small = await demo.call('route', ROUTE)
        long = record.model_copy(update={'segments': [record.segments[0].model_copy(
            update={'text': 'Water moves across the membrane. ' * 1_200})]})
        token = demo.mint()
        tagged = await demo.call('tag', {'record': long.model_dump(exclude_none=True), 'topicCandidates': []},
                                 token=token)
    assert small.status_code == tagged.status_code == 200
    sent = len(demo.upstream.to('api.typesafe.ai')[-1].content)
    assert demo.spend() == 10_000 and sent > 32_768
    assert demo.spend(token) == 10_000 * math.ceil(sent / 32_768)


async def test_jev_price_follows_its_variable():
    async with Demo({'DEMO_JEV_CALL_USD': '0.002'}) as demo:
        assert (await demo.call('route', ROUTE)).status_code == 200
    assert demo.spend() == 2_000


async def test_an_overrun_raises_the_counters_past_the_reservation(record):
    upstream = Upstream(lambda request, payload: completion(payload['model'], SUMMARY, usage=(200_000, 8_000)))
    async with Demo(upstream=upstream) as demo:
        response = await demo.call('summarize', {'record': record.model_dump(exclude_none=True)})
    expected = priced(LIGHTNING, 200_000, 8_000)
    assert response.status_code == 200
    assert expected > reserve_micro('summarize', 0, DEMO_SETTINGS, demo.app.cfg)
    assert demo.spend() == expected and await demo.totals() == (expected, expected)


async def test_a_call_with_no_provider_traffic_still_pays_the_floor(record):
    async with Demo() as demo:
        response = await demo.call('connect', {'record': record.model_dump(exclude_none=True), 'candidates': []})
    assert (response.status_code, response.json()) == (200, {})
    assert demo.upstream.requests == [] and demo.spend() == FLOOR_MICRO


async def test_the_inner_apps_own_errors_pass_through_and_are_settled():
    async with Demo() as demo:
        response = await demo.call('summarize', {'record': {'id': 'incomplete'}})
    assert response.status_code == 422 and response.json()['detail'] == 'Invalid request'
    assert response.headers['content-type'] == 'application/json' and response.headers['cache-control'] == 'no-store'
    assert demo.spend() == FLOOR_MICRO


def test_provider_calls_are_priced_by_kind():
    jev = 10_000
    assert ProviderCall('nebius_models', None, 0, False, 0).nano(jev) == 0
    assert ProviderCall('tavily', None, 99, False, 0).nano(jev) == 10_000_000
    assert [ProviderCall('typesafe', None, size, False, 0).nano(jev) for size in (1, 32_768, 32_769)] == [
        10_000_000, 10_000_000, 20_000_000]
    assert ProviderCall('nebius_chat', ULTRA, 10, False, 50, usage=(100, 20)).nano(jev) == 100 * 1_000 + 20 * 3_000
    assert ProviderCall('nebius_chat', OCR, 8, True, 1_600).nano(jev) == (10 + 4_096) * 150 + 1_600 * 500
    meter = Meter([ProviderCall('nebius_chat', LIGHTNING, 0, False, 0, usage=(1, 0))])
    assert meter.actual_micro(jev) == 1  # 60 nano-dollars round up to one micro-dollar.


@pytest.mark.parametrize('endpoint,size,low,high', [
    ('summarize', 0, 0.0026, 0.0028), ('consolidate', 0, 0.0062, 0.0064), ('respond', 20_000, 0.06, 0.063),
    ('respond', 200_000, 0.28, 0.29), ('respond', 10 ** 7, 0.28, 0.32), ('vision', 0, 0.013, 0.015),
    ('search', 0, 0.01, 0.01), ('extract', 0, 0.01, 0.01), ('route', 1, 0.01, 0.01), ('connect', 160_000, 0.05, 0.05),
])
def test_reservations_follow_the_clamped_settings(endpoint, size, low, high):
    cfg = replace(DemoConfig.closed('test'), jev_unit_micro=10_000)
    assert low <= reserve_micro(endpoint, size, DEMO_SETTINGS, cfg) / 1e6 <= high


def test_audio_is_charged_by_seconds_and_weighted_characters():
    assert transcribe_micro(30.0) == 3_750 and transcribe_micro(1.0) == FLOOR_MICRO
    assert speech_micro('a' * 1_000) == 20_000 and speech_micro('In 2026, 12 of 30.') == (18 + 4 * 8) * 20


# ---- 8, 9, 10: disconnects, odd usage, isolation ----

async def test_a_visitor_leaving_right_after_the_body_still_gets_a_settled_200(record):
    demo = Demo()
    body = json.dumps({'record': record.model_dump(exclude_none=True)}).encode()
    status, _, response = await asgi(demo.app, 'POST', '/api/v1/summarize', headers=json_headers(demo.token),
                                     messages=[{'type': 'http.request', 'body': body[:10], 'more_body': True},
                                               {'type': 'http.request', 'body': body[10:], 'more_body': False},
                                               {'type': 'http.disconnect'}])
    assert status == 200 and json.loads(response)['title'] == 'Garden shade'
    assert demo.spend() == priced(LIGHTNING, 20_000, 1_000)


async def test_a_disconnect_before_the_body_arrives_reserves_nothing():
    demo = Demo()
    sent = []

    async def receive():
        return {'type': 'http.disconnect'}

    async def send(message):
        sent.append(message)
    scope = {'type': 'http', 'method': 'POST', 'path': '/api/v1/route', 'query_string': b'', 'client': None,
             'headers': json_headers(demo.token)}
    await demo.app(scope, receive, send)
    assert sent == [] and demo.counters.values == {} and demo.upstream.requests == []


@pytest.mark.parametrize('usage', [
    OMIT, None, 'lots', [20_000, 1_000], {'prompt_tokens': 'many', 'completion_tokens': 5},
    {'prompt_tokens': -1, 'completion_tokens': 5}, {'prompt_tokens': True, 'completion_tokens': 1},
    {'prompt_tokens': 10}, {'completion_tokens': 10, 'total_tokens': 20},
])
async def test_odd_usage_keeps_the_status_and_charges_that_calls_worst_case(record, usage):
    upstream = Upstream(lambda request, payload: completion(payload['model'], SUMMARY, usage=usage))
    segment = record.segments[0].model_copy(update={'text': 'Water moves toward more solute. ' * 300})
    longer = record.model_copy(update={'segments': [segment]})
    async with Demo(upstream=upstream) as demo:
        response = await demo.call('summarize', {'record': longer.model_dump(exclude_none=True)})
    assert response.status_code == 200 and response.json()['title'] == 'Garden shade'
    (sent,) = upstream.chats
    expected = worst(LIGHTNING, len(sent.content), SETTINGS.summary_max_completion_tokens)
    assert expected > FLOOR_MICRO and demo.spend() == expected


async def test_completion_tokens_are_never_less_than_total_minus_prompt(record):
    usage = {'prompt_tokens': 20_000, 'completion_tokens': 10, 'total_tokens': 21_000}
    upstream = Upstream(lambda request, payload: completion(payload['model'], SUMMARY, usage=usage))
    async with Demo(upstream=upstream) as demo:
        assert (await demo.call('summarize', {'record': record.model_dump(exclude_none=True)})).status_code == 200
    assert demo.spend() == priced(LIGHTNING, 20_000, 1_000)


async def test_the_metered_client_refuses_any_call_it_cannot_price():
    requests = []
    hosts = frozenset({NEBIUS, 'api.typesafe.ai', 'api.tavily.com'})
    client = MeteredClient(hosts, transport=httpx.MockTransport(
        lambda request: requests.append(request) or httpx.Response(200, json={})))
    with pytest.raises(httpx.TransportError):
        await client.request('POST', 'https://api.tavily.com/search', json={'query': 'x'})  # No active meter.
    token = demo_gateway._meter.set(Meter())
    try:
        for method, url, payload in [
            ('POST', 'https://evil.example/search', {}), ('POST', 'http://api.tavily.com/search', {}),
            ('POST', 'https://api.tavily.com:8443/search', {}), ('GET', 'https://api.tavily.com/search', None),
            ('POST', 'https://api.tavily.com/crawl', {}), ('POST', 'https://api.typesafe.ai/v1/other', {}),
            ('POST', f'https://{NEBIUS}/v1/embeddings', {}),
            ('POST', f'https://{NEBIUS}/v1/chat/completions', {'model': 'unpriced/model', 'max_completion_tokens': 9}),
            ('POST', f'https://{NEBIUS}/v1/chat/completions', {'model': ULTRA}),
            ('POST', 'https://api.tavily.com/search', {'query': '\ud800'}),
        ]:
            with pytest.raises(httpx.TransportError):
                await client.request(method, url, json=payload)
        with pytest.raises(httpx.TransportError):
            await client.request('POST', 'https://api.typesafe.ai/v1/systemone', content=b'{"state": "unmeasured"}')
        assert demo_gateway._meter.get().calls == []
        await client.request('POST', 'https://api.tavily.com/search', json={'query': 'x'})
        assert [call.kind for call in demo_gateway._meter.get().calls] == ['tavily']
    finally:
        demo_gateway._meter.reset(token)
    assert len(requests) == 1
    await client.aclose()


def test_each_event_loop_gets_its_own_pooled_client_and_closed_loops_are_dropped():
    metered = MeteredClient(frozenset({'api.tavily.com'}))

    async def pooled():
        return metered._client()
    loops = [asyncio.new_event_loop() for _ in range(3)]
    try:
        first = loops[0].run_until_complete(pooled())
        assert loops[0].run_until_complete(pooled()) is first
        second = loops[1].run_until_complete(pooled())
        assert second is not first
        loops[0].close()
        loops[2].run_until_complete(pooled())
        assert list(metered._clients) == loops[1:]
        loops[1].run_until_complete(metered.aclose())
        assert second.is_closed and list(metered._clients) == loops[2:]
    finally:
        for loop in loops:
            loop.close()


async def test_concurrent_sessions_are_each_charged_only_their_own_usage(record):
    async def chat(request, payload):
        first = 'first visitor' in payload['messages'][1]['content']
        await asyncio.sleep(0.05 if first else 0.01)
        return completion(payload['model'], SUMMARY, usage=(30_000, 1_000) if first else (10_000, 500))

    def body(text):
        segment = record.segments[0].model_copy(update={'text': text})
        return {'record': record.model_copy(update={'segments': [segment]}).model_dump(exclude_none=True)}
    async with Demo(upstream=Upstream(chat)) as demo:
        second_token = demo.mint()
        first, second = await asyncio.gather(demo.call('summarize', body('The first visitor speaks.')),
                                             demo.call('summarize', body('The second one speaks.'), token=second_token))
    assert first.status_code == second.status_code == 200
    assert demo.spend() == priced(LIGHTNING, 30_000, 1_000) and demo.spend(second_token) == priced(LIGHTNING, 10_000, 500)


# ---- 11, 12: extract and vision pins ----

async def test_extract_only_reads_urls_this_session_found():
    async with Demo() as demo:
        assert (await demo.call('search', {'query': 'osmosis'})).status_code == 200
        allowed = await demo.call('extract', {'urls': ['HTTPS://example.ORG:443/osmosis?part=2#intro']})
        assert allowed.status_code == 200 and len(demo.upstream.to('api.tavily.com', '/extract')) == 1
        for urls in (['https://example.org/osmosis?part=3'], ['https://example.org/Osmosis?part=2'],
                     ['http://example.org/osmosis?part=2'], ['https://other.example/dilution', 'https://evil.example/'],
                     ['https://other.example/dilution'] * 4, [], 'https://other.example/dilution', [42]):
            refused = await demo.call('extract', {'urls': urls})
            assert (refused.status_code, refused.json()) == (403, {'detail': 'extract_not_allowed'}), urls
        headers = {**demo.auth(), 'content-type': 'application/json'}
        found, evil = '["https://other.example/dilution"]', '["https://evil.example/x"]'
        smuggled = await demo.client.post('/api/v1/extract', headers=headers,
                                          content=f'{{"urls": {found}, "urls": {evil}}}')
        assert smuggled.status_code == 403
        assert len(demo.upstream.to('api.tavily.com', '/extract')) == 1
        last_wins = await demo.client.post('/api/v1/extract', headers=headers,
                                           content=f'{{"urls": {evil}, "urls": {found}}}')
        assert last_wins.status_code == 200
        assert json.loads(demo.upstream.to('api.tavily.com', '/extract')[-1].content)['urls'] == [
            'https://other.example/dilution']
        elsewhere = await demo.call('extract', {'urls': ['https://other.example/dilution']}, token=demo.mint())
        assert elsewhere.status_code == 403 and len(demo.upstream.to('api.tavily.com', '/extract')) == 2


def test_url_keys_ignore_scheme_and_host_case_default_ports_and_fragments():
    secret = SECRET.encode()
    key = url_key('https://example.org/osmosis?part=2', secret)
    assert key == url_key('HTTPS://EXAMPLE.org:443/osmosis?part=2#top', secret)
    assert key != url_key('https://example.org/Osmosis?part=2', secret)
    assert key != url_key('https://example.org:8443/osmosis?part=2', secret)
    assert key != url_key('https://example.org/osmosis?part=2', b'another-secret')
    assert url_key('http://example.org', secret) == url_key('http://example.org:80/', secret)
    assert url_key('https://[2001:db8::1]:443/a', secret) == url_key('https://[2001:DB8::1]/a', secret)
    for bad in ('ftp://example.org/', 'https:///nohost', 'https://user:pw@example.org/', 'https://example.org:99999/', 42):
        assert url_key(bad, secret) is None
    assert len(key) == 16 and 'example' not in key


def test_the_worksheet_pin_is_the_sample_fixture():
    assert hashlib.sha256(WORKSHEET).hexdigest() == WORKSHEET_SHA256


async def test_vision_only_reads_the_sample_worksheet():
    upstream = Upstream(lambda request, payload: completion(OCR, json.dumps({'observations': [], 'interpretation': ''}),
                                                            usage=(5_000, 300)))
    async with Demo(upstream=upstream) as demo:
        refused = [await demo.call('vision', body) for body in (
            image_body(FOREIGN), image_body(WORKSHEET, 'image/jpeg'), image_body(WORKSHEET[:-1]),
            {**image_body(WORKSHEET), 'image': {'mimeType': 'image/png', 'dataBase64': 'not base64!'}},
            {**image_body(WORKSHEET), 'image': None}, {'question': 'What is V2?'})]
        assert [(r.status_code, r.json()) for r in refused] == [(403, {'detail': 'image_not_allowed'})] * 6
        assert upstream.requests == [] and demo.counters.values == {}
        allowed = await demo.call('vision', image_body(WORKSHEET))
    assert allowed.status_code == 200 and allowed.json()['validated'] is False
    (sent,) = upstream.chats
    payload = json.loads(sent.content)
    assert payload['model'] == OCR and payload['messages'][1]['content'][1]['type'] == 'image_url'
    assert demo.spend() == priced(OCR, 5_000, 300)


async def test_a_vision_call_without_usage_is_priced_as_text_plus_one_image():
    upstream = Upstream(lambda request, payload: completion(OCR, '{}', usage=OMIT))
    async with Demo(upstream=upstream) as demo:
        assert (await demo.call('vision', image_body(WORKSHEET))).status_code == 200
    (sent,) = upstream.chats
    image = json.loads(sent.content)['messages'][1]['content'][1]['image_url']['url']
    assert demo.spend() == worst(OCR, len(sent.content) - len(image), 1_600, image=True)


# ---- 13: fail closed ----

async def test_an_upstash_error_on_reserve_is_503_with_no_provider_call():
    upstash = Upstash()
    upstash.fail['RESERVE'] = [httpx.Response(500, text='down')]
    upstream = Upstream()
    upstream.handlers['kv.upstash.test'] = upstash
    env = {'KV_REST_API_URL': 'https://kv.upstash.test', 'KV_REST_API_TOKEN': UPSTASH_TOKEN}
    async with Demo(env, counters=None, upstream=upstream) as demo:
        response = await demo.call('route', ROUTE)
    assert (response.status_code, response.json()) == (503, {'detail': 'demo_unavailable'})
    assert upstash.kinds() == ['RESERVE'] and upstream.providers == []


@pytest.mark.parametrize('failure,attempts,settled', [
    (httpx.ReadTimeout('slow'), 1, False),  # It may have run: a settle is never sent twice.
    (httpx.Response(500, text='down'), 1, False),
    (httpx.ConnectError('refused'), 2, True),  # Nothing reached Redis, so it is sent again.
])
async def test_a_failed_settle_still_sends_the_answer(record, failure, attempts, settled):
    upstash = Upstash()
    upstash.fail['SETTLE'] = [failure]
    upstream = Upstream()
    upstream.handlers['kv.upstash.test'] = upstash
    env = {'KV_REST_API_URL': 'https://kv.upstash.test', 'KV_REST_API_TOKEN': UPSTASH_TOKEN}
    async with Demo(env, counters=None, upstream=upstream) as demo:
        response = await demo.call('summarize', {'record': record.model_dump(exclude_none=True)})
    assert response.status_code == 200 and response.json()['title'] == 'Garden shade'
    assert upstash.kinds() == ['RESERVE'] + ['SETTLE'] * attempts
    assert int(upstash.commands[-1][6]) == priced(LIGHTNING, 20_000, 1_000) - 2_688


async def test_an_inner_crash_is_502_and_still_settled(record):
    async with Demo() as demo:
        async def crash(scope, receive, send):
            await receive()
            raise RuntimeError('boom')
        demo.app.inner = crash
        response = await demo.call('summarize', {'record': record.model_dump(exclude_none=True)})
    assert (response.status_code, response.json()) == (502, {'detail': 'provider_failed'})
    assert demo.spend() == FLOOR_MICRO


# ---- 14: interlocks ----

@pytest.mark.parametrize('env,options,reason', [
    ({'VERCEL_ENV': 'preview'}, {}, 'not_production'),
    ({'VERCEL_ENV': None}, {}, 'not_production'),
    ({'VERCEL': None, '__VC_HANDLER_ENTRYPOINT': '/var/task/vc__handler__python.py', 'VERCEL_ENV': 'preview'}, {},
     'not_production'),
    ({}, {'local': True}, 'local_on_vercel'),
    ({}, {'counters': 'memory'}, 'local_on_vercel'),
    ({'TURNSTILE_SITE_KEY': '1x00000000000000000000AA'}, {}, 'turnstile_test_keys'),
    ({'TURNSTILE_SITE_KEY': '3x00000000000000000000FF'}, {}, 'turnstile_test_keys'),
    ({'TURNSTILE_SECRET_KEY': '2x0000000000000000000000000000000AA'}, {}, 'turnstile_test_keys'),
    ({'TURNSTILE_SECRET_KEY': None}, {}, 'turnstile_unconfigured'),
    ({'DEMO_SESSION_SECRET': 'x' * 31}, {}, 'session_secret_short'),
    ({'DEMO_SESSION_SECRET': None}, {}, 'session_secret_short'),
    ({'VERCEL_PROJECT_PRODUCTION_URL': None}, {}, 'no_hostnames'),
    ({'NEBIUS_AGENT_MODEL': 'nvidia/unpriced'}, {}, 'unpriced_model'),
    ({'NEBIUS_OCR_MODEL': 'someone/else'}, {}, 'unpriced_model'),
    ({'NEBIUS_API_KEY': None}, {}, 'provider_keys_missing'),
    ({'TYPESAFE_API_KEY': ''}, {}, 'provider_keys_missing'),
    ({'TAVILY_API_KEY': None}, {}, 'provider_keys_missing'),
    ({'DEMO_BUDGET_TOTAL_USD': '60.01'}, {}, 'budget_invalid'),
    ({'DEMO_BUDGET_TOTAL_USD': 'forty'}, {}, 'budget_invalid'),
    ({'DEMO_BUDGET_DAILY_USD': '10.5'}, {}, 'budget_invalid'),
    ({'DEMO_BUDGET_DAILY_USD': '0'}, {}, 'budget_invalid'),
    ({'DEMO_SESSION_BUDGET_USD': '3.01'}, {}, 'budget_invalid'),
    ({'DEMO_SESSION_BUDGET_USD': 'NaN'}, {}, 'budget_invalid'),
    ({'DEMO_JEV_CALL_USD': '0.0009'}, {}, 'budget_invalid'),
    ({'DEMO_JEV_CALL_USD': '0.051'}, {}, 'budget_invalid'),
    ({'DEMO_END_AT': '2026-10-01T00:00:00Z'}, {}, 'ended'),
    ({'DEMO_END_AT': 'soon'}, {}, 'misconfigured'),
    ({'DEMO_END_AT': '2026-12-16T00:00:00'}, {}, 'misconfigured'),
    ({'DEMO_ENABLED': 'off'}, {}, 'disabled'),
    ({'DEMO_ENABLED': None}, {}, 'disabled'),
    ({'KV_REST_API_URL': None}, {}, 'counters_unconfigured'),
    ({'KV_REST_API_URL': 'http://kv.upstash.test'}, {}, 'counters_unconfigured'),
    ({'NEBIUS_BASE_URL': 'http://api.tokenfactory.nebius.com/v1'}, {}, 'misconfigured'),
    ({'VERCEL_ENV': 'Production!'}, {}, 'misconfigured'),
])
async def test_every_interlock_makes_the_deployment_not_live(env, options, reason):
    if options.get('counters') == 'memory':
        options = {'counters': MemoryCounters(Keys('production'))}
    baseline = vercel_demo()
    async with baseline:
        assert (await baseline.client.get('/api/demo/config')).json()['live'] is True
    demo = vercel_demo(env, **options)
    async with demo:
        config = await demo.client.get('/api/demo/config')
        refused = await demo.call('route', ROUTE)
        mint = await demo.client.post('/api/demo/session', json={'turnstileToken': 'cf-token'})
    assert config.json()['live'] is False and config.json()['voice'] is False and config.json()['reason'] == reason
    assert (refused.status_code, refused.json()) == (503, {'detail': 'demo_unavailable'})
    assert (mint.status_code, mint.json()) == (503, {'detail': 'demo_unavailable'})
    assert demo.upstream.providers == [] and demo.upstash.commands == []
    assert demo.upstream.to('challenges.cloudflare.com') == []


@pytest.mark.parametrize('env', [{'NEBIUS_SUMMARY_MAX_TOKENS': 'lots'}, {'NEBIUS_ORGANIZATION_MAX_TOKENS': '99999'},
                                 {'NEBIUS_OCR_REASONING_EFFORT': 'maximal'}])
async def test_a_bad_backend_variable_gives_a_fail_closed_app_instead_of_raising(env):
    demo = vercel_demo(env)
    async with demo:
        config = await demo.client.get('/api/demo/config')
        selftest = await demo.client.get('/api/demo/selftest')
        refused = await demo.call('route', ROUTE)
    assert config.json() == {'live': False, 'voice': False, 'turnstileSiteKey': '', 'budget': 'ok',
                             'reason': 'misconfigured'}
    assert selftest.json()['ok'] is False and not any(selftest.json()['checks'].values())
    assert refused.status_code == 503 and demo.upstream.requests == []


async def test_any_construction_error_gives_a_fail_closed_app(monkeypatch):
    def broken(_env):
        raise RuntimeError('unexpected')
    monkeypatch.setattr(demo_gateway, 'settings_from_env', broken)
    app = create_demo_app(VERCEL_ENV)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url='https://demo.test') as client:
        assert (await client.get('/api/demo/config')).json()['reason'] == 'misconfigured'
        assert (await client.get('/api/health')).status_code == 200


async def test_the_demo_switches_itself_off_at_its_end_date():
    clock = Clock()
    demo = vercel_demo(clock=clock)
    async with demo:
        assert (await demo.client.get('/api/demo/config')).json()['live'] is True
        clock.now = datetime(2026, 12, 16, tzinfo=timezone.utc).timestamp()
        demo.app._status_cache = None
        config = await demo.client.get('/api/demo/config')
        refused = await demo.call('route', ROUTE, token=demo.mint())
    assert config.json()['live'] is False and config.json()['reason'] == 'ended'
    assert refused.status_code == 503 and demo.upstream.providers == []


@pytest.mark.parametrize('status,reason,budget', [
    ((None, None, '1', None), 'off', 'ok'),
    (('44990000', '100', None, None), 'budget_exhausted', 'exhausted'),
    (('100', '5960000', None, None), 'budget_exhausted', 'exhausted'),
    (('100', '5000000', None, None), None, 'low'),
    (('100', '1000000', None, None), None, 'ok'),
])
async def test_config_reports_the_kill_switch_and_the_budget(status, reason, budget):
    demo = vercel_demo(upstash=Upstash(status))
    async with demo:
        config = (await demo.client.get('/api/demo/config')).json()
        refused = await demo.call('route', ROUTE)
    assert config['live'] is (reason is None) and config.get('reason') == reason and config['budget'] == budget
    assert config['turnstileSiteKey'] == '0x4AAAAAAA-site-key'
    if reason == 'off':
        # The kill switch config read is cached in process: the next call is refused without a counter call.
        assert refused.status_code == 503 and demo.upstash.kinds() == ['MGET']
    else:
        # A nearly spent budget stops new visitors; the counters still decide each call that fits. The route
        # call cost exactly its one-unit reservation, so there is nothing to settle.
        assert refused.status_code == 200 and demo.upstash.kinds() == ['MGET', 'RESERVE']


async def test_config_reads_the_counters_once_per_30_seconds_and_fails_closed_on_errors():
    clock = Clock()
    upstash = Upstash()
    upstash.fail['MGET'] = [httpx.Response(500, text='down')]
    demo = vercel_demo(upstash=upstash, clock=clock)
    async with demo:
        first = (await demo.client.get('/api/demo/config')).json()
        clock.now += 6
        second = (await demo.client.get('/api/demo/config')).json()
        clock.now += 10
        third = await demo.client.get('/api/demo/config')
    assert (first['live'], first['reason']) == (False, 'counters_unavailable')
    assert second['live'] is True and third.json()['live'] is True
    assert upstash.kinds() == ['MGET', 'MGET']
    assert 's-maxage=15' in third.headers['cache-control']


# ---- 15: session minting ----

def with_turnstile(turnstile: Turnstile) -> Upstream:
    upstream = Upstream()
    upstream.handlers['challenges.cloudflare.com'] = turnstile
    return upstream


async def test_a_passed_bot_check_mints_a_two_hour_session():
    turnstile = Turnstile()
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 'cf-token'})
        body = response.json()
        works = await demo.call('connect', {'record': {}, 'candidates': []}, token=body['token'])
    assert response.status_code == 200 and response.headers['cache-control'] == 'no-store'
    session = verify_token([(b'authorization', f'Bearer {body["token"]}'.encode())], SECRET.encode(), NOW)
    assert isinstance(session, Session) and session.exp == int(NOW) + 7_200
    assert body['expiresAt'] == '2026-10-29T14:30:00Z' and set(body) == {'token', 'expiresAt'}
    (sent,) = turnstile.requests
    assert (sent['secret'], sent['response'], sent['remoteip']) == (TURNSTILE_SECRET, 'cf-token', '127.0.0.1')
    assert uuid.UUID(sent['idempotency_key']).version == 4
    assert works.status_code == 422  # Past the session check, refused by the inner app's validation.


@pytest.mark.parametrize('reply', [
    {**PASS, 'success': False, 'error-codes': ['invalid-input-response']},
    {**PASS, 'success': 'true'},
    {**PASS, 'action': 'other-site'},
    {**PASS, 'action': None},
    {**PASS, 'hostname': 'evil.example'},
    {key: value for key, value in PASS.items() if key != 'hostname'},
    httpx.Response(400, json={'success': False}),
    httpx.Response(200, text='not json'),
])
async def test_a_failed_or_mismatched_bot_check_is_403(reply):
    turnstile = Turnstile(reply)
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 'cf-token'})
    assert (response.status_code, response.json()) == (403, {'detail': 'turnstile_failed'})
    assert len(turnstile.requests) == 1 and demo.counters.values == {}  # A failed check counts toward nothing.


async def test_unsolved_tokens_cannot_use_up_the_mint_caps():
    turnstile = Turnstile(*[{**PASS, 'success': False}] * 400)
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        refused = [(await demo.client.post('/api/demo/session', json={'turnstileToken': 'guess'})).status_code
                   for _ in range(400)]
        turnstile.replies.clear()
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 'solved'})
    assert set(refused) == {403} and response.status_code == 200


async def test_locally_the_test_keys_skip_the_action_and_hostname_checks():
    turnstile = Turnstile({'success': True, 'hostname': 'example.com', 'action': ''})
    async with Demo(upstream=with_turnstile(turnstile), local=True) as demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 'XXXX.DUMMY.TOKEN.XXXX'})
    assert response.status_code == 200


@pytest.mark.parametrize('body,status,detail', [
    ({'turnstileToken': 'x' * 2_049}, 403, 'turnstile_failed'),
    ({'turnstileToken': 'tokén'}, 403, 'turnstile_failed'),
    ({'turnstileToken': ''}, 403, 'turnstile_failed'),
    ({'turnstileToken': 42}, 403, 'turnstile_failed'),
    ({}, 403, 'turnstile_failed'),
    ([], 422, 'invalid_json'),
])
async def test_a_malformed_bot_token_is_refused_without_calling_cloudflare(body, status, detail):
    turnstile = Turnstile()
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        response = await demo.client.post('/api/demo/session', json=body)
        too_large = await demo.client.post('/api/demo/session', json={'turnstileToken': 'x' * 5_000})
        wrong_type = await demo.client.post('/api/demo/session', content=b'{}', headers={'content-type': 'text/plain'})
    assert (response.status_code, response.json()) == (status, {'detail': detail})
    assert too_large.status_code == 413 and wrong_type.status_code == 415
    assert turnstile.requests == [] and demo.counters.values == {}


@pytest.mark.parametrize('replies,status,calls', [
    ((httpx.Response(500, text='busy'),), 200, 2),
    ((httpx.ConnectError('refused'),), 200, 2),
    ((httpx.ReadTimeout('slow'), httpx.Response(502, text='busy')), 503, 2),
])
async def test_siteverify_is_retried_once_with_the_same_idempotency_key(replies, status, calls):
    turnstile = Turnstile(*replies)
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 'cf-token'})
    assert response.status_code == status
    assert len(turnstile.requests) == calls and turnstile.requests[0] == turnstile.requests[1]
    if status == 503:
        assert response.json() == {'detail': 'demo_unavailable'}


async def test_mints_are_capped_per_address_and_per_day():
    turnstile = Turnstile()
    async with Demo(upstream=with_turnstile(turnstile)) as demo:
        statuses = [(await demo.client.post('/api/demo/session', json={'turnstileToken': 't'})).status_code
                    for _ in range(31)]
        assert statuses == [200] * 30 + [429]
        for index in range(300 - 30):
            await demo.counters.allow_mint(f'elsewhere-{index}', NOW, 30, 300)
        status, _, body = await asgi(demo.app, 'POST', '/api/demo/session', body=b'{"turnstileToken": "t"}',
                                     headers=[(b'content-type', b'application/json')], client=('198.51.100.20', 1))
    assert (status, json.loads(body)) == (429, {'detail': 'session_rate_limited'})
    assert len(turnstile.requests) == 32  # Each token is verified first, so only verified mints are counted.


async def test_ipv6_visitors_share_one_bucket_per_64():
    demo = Demo(upstream=with_turnstile(Turnstile()))

    async def mint(address):
        status, _, _ = await asgi(demo.app, 'POST', '/api/demo/session', body=b'{"turnstileToken": "t"}',
                                  headers=[(b'content-type', b'application/json')], client=(address, 1))
        return status
    assert [await mint(f'2001:db8:1:2::{index:x}') for index in range(1, 31)] == [200] * 30
    assert await mint('2001:db8:1:2:ffff:ffff:ffff:fffe') == 429
    assert await mint('2001:db8:1:3::1') == 200
    secret = SECRET.encode()
    assert ip_key('2001:db8:1:2::1', secret) == ip_key('2001:db8:1:2:abcd::1', secret) != ip_key('2001:db8:1:3::1', secret)
    assert ip_key('::ffff:198.51.100.7', secret) == ip_key('198.51.100.7', secret) != ip_key('198.51.100.8', secret)
    assert ip_key(None, secret) == ip_key(None, secret) and len(ip_key('198.51.100.7', secret)) == 16


async def test_x_real_ip_is_trusted_only_on_vercel():
    hour = utc_hour(NOW)
    async with Demo(upstream=with_turnstile(Turnstile())) as local:
        await local.client.post('/api/demo/session', json={'turnstileToken': 't'}, headers={'x-real-ip': '198.51.100.7'})
    assert local.counters.keys.mint_ip(ip_key('127.0.0.1', SECRET.encode()), hour) in local.counters.values
    assert local.counters.keys.mint_ip(ip_key('198.51.100.7', SECRET.encode()), hour) not in local.counters.values
    turnstile = Turnstile({**PASS, 'hostname': 'moolai-app.vercel.app'})
    demo = vercel_demo(turnstile=turnstile)
    async with demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 't'},
                                          headers={'x-real-ip': '198.51.100.7'})
    assert response.status_code == 200
    (mint,) = [command for command in demo.upstash.commands if command_kind(command) == 'MINT']
    assert mint[3] == Keys('production').mint_ip(ip_key('198.51.100.7', SECRET.encode()), hour)
    assert turnstile.requests[0]['remoteip'] == '198.51.100.7'


async def test_a_mint_counter_error_is_503_and_mints_nothing():
    upstash = Upstash()
    upstash.fail['MINT'] = [httpx.ReadTimeout('slow')]
    turnstile = Turnstile({**PASS, 'hostname': 'moolai-app.vercel.app'})
    demo = vercel_demo(upstash=upstash, turnstile=turnstile)
    async with demo:
        response = await demo.client.post('/api/demo/session', json={'turnstileToken': 't'})
    assert (response.status_code, response.json()) == (503, {'detail': 'demo_unavailable'})
    assert len(turnstile.requests) == 1 and upstash.kinds() == ['MINT'] and 'token' not in response.text


# ---- 16, 17, 18: secrets, caching, lifespan ----

SECRETS = [*PROVIDER_KEYS.values(), SECRET, TURNSTILE_SECRET, UPSTASH_TOKEN]


def leaks(response: httpx.Response, extra: list[str]) -> list[str]:
    text = response.content.decode('latin-1') + ''.join(f'{k}:{v}' for k, v in response.headers.items())
    return [secret for secret in SECRETS + extra if secret in text]


async def test_no_response_ever_contains_a_secret(record):
    def leaky(request, payload):
        return httpx.Response(500, text=' '.join(SECRETS))

    upstream = Upstream(leaky)
    upstream.handlers['api.openai.com'] = lambda request: httpx.Response(400, text=' '.join(SECRETS))
    upstream.handlers['api.tavily.com'] = lambda request: httpx.Response(401, text=' '.join(SECRETS))
    upstream.handlers['challenges.cloudflare.com'] = Turnstile(
        {'success': False, 'error-codes': SECRETS}, PASS)
    async with Demo(upstream=upstream) as demo:
        responses = [
            await demo.client.get('/api/health'), await demo.client.get('/api/demo/config'),
            await demo.client.get('/api/demo/selftest'),
            await demo.client.post('/api/demo/session', json={'turnstileToken': 't'}),
            await demo.client.post('/api/demo/session', json={'turnstileToken': 't'}),
            await demo.call('summarize', {'record': record.model_dump(exclude_none=True)}),
            await demo.call('search', {'query': 'q'}), await demo.call('route', {}),
            await demo.call('route', ROUTE, token='nope'), await demo.call('vision', image_body(FOREIGN)),
            await demo.client.post('/api/v1/transcribe', content=wav(1.0),
                                   headers={**demo.auth(), 'content-type': 'audio/wav'}),
            await demo.call('speech', {'text': 'Hello.'}), await demo.client.get('/api/v1/route'),
            await demo.client.get('/api/nothing'),
        ]
        internal = demo.app.internal_token
    assert [response.status_code for response in responses] == [
        200, 200, 200, 403, 200, 502, 502, 422, 401, 403, 422, 422, 405, 404]
    assert [leaks(response, [internal]) for response in responses] == [[]] * len(responses)
    demo = vercel_demo({'TURNSTILE_SITE_KEY': '1x00000000000000000000AA'})
    async with demo:
        for response in [await demo.client.get('/api/demo/config'), await demo.client.get('/api/demo/selftest')]:
            assert leaks(response, [demo.app.internal_token]) == []


async def test_caching_headers():
    async with Demo(upstream=with_turnstile(Turnstile())) as demo:
        no_store = [
            await demo.client.get('/api/health'),
            await demo.client.post('/api/demo/session', json={'turnstileToken': 't'}),
            await demo.client.post('/api/demo/session', json={'turnstileToken': ''}),
            await demo.call('search', {'query': 'q'}), await demo.call('search', {'query': 'q'}, token='bad'),
            await demo.client.post('/api/v1/transcribe', content=wav(1.0),
                                   headers={**demo.auth(), 'content-type': 'audio/wav'}),
            await demo.call('speech', {'text': 'Hello.'}), await demo.call('speech', {'text': ''}),
            await demo.client.get('/api/nothing'),
        ]
        config = await demo.client.get('/api/demo/config')
        selftest = await demo.client.get('/api/demo/selftest')
    assert [response.headers['cache-control'] for response in no_store] == ['no-store'] * len(no_store)
    assert all(response.headers['x-content-type-options'] == 'nosniff' for response in no_store)
    assert config.headers['cache-control'] == 'public, max-age=0, s-maxage=15'
    assert selftest.headers['cache-control'] == 'public, max-age=0, s-maxage=60'


@pytest.mark.parametrize('app', ['live', 'closed'])
async def test_lifespan_startup_and_shutdown_are_answered(app):
    gateway = Demo().app if app == 'live' else create_demo_app({'NEBIUS_SUMMARY_MAX_TOKENS': 'lots'})
    messages = [{'type': 'lifespan.startup'}, {'type': 'lifespan.shutdown'}]
    sent = []

    async def receive():
        return messages.pop(0)

    async def send(message):
        sent.append(message)
    await gateway({'type': 'lifespan', 'asgi': {'version': '3.0'}}, receive, send)
    assert sent == [{'type': 'lifespan.startup.complete'}, {'type': 'lifespan.shutdown.complete'}]


async def test_selftest_reports_booleans_only_and_the_path_mode():
    counters = Counting(MemoryCounters(Keys('local')))
    async with Demo(counters=counters) as demo:
        original = await demo.client.get('/api/demo/selftest')
        rewritten = await demo.client.get('/api', params={'__path': 'demo/selftest'})
    assert original.json() == {'ok': True, 'pathMode': 'original', 'checks': {
        'configured': True, 'counters': True, 'reserveSettle': True, 'inner': True, 'voice': True}}
    assert rewritten.json()['pathMode'] == 'rewrite'
    assert counters.calls == ['ping']  # The second run came from the 60 s in-process cache.
    assert await counters.inner.status(DAY) == (await counters.inner.status(DAY)).__class__(0, 0, False, False)
    assert all(key.startswith('moolai:demo:local:selftest:') for key in counters.values)
    assert demo.upstream.requests == []


async def test_selftest_on_vercel_round_trips_on_selftest_keys_only():
    demo = vercel_demo()
    async with demo:
        body = (await demo.client.get('/api/demo/selftest')).json()
    assert body['ok'] is True and demo.upstash.kinds() == ['PING', 'RESERVE', 'SETTLE']
    reserve, settle = demo.upstash.commands[1:]
    assert reserve[3:7] == ['moolai:demo:production:selftest:total', f'moolai:demo:production:selftest:day:{DAY}',
                            'moolai:demo:production:selftest:session:selftest', 'moolai:demo:production:selftest:off']
    assert reserve[7] == '1' and settle[6] == '-1'


# ---- 19: speech endpoints ----

def openai_with(transcription=None, speech=None):
    upstream = Upstream()
    upstream.handlers['api.openai.com'] = lambda request: (
        (transcription or openai) if request.url.path.endswith('transcriptions') else (speech or openai))(request)
    return upstream


async def test_transcription_takes_raw_wav_and_returns_text():
    upstream = openai_with()
    prompt = 'Moo. Osmosis — dilution, 0.50 mol/L'
    async with Demo(upstream=upstream) as demo:
        response = await demo.client.post('/api/v1/transcribe', content=wav(30.0), headers={
            **demo.auth(), 'content-type': 'audio/wav', 'x-moolai-prompt': quote(prompt, safe='')})
    assert response.status_code == 200 and response.json() == {'text': 'Osmosis moves water.'}
    assert response.headers['cache-control'] == 'no-store'
    (sent,) = upstream.to('api.openai.com')
    assert sent.url.path == '/v1/audio/transcriptions' and sent.headers['authorization'] == 'Bearer openai-secret-value'
    assert f'name="prompt"\r\n\r\n{prompt}\r\n'.encode() in sent.content
    assert b'name="model"\r\n\r\ngpt-transcribe\r\n' in sent.content
    assert b'filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n' + wav(30.0) in sent.content
    assert demo.spend() == transcribe_micro(30.0) == 3_750


@pytest.mark.parametrize('content,headers,status,detail', [
    (wav(1.0), {'content-type': 'audio/mpeg'}, 415, 'unsupported_media_type'),
    (wav(1.0), {}, 415, 'unsupported_media_type'),
    (b'\x00' * 1_100_001, {'content-type': 'audio/wav'}, 413, 'body_too_large'),
    (b'RIFF-not-a-wav', {'content-type': 'audio/wav'}, 422, 'invalid_audio'),
    (wav(0.1), {'content-type': 'audio/wav'}, 422, 'invalid_audio'),
    (wav(1.0), {'content-type': 'audio/wav', 'x-moolai-prompt': quote('x' * 401)}, 422, 'invalid_audio'),
    (wav(1.0), {'content-type': 'audio/wav', 'x-moolai-prompt': '%E9t%E9'}, 422, 'invalid_audio'),
    (wav(1.0), {'content-type': 'audio/wav', 'x-moolai-prompt': quote('bell\x07')}, 422, 'invalid_audio'),
])
async def test_bad_audio_uploads_are_refused_before_reserving(content, headers, status, detail):
    upstream = openai_with()
    async with Demo(upstream=upstream) as demo:
        response = await demo.client.post('/api/v1/transcribe', content=content, headers={**demo.auth(), **headers})
    assert (response.status_code, response.json()) == (status, {'detail': detail})
    assert upstream.requests == [] and demo.counters.values == {}


async def test_speech_returns_mp3_and_is_charged_by_weighted_characters():
    upstream = openai_with()
    async with Demo(upstream=upstream) as demo:
        response = await demo.call('speech', {'text': 'Dilution keeps 2 moles.'})
        refused = [await demo.call('speech', body) for body in (
            {'text': 'x' * 1_001}, {'text': 'bell\x07'}, {'text': ' '}, {'text': 42}, {'words': 'hi'})]
    assert response.status_code == 200 and response.content == b'ID3-fake-mp3'
    assert response.headers['content-type'] == 'audio/mpeg' and response.headers['cache-control'] == 'no-store'
    (sent,) = upstream.to('api.openai.com')
    assert json.loads(sent.content)['input'] == 'Dilution keeps 2 moles.'
    assert demo.spend() == speech_micro('Dilution keeps 2 moles.') == 540
    assert [(r.status_code, r.json()) for r in refused] == [(422, {'detail': 'invalid_json'})] * 5


async def test_an_oversized_speech_reply_is_502_and_stays_charged():
    upstream = openai_with(speech=lambda request: httpx.Response(200, content=b'\x00' * 4_000_001))
    async with Demo(upstream=upstream) as demo:
        response = await demo.call('speech', {'text': 'x' * 1_000})
    assert (response.status_code, response.json()) == (502, {'detail': 'provider_failed'})
    assert demo.spend() == 20_000


async def test_openais_spend_limit_turns_voice_off_for_an_hour():
    clock = Clock()
    quota = httpx.Response(429, json={'error': {'code': 'insufficient_quota', 'message': 'PRIVATE'}})
    upstream = openai_with(transcription=lambda request: quota)
    async with Demo(upstream=upstream, clock=clock) as demo:
        response = await demo.client.post('/api/v1/transcribe', content=wav(10.0),
                                          headers={**demo.auth(), 'content-type': 'audio/wav'})
        speech = await demo.call('speech', {'text': 'Hello.'})
        config = (await demo.client.get('/api/demo/config')).json()
        shared = demo.counters.keys.voice_off() in demo.counters.values  # So other instances stop offering voice too.
        clock.now += 3_601
        demo.app._status_cache = None
        later = (await demo.client.get('/api/demo/config')).json()
    assert (response.status_code, response.json()) == (503, {'detail': 'voice_unavailable'})
    assert (speech.status_code, speech.json()) == (503, {'detail': 'voice_unavailable'})
    assert len(upstream.to('api.openai.com')) == 1 and 'PRIVATE' not in response.text
    assert shared and config['live'] is True and config['voice'] is False and later['voice'] is True
    assert demo.spend() == FLOOR_MICRO  # OpenAI refused it, so only the floor stays charged.


async def test_another_instance_learns_voice_is_off_from_the_counters():
    counters = MemoryCounters(Keys('local'))
    await counters.set_voice_off(3_600)
    upstream = openai_with()
    async with Demo(counters=counters, upstream=upstream) as demo:
        config = (await demo.client.get('/api/demo/config')).json()
        speech = await demo.call('speech', {'text': 'Hello.'})
    assert config['live'] is True and config['voice'] is False
    assert speech.status_code == 503 and upstream.requests == []


async def test_without_an_openai_key_the_demo_is_live_but_typed_only():
    upstream = openai_with()
    async with Demo({'OPENAI_API_KEY': None}, upstream=upstream) as demo:
        config = (await demo.client.get('/api/demo/config')).json()
        speech = await demo.call('speech', {'text': 'Hello.'})
        transcribe = await demo.client.post('/api/v1/transcribe', content=wav(1.0),
                                            headers={**demo.auth(), 'content-type': 'audio/wav'})
    assert config['live'] is True and config['voice'] is False
    assert [(r.status_code, r.json()) for r in (speech, transcribe)] == [(503, {'detail': 'voice_unavailable'})] * 2
    assert upstream.requests == []


@pytest.mark.parametrize('reply,status,detail,charged', [
    (httpx.Response(401, json={}), 503, 'voice_unavailable', FLOOR_MICRO),
    (httpx.Response(400, json={}), 422, 'invalid_audio', FLOOR_MICRO),
    (httpx.Response(500, text='down'), 502, 'provider_failed', FLOOR_MICRO),
    (httpx.ReadTimeout('slow'), 504, 'provider_timeout', transcribe_micro(20.0)),
])
async def test_openai_errors_map_to_fixed_codes_and_refunds(reply, status, detail, charged):
    def answer(request):
        if isinstance(reply, Exception):
            raise reply
        return reply
    async with Demo(upstream=openai_with(transcription=answer)) as demo:
        response = await demo.client.post('/api/v1/transcribe', content=wav(20.0),
                                          headers={**demo.auth(), 'content-type': 'audio/wav'})
    assert (response.status_code, response.json()) == (status, {'detail': detail})
    assert demo.spend() == charged
    assert demo.counters.keys.voice_off() not in demo.counters.values
