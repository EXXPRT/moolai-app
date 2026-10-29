"""The web demo's gateway: a plain ASGI dispatcher in front of the unchanged backend app.

Every guarded call reserves its worst case before anything is sent and settles afterwards to what
was actually sent to a provider. A misconfigured deployment is not live; nothing here raises at
import or construction.
"""
import asyncio
import base64
import hashlib
import hmac
import ipaddress
import json
import logging
import math
import os
import re
import secrets
import time
import unicodedata
import uuid
from collections.abc import Awaitable, Callable, Mapping
from contextvars import ContextVar
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from decimal import Decimal
from fractions import Fraction
from typing import Any, Literal
from urllib.parse import parse_qsl, unquote, urlsplit, urlunsplit

import httpx

from .demo_audio import DEFAULTS as AUDIO_DEFAULTS, AudioError, DemoAudio, clean_speech_text, wav_seconds
from .demo_counters import (Caps, CounterError, Counters, Keys, MemoryCounters, Outcome, Reservation, Status,
                            UpstashCounters, usd_to_micro, utc_day)
from .settings import Settings

logger = logging.getLogger(__name__)

Scope = dict[str, Any]
Receive = Callable[[], Awaitable[dict[str, Any]]]
Send = Callable[[dict[str, Any]], Awaitable[None]]
ASGIApp = Callable[[Scope, Receive, Send], Awaitable[None]]

GUARDED = ('route', 'tag', 'connect', 'summarize', 'consolidate', 'respond', 'vision', 'search', 'extract')
BODY_CAPS = {'route': 128_000, 'tag': 64_000, 'connect': 160_000, 'summarize': 40_000, 'consolidate': 40_000,
             'respond': 200_000, 'vision': 128_000, 'search': 4_000, 'extract': 8_000, 'transcribe': 1_100_000,
             'speech': 4_000, 'session': 4_000}
QUOTAS = {'route': 150, 'tag': 60, 'connect': 60, 'consolidate': 30, 'summarize': 40, 'respond': 60, 'vision': 4,
          'search': 6, 'extract': 3, 'transcribe': 150, 'speech': 150}
# Nano-dollars per token (in, out). Prices are code, never env: an unpriced model means not live.
PRICES_NANO = {'nvidia/Nemotron-3-Ultra-550b-a55b': (1_000, 3_000), 'nvidia/Nemotron-3_5-Lightning': (60, 240),
               'zai-org/GLM-5.3-Flash': (150, 500), 'openbmb/MiniCPM-V-4_5': (658, 1_110)}
TOKENS_PER_BYTE = Fraction(5, 4)
IMAGE_TOKENS = 4_096
RESPOND_OVERHEAD = 16_384
FLOOR_MICRO = 500
TAVILY_MICRO = 10_000
JEV_UNIT_BYTES = 32_768
TRANSCRIBE_MICRO_PER_MINUTE = 7_500
SPEECH_MICRO_PER_CHAR = 20
# Whatever the env says: tool arguments are re-encoded ASCII-escaped (providers.py chat_message), so request
# bytes, not characters, bound the worst case.
DEMO_OVERRIDES = dict(agent_max_tokens=4_096, agent_max_request_bytes=240_000, database_url='')
SESSION_TTL_S = 7_200
TOKEN_SKEW_S = 60
MINT_PER_IP_HOUR = 30
MINT_PER_DAY = 300
CEILINGS_USD = {'total': 60, 'day': 10, 'session': 3}
DEFAULT_CAPS_USD = {'total': '45', 'day': '6', 'session': '1.5'}
JEV_RANGE_MICRO = (1_000, 50_000)
DEFAULT_END_AT = '2026-12-16T00:00:00Z'
WORKSHEET_SHA256 = '9e7b162771b014554d4d3ad1ab22616371eec73f987a45770505ffc63ae03544'
TURNSTILE_ACTION = 'moolai-demo'
SITEVERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'
TURNSTILE_TIMEOUT = httpx.Timeout(8.0, connect=3.0)
TYPESAFE_HOST = 'api.typesafe.ai'
TAVILY_HOST = 'api.tavily.com'
CONFIG_CACHE_S = 30.0
STATUS_ERROR_CACHE_S = 5.0
SELFTEST_CACHE_S = 60.0
CLOSED_CACHE_S = 30.0
VOICE_OFF_S = 3_600
MAX_INNER_RESPONSE = 4_000_000
NO_STORE = 'no-store'
CONFIG_CACHE = 'public, max-age=0, s-maxage=15'
SELFTEST_CACHE = 'public, max-age=0, s-maxage=60'
SELFTEST_CAPS = Caps(1_000_000, 1_000_000, 1_000_000)
SELFTEST_RECORD = {
    'id': 'selftest', 'kind': 'dictation', 'revision': 1, 'sourceRevision': 1,
    'createdAt': '2026-01-01T00:00:00Z', 'updatedAt': '2026-01-01T00:00:00Z', 'segments': [], 'title': '',
    'summary': '', 'topics': [], 'quality': 'pending', 'qualityReasons': [], 'doubt': False, 'links': [],
    'attachmentIds': [], 'manualFields': [], 'acceptedRevision': 0,
}
ROUTES = {'/api/health': ('GET', 'health'), '/api/demo/config': ('GET', 'config'),
          '/api/demo/selftest': ('GET', 'selftest'), '/api/demo/session': ('POST', 'session'),
          '/api/v1/transcribe': ('POST', 'transcribe'), '/api/v1/speech': ('POST', 'speech'),
          **{f'/api/v1/{name}': ('POST', name) for name in GUARDED}}
_REWRITTEN = re.compile(r'[a-z0-9_-]+(?:/[a-z0-9_-]+)*')
_BEARER = re.compile(r'Bearer v1\.([A-Za-z0-9_-]{22})\.([0-9]{10})\.([A-Za-z0-9_-]{43})', re.ASCII)
_DROPPED_HEADERS = {b'authorization', b'content-length', b'transfer-encoding', b'content-encoding'}
_WAV_TYPES = {'audio/wav', 'audio/x-wav', 'audio/wave'}


# ---- Configuration ----

@dataclass(frozen=True)
class DemoConfig:
    live: bool
    reason: str | None
    voice: bool
    caps: Caps
    env_name: str
    on_vercel: bool
    local: bool
    site_key: str
    secret_key: str
    session_secret: bytes
    hostnames: frozenset[str]
    jev_unit_micro: int
    end_at: float
    openai_key: str
    transcribe_model: str
    tts_model: str
    tts_voice: str

    @classmethod
    def closed(cls, reason: str) -> 'DemoConfig':
        return cls(live=False, reason=reason, voice=False, caps=Caps(0, 0, 0), env_name='local', on_vercel=False,
                   local=False, site_key='', secret_key='', session_secret=b'', hostnames=frozenset(),
                   jev_unit_micro=JEV_RANGE_MICRO[1], end_at=0.0, openai_key='', transcribe_model='', tts_model='',
                   tts_voice='')

    @classmethod
    def from_env(cls, env: Mapping[str, str], *, local: bool, settings: Settings | None) -> 'DemoConfig':
        try:
            return cls._from_env(env, local=local, settings=settings)
        except Exception as error:
            logger.error('Demo gateway: config error=%s', type(error).__name__)
            return cls.closed('misconfigured')

    @classmethod
    def _from_env(cls, env: Mapping[str, str], *, local: bool, settings: Settings | None) -> 'DemoConfig':
        problems: list[str] = []  # The first one is the reason config reports.
        on_vercel = bool(env.get('VERCEL') or env.get('__VC_HANDLER_ENTRYPOINT'))
        env_name = env.get('VERCEL_ENV', '').strip() or 'local'
        if not re.fullmatch(r'[a-z0-9_-]{1,32}', env_name):
            problems.append('misconfigured')
            env_name = 'invalid'
        if env.get('DEMO_ENABLED', '').strip().lower() != 'on':
            problems.append('disabled')
        try:
            caps = Caps(**{name: usd_to_micro(env.get(f'DEMO_{variable}_USD', DEFAULT_CAPS_USD[name]),
                                              Decimal(CEILINGS_USD[name]))
                           for name, variable in (('total', 'BUDGET_TOTAL'), ('day', 'BUDGET_DAILY'),
                                                  ('session', 'SESSION_BUDGET'))})
            jev_unit_micro = usd_to_micro(env.get('DEMO_JEV_CALL_USD', '0.01'), Decimal('0.05'))
            if jev_unit_micro < JEV_RANGE_MICRO[0]:
                raise ValueError('Jev price is below its floor')
        except ValueError:
            problems.append('budget_invalid')
            caps, jev_unit_micro = Caps(0, 0, 0), JEV_RANGE_MICRO[1]
        try:
            end_at = _utc_timestamp(env.get('DEMO_END_AT', DEFAULT_END_AT))
        except ValueError:
            problems.append('misconfigured')
            end_at = 0.0
        site_key, secret_key = env.get('TURNSTILE_SITE_KEY', '').strip(), env.get('TURNSTILE_SECRET_KEY', '').strip()
        if not site_key or not secret_key:
            problems.append('turnstile_unconfigured')
        session_secret = env.get('DEMO_SESSION_SECRET', '').strip().encode('utf-8')
        if len(session_secret) < 32:
            problems.append('session_secret_short')
        hostnames = _hostnames(env.get('DEMO_ALLOWED_HOSTNAMES', '') or env.get('VERCEL_PROJECT_PRODUCTION_URL', ''))
        if not hostnames and not local:
            problems.append('no_hostnames')
        if settings is None:
            problems.append('misconfigured')
        else:
            if any(model not in PRICES_NANO for model in (settings.summary_model, settings.agent_model,
                                                          settings.vision_model, settings.ocr_model)):
                problems.append('unpriced_model')
            if not (settings.nebius_api_key and settings.typesafe_api_key and settings.tavily_api_key):
                problems.append('provider_keys_missing')
            if urlsplit(settings.nebius_base_url).scheme != 'https':
                problems.append('misconfigured')
        if on_vercel:
            if local:
                problems.append('local_on_vercel')
            if env_name != 'production':
                problems.append('not_production')
            if _test_key(site_key) or _test_key(secret_key):
                problems.append('turnstile_test_keys')
        openai_key = env.get('OPENAI_API_KEY', '').strip()
        live = not problems
        return cls(live=live, reason=problems[0] if problems else None, voice=live and bool(openai_key), caps=caps,
                   env_name=env_name, on_vercel=on_vercel, local=local, site_key=site_key, secret_key=secret_key,
                   session_secret=session_secret, hostnames=hostnames, jev_unit_micro=jev_unit_micro, end_at=end_at,
                   openai_key=openai_key,
                   transcribe_model=env.get('OPENAI_TRANSCRIBE_MODEL', '').strip() or AUDIO_DEFAULTS['transcribe'],
                   tts_model=env.get('OPENAI_TTS_MODEL', '').strip() or AUDIO_DEFAULTS['tts'],
                   tts_voice=env.get('OPENAI_TTS_VOICE', '').strip() or AUDIO_DEFAULTS['voice'])

    def not_live(self, reason: str) -> 'DemoConfig':
        return replace(self, live=False, voice=False, reason=self.reason or reason)


def _utc_timestamp(value: str) -> float:
    moment = datetime.fromisoformat(value.strip())
    if moment.tzinfo is None:
        raise ValueError('DEMO_END_AT needs a time zone')
    return moment.timestamp()


def _hostnames(value: str) -> frozenset[str]:
    names = set()
    for item in value.split(','):
        item = item.strip().lower()
        host = urlsplit(item).hostname if '//' in item else item.split('/')[0].split(':')[0]
        if host:
            names.add(host)
    return frozenset(names)


def _test_key(key: str) -> bool:
    # Cloudflare's published dummy keys always pass, always fail or always challenge.
    return re.match(r'[123]x0000', key) is not None


def settings_from_env(env: Mapping[str, str]) -> Settings:
    """Settings.from_env() over a mapping, so the local runner and tests never mutate os.environ."""
    default = Settings()
    return Settings(
        typesafe_api_key=env.get('TYPESAFE_API_KEY', ''),
        nebius_api_key=env.get('NEBIUS_API_KEY', ''),
        tavily_api_key=env.get('TAVILY_API_KEY', ''),
        nebius_base_url=env.get('NEBIUS_BASE_URL', default.nebius_base_url).rstrip('/'),
        jev_model=env.get('JEV_MODEL', default.jev_model),
        summary_model=env.get('NEBIUS_SUMMARY_MODEL', default.summary_model),
        agent_model=env.get('NEBIUS_AGENT_MODEL', default.agent_model),
        vision_model=env.get('NEBIUS_VISION_MODEL', default.vision_model),
        ocr_model=env.get('NEBIUS_OCR_MODEL', default.ocr_model),
        ocr_reasoning_effort=env.get('NEBIUS_OCR_REASONING_EFFORT', default.ocr_reasoning_effort),
        summary_max_completion_tokens=int(env.get('NEBIUS_SUMMARY_MAX_TOKENS', default.summary_max_completion_tokens)),
        organization_max_completion_tokens=int(env.get('NEBIUS_ORGANIZATION_MAX_TOKENS',
                                                       default.organization_max_completion_tokens)),
        thought_organization_format=env.get('MOOLAI_THOUGHT_ORGANIZATION_FORMAT', default.thought_organization_format),
    )


# ---- Pricing and metering ----

def tokens(size: int) -> int:
    return math.ceil(size * TOKENS_PER_BYTE)


def chat_nano(model: str, tokens_in: int, tokens_out: int) -> int:
    price_in, price_out = PRICES_NANO[model]
    return tokens_in * price_in + tokens_out * price_out


def _micro(nano: int) -> int:
    return -(-nano // 1_000)


@dataclass
class ProviderCall:
    kind: Literal['nebius_chat', 'nebius_models', 'typesafe', 'tavily']
    model: str | None
    text_bytes: int
    has_image: bool
    max_out: int
    usage: tuple[int, int] | None = None

    def nano(self, jev_unit_micro: int) -> int:
        if self.kind == 'nebius_models':
            return 0
        if self.kind == 'tavily':
            return TAVILY_MICRO * 1_000
        if self.kind == 'typesafe':
            return jev_unit_micro * 1_000 * max(1, -(-self.text_bytes // JEV_UNIT_BYTES))
        if self.usage is not None:
            return chat_nano(self.model, *self.usage)
        # No usage (timeout, odd body): this call's own worst case, never the endpoint's reservation.
        return chat_nano(self.model, tokens(self.text_bytes) + (IMAGE_TOKENS if self.has_image else 0), self.max_out)


@dataclass
class Meter:
    calls: list[ProviderCall] = field(default_factory=list)

    def actual_micro(self, jev_unit_micro: int) -> int:
        return _micro(sum(call.nano(jev_unit_micro) for call in self.calls))


_meter: ContextVar[Meter | None] = ContextVar('moolai_demo_meter', default=None)


def _image_urls(messages: Any) -> list[str]:
    urls = []
    for message in messages if isinstance(messages, list) else []:
        content = message.get('content') if isinstance(message, dict) else None
        for item in content if isinstance(content, list) else []:
            if isinstance(item, dict) and item.get('type') == 'image_url':
                urls.append(item['image_url']['url'])
    return urls


def _provider_call(method: str, url: str, payload: Any, allowed_hosts: frozenset[str]) -> ProviderCall | None:
    """The call as it will be priced, or None when it must not be sent."""
    try:
        parts = urlsplit(str(url))
        host, path = parts.hostname, parts.path
        if (parts.scheme != 'https' or host not in allowed_hosts or parts.port not in (None, 443)
                or parts.username or parts.password):
            return None
        if host == TYPESAFE_HOST:
            kind = 'typesafe' if method == 'POST' and path == '/v1/systemone' else None
        elif host == TAVILY_HOST:
            kind = 'tavily' if method == 'POST' and path in ('/search', '/extract') else None
        elif method == 'GET' and path.endswith('/models'):
            return ProviderCall('nebius_models', None, 0, False, 0)
        else:
            kind = 'nebius_chat' if method == 'POST' and path.endswith('/chat/completions') else None
        if kind is None:
            return None
        # httpx's own encoding, so the size is the request's; unencodable text is refused here, not mid-send.
        size = len(json.dumps(payload, ensure_ascii=False, separators=(',', ':'), allow_nan=False).encode('utf-8'))
        if kind != 'nebius_chat':
            return ProviderCall(kind, None, size, False, 0)
        model, max_out = payload.get('model'), payload.get('max_completion_tokens')
        if model not in PRICES_NANO or type(max_out) is not int or max_out < 1:
            return None
        images = _image_urls(payload.get('messages'))
        # An image is priced as IMAGE_TOKENS, not as the base64 text that carries it.
        return ProviderCall(kind, model, size - sum(len(image.encode('utf-8')) for image in images),
                            bool(images), max_out)
    except (TypeError, ValueError, AttributeError, KeyError):
        return None


def _count(value: Any) -> bool:
    return type(value) is int and value >= 0


def _usage(response: httpx.Response) -> tuple[int, int] | None:
    try:
        if len(response.content) > 2_000_000:
            return None
        usage = response.json()['usage']
        prompt = usage['prompt_tokens']
        if not _count(prompt):
            return None
        options = [usage.get('completion_tokens')]
        if _count(usage.get('total_tokens')):
            options.append(usage['total_tokens'] - prompt)
        options = [value for value in options if _count(value)]
        return (prompt, max(options)) if options else None
    except Exception:
        return None


class MeteredClient:
    """What providers.Gateway gets as its client: it only calls request(), and the app only aclose()."""

    def __init__(self, allowed_hosts: frozenset[str], *, transport: httpx.AsyncBaseTransport | None = None):
        self.allowed_hosts = allowed_hosts
        self._transport = transport
        self._clients: dict[asyncio.AbstractEventLoop, httpx.AsyncClient] = {}

    def _client(self) -> httpx.AsyncClient:
        # A pooled client is bound to the loop that opened its connections. Keyed by the loop itself, not a weak
        # reference, because not every loop implementation supports one; closed loops are dropped instead.
        loop = asyncio.get_running_loop()
        client = self._clients.get(loop)
        if client is None:
            self._clients = {owner: other for owner, other in self._clients.items() if not owner.is_closed()}
            client = self._clients[loop] = httpx.AsyncClient(
                limits=httpx.Limits(max_connections=32, max_keepalive_connections=8), trust_env=False,
                transport=self._transport)
        return client

    async def request(self, method: str, url: str, **kw: Any) -> httpx.Response:
        meter = _meter.get()
        unpriced = any(name in kw for name in ('content', 'data', 'files'))  # Only a json= body is measured.
        call = _provider_call(method, url, kw.get('json'), self.allowed_hosts) if meter and not unpriced else None
        if meter is None or call is None:
            # providers.Gateway maps httpx errors to a ServiceError; nothing unmetered is ever sent.
            raise httpx.TransportError('Unmetered provider call refused')
        meter.calls.append(call)  # Before sending: a timed-out call may still be billed.
        response = await self._client().request(method, url, **kw)
        if call.kind == 'nebius_chat':
            call.usage = _usage(response)
        return response

    async def aclose(self) -> None:
        client = self._clients.pop(asyncio.get_running_loop(), None)
        if client is not None:
            await client.aclose()


def reserve_micro(endpoint: str, body_len: int, s: Settings, cfg: DemoConfig) -> int:
    if endpoint in ('route', 'tag', 'connect'):
        nano = cfg.jev_unit_micro * 1_000 * max(1, -(-body_len // JEV_UNIT_BYTES))
    elif endpoint == 'summarize':
        nano = chat_nano(s.summary_model, tokens(32_000), s.summary_max_completion_tokens)
    elif endpoint == 'consolidate':
        nano = chat_nano(s.summary_model, tokens(32_000), s.organization_max_completion_tokens)
    elif endpoint == 'respond':
        # Ultra, then Lightning's spoken summary when Ultra leaves a long answer unspoken.
        nano = (chat_nano(s.agent_model, tokens(min(body_len + RESPOND_OVERHEAD, s.agent_max_request_bytes)),
                          s.agent_max_tokens)
                + chat_nano(s.summary_model, tokens(48_000), s.summary_max_completion_tokens))
    elif endpoint == 'vision':
        nano = max(chat_nano(model, tokens(12_000) + IMAGE_TOKENS, 1_600) for model in (s.ocr_model, s.vision_model))
    elif endpoint in ('search', 'extract'):
        nano = TAVILY_MICRO * 1_000
    else:
        raise ValueError(f'No reservation for {endpoint}')
    return max(FLOOR_MICRO, _micro(nano))


def transcribe_micro(seconds: float) -> int:
    return max(FLOOR_MICRO, math.ceil(seconds * TRANSCRIBE_MICRO_PER_MINUTE / 60))


def speech_micro(text: str) -> int:
    weighted = len(text) + 4 * sum(char.isdigit() for char in text)
    return max(FLOOR_MICRO, weighted * SPEECH_MICRO_PER_CHAR)


# ---- Sessions, addresses and paths ----

@dataclass(frozen=True)
class Session:
    sid: str
    exp: int


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b'=').decode('ascii')


def _signature(secret: bytes, sid: str, exp: int | str) -> str:
    return _b64(hmac.new(secret, f'v1.{sid}.{exp}'.encode('ascii'), hashlib.sha256).digest())


def mint_token(secret: bytes, now: float) -> tuple[str, int]:
    sid, exp = _b64(secrets.token_bytes(16)), int(now) + SESSION_TTL_S
    return f'v1.{sid}.{exp}.{_signature(secret, sid, exp)}', exp


def verify_token(headers: list[tuple[bytes, bytes]], secret: bytes,
                 now: float) -> Session | Literal['expired', 'invalid']:
    values = [value for name, value in headers if name.lower() == b'authorization']
    if len(values) != 1 or len(values[0]) > 256:
        return 'invalid'
    try:
        match = _BEARER.fullmatch(values[0].decode('ascii'))
    except UnicodeDecodeError:
        return 'invalid'
    if match is None:
        return 'invalid'
    sid, exp, mac = match[1], int(match[2]), match[3]
    # Over the bytes as sent: a zero-padded expiry is a different message, never the same token.
    if not hmac.compare_digest(_signature(secret, sid, match[2]).encode('ascii'), mac.encode('ascii')):
        return 'invalid'
    if exp <= now:
        return 'expired'
    if exp > now + SESSION_TTL_S + TOKEN_SKEW_S:
        return 'invalid'
    return Session(sid, exp)


def _header(headers: list[tuple[bytes, bytes]], name: bytes) -> list[bytes]:
    return [value for key, value in headers if key.lower() == name]


def client_ip(scope: Scope, on_vercel: bool) -> str | None:
    if on_vercel:
        # Vercel's edge overwrites x-real-ip; anywhere else a visitor could set it.
        values = _header(scope.get('headers', []), b'x-real-ip')
        raw = values[0].decode('latin-1').strip() if len(values) == 1 else ''
    else:
        client = scope.get('client')
        raw = client[0] if client else ''
    try:
        return str(ipaddress.ip_address(raw))
    except ValueError:
        return None


def ip_key(ip: str | None, secret: bytes) -> str:
    bucket = 'unknown'
    if ip:
        address = ipaddress.ip_address(ip)
        if address.version == 6 and address.ipv4_mapped:
            address = address.ipv4_mapped
        # One IPv6 visitor usually holds a whole /64.
        bucket = str(ipaddress.ip_network(f'{address}/64', strict=False)) if address.version == 6 else str(address)
    return hmac.new(secret, bucket.encode('ascii'), hashlib.sha256).hexdigest()[:16]


def url_key(url: str, secret: bytes) -> str | None:
    """The same resource key Tavily extraction checks: scheme and host case, default port and fragment ignored."""
    if not isinstance(url, str):
        return None
    try:
        parts = urlsplit(url)
        scheme, host, port = parts.scheme.lower(), parts.hostname, parts.port
    except (ValueError, AttributeError):
        return None
    if scheme not in ('http', 'https') or not host or parts.username or parts.password:
        return None
    if ':' in host:
        host = f'[{host}]'
    if port is not None and (scheme, port) not in (('http', 80), ('https', 443)):
        host += f':{port}'
    normalised = urlunsplit((scheme, host, parts.path or '/', parts.query, ''))
    try:
        return hmac.new(secret, normalised.encode('utf-8'), hashlib.sha256).hexdigest()[:16]
    except UnicodeEncodeError:
        return None


def recover_path(scope: Scope) -> tuple[str, str] | None:
    """The public path and how it arrived: as sent ('original'), or via vercel.json's /api?__path= ('rewrite')."""
    path = scope.get('path', '')
    if path not in ('/api', '/api/index'):
        return path, 'original'
    pairs = parse_qsl(scope.get('query_string', b'').decode('latin-1'), keep_blank_values=True)
    values = [value for name, value in pairs if name == '__path']
    if len(values) != 1 or len(values[0]) > 64 or not _REWRITTEN.fullmatch(values[0]):
        return None
    return '/api/' + values[0], 'rewrite'


class TooLarge(Exception):
    pass


async def read_body(receive: Receive, headers: list[tuple[bytes, bytes]], cap: int) -> bytes | None:
    for declared in _header(headers, b'content-length'):
        try:
            if int(declared) > cap:
                raise TooLarge
        except ValueError:
            pass  # The server already framed the body; count what arrives.
    chunks, size = [], 0
    while True:
        message = await receive()
        if message['type'] == 'http.disconnect':
            return None
        if message['type'] != 'http.request':
            continue
        chunk = message.get('body', b'')
        size += len(chunk)
        if size > cap:
            raise TooLarge
        chunks.append(chunk)
        if not message.get('more_body', False):
            return b''.join(chunks)


def replay_then_block(body: bytes) -> Receive:
    """The inner app reads the body in one receive; its disconnect watcher then waits until it is cancelled."""
    delivered = False

    async def receive() -> dict[str, Any]:
        nonlocal delivered
        if not delivered:
            delivered = True
            return {'type': 'http.request', 'body': body, 'more_body': False}
        await asyncio.get_running_loop().create_future()
        return {'type': 'http.disconnect'}
    return receive


def _media_type(headers: list[tuple[bytes, bytes]]) -> str | None:
    values = _header(headers, b'content-type')
    return values[0].decode('latin-1').split(';', 1)[0].strip().lower() if len(values) == 1 else None


def _prompt(headers: list[tuple[bytes, bytes]]) -> str | None:
    values = _header(headers, b'x-moolai-prompt')
    if not values:
        return ''
    if len(values) > 1 or len(values[0]) > 5_000:
        return None
    try:
        prompt = ' '.join(unquote(values[0].decode('ascii'), errors='strict').split())
    except UnicodeDecodeError:
        return None
    if len(prompt) > 400 or any(unicodedata.category(char) in ('Cc', 'Cs') for char in prompt):
        return None
    return prompt


def _iso(timestamp: int) -> str:
    return datetime.fromtimestamp(timestamp, timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')


async def _send(send: Send, status: int, body: bytes, *, content_type: bytes = b'application/json',
                cache: str = NO_STORE, extra: tuple[tuple[bytes, bytes], ...] = ()) -> None:
    headers = [(b'content-type', content_type), (b'content-length', str(len(body)).encode('ascii')),
               (b'cache-control', cache.encode('ascii')), (b'x-content-type-options', b'nosniff'), *extra]
    try:
        await send({'type': 'http.response.start', 'status': status, 'headers': headers})
        await send({'type': 'http.response.body', 'body': body})
    except OSError:
        pass  # The visitor left; the call was already settled.


async def _json(send: Send, status: int, value: Any, **options: Any) -> None:
    await _send(send, status, json.dumps(value, separators=(',', ':')).encode('ascii'), **options)


async def _error(send: Send, status: int, detail: str) -> None:
    await _json(send, status, {'detail': detail})


class _Buffered:
    """The inner response, held until the call is settled."""

    def __init__(self):
        self.status: int | None = None
        self.headers: list[tuple[bytes, bytes]] = []
        self.chunks: list[bytes] = []
        self.size = 0

    async def send(self, message: dict[str, Any]) -> None:
        if message['type'] == 'http.response.start':
            self.status, self.headers = message['status'], list(message.get('headers', []))
        elif message['type'] == 'http.response.body':
            body = message.get('body', b'')
            self.size += len(body)
            if self.size > MAX_INNER_RESPONSE:
                raise ValueError('Inner response is too large')
            self.chunks.append(body)

    def body(self) -> bytes:
        return b''.join(self.chunks)

    async def replay(self, send: Send) -> None:
        content_type = next(iter(_header(self.headers, b'content-type')), b'application/json')
        await _send(send, self.status, self.body(), content_type=content_type)


class DisabledStore:
    """Nothing a visitor says is stored, and /v1/records/accept is not exposed either."""

    async def accept(self, _record: Any, _operation_id: str) -> int:
        from .providers import ServiceError
        raise ServiceError('Record storage is off in the web demo', 503)


# ---- The gateway ----

class DemoGateway:
    def __init__(self, cfg: DemoConfig, settings: Settings | None, inner: ASGIApp | None, internal_token: str,
                 counters: Counters | None, metered: MeteredClient | None, audio: DemoAudio | None,
                 http: Callable[[], httpx.AsyncClient] | None, clock: Callable[[], float]):
        self.cfg = cfg
        self.settings = settings
        self.inner = inner
        self.internal_token = internal_token
        self.counters = counters
        self.metered = metered
        self.audio = audio
        self.http = http
        self.clock = clock
        self._status_cache: tuple[float, Status | None] | None = None
        self._selftest_cache: tuple[float, dict[str, bool]] | None = None
        self._closed: tuple[float, str, str | None] | None = None  # (until, detail, UTC day or None)
        self._voice_off_until = 0.0

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope['type'] == 'lifespan':
            return await self._lifespan(receive, send)
        if scope['type'] != 'http':
            return
        started = False

        async def tracked(message: dict[str, Any]) -> None:
            nonlocal started
            started = True
            await send(message)
        try:
            await self._dispatch(scope, receive, tracked)
        except Exception as error:
            logger.error('Demo gateway: unhandled error=%s', type(error).__name__)
            if not started:
                await _error(send, 500, 'internal_error')

    async def _lifespan(self, receive: Receive, send: Send) -> None:
        while True:
            message = await receive()
            if message['type'] == 'lifespan.startup':
                if not self.cfg.live:
                    logger.warning('Demo gateway: not live reason=%s', self.cfg.reason)
                await send({'type': 'lifespan.startup.complete'})
            elif message['type'] == 'lifespan.shutdown':
                if self.metered is not None:
                    try:
                        await self.metered.aclose()
                    except Exception as error:
                        logger.warning('Demo gateway: close error=%s', type(error).__name__)
                await send({'type': 'lifespan.shutdown.complete'})
                return

    async def _dispatch(self, scope: Scope, receive: Receive, send: Send) -> None:
        recovered = recover_path(scope)
        route = ROUTES.get(recovered[0]) if recovered else None
        if route is None:
            return await _error(send, 404, 'not_found')
        method, name = route
        if scope.get('method') != method:
            return await _json(send, 405, {'detail': 'method_not_allowed'}, extra=((b'allow', method.encode()),))
        if name == 'health':
            return await _json(send, 200, {'status': 'ok', 'service': 'moolai-demo-gateway'})
        if name == 'config':
            return await self._config(send)
        if name == 'selftest':
            return await self._selftest(send, recovered[1])
        if name == 'session':
            return await self._mint(scope, receive, send)
        if name == 'transcribe':
            return await self._transcribe(scope, receive, send)
        if name == 'speech':
            return await self._speech(scope, receive, send)
        return await self._guarded(name, scope, receive, send)

    # -- live state --

    def _not_live(self) -> str | None:
        if not self.cfg.live:
            return self.cfg.reason or 'misconfigured'
        if self.clock() >= self.cfg.end_at:
            return 'ended'
        return None

    def _closed_detail(self) -> str | None:
        if self._closed is None:
            return None
        until, detail, day = self._closed
        now = self.clock()
        if now >= until or (day is not None and day != utc_day(now)):
            self._closed = None
            return None
        return detail

    def _close(self, detail: str, day: str | None) -> None:
        self._closed = (self.clock() + CLOSED_CACHE_S, detail, day)

    async def _status(self) -> Status | None:
        now = self.clock()
        if self._status_cache is not None:
            read_at, status = self._status_cache
            if now - read_at < (CONFIG_CACHE_S if status is not None else STATUS_ERROR_CACHE_S):
                return status
        try:
            status = await self.counters.status(utc_day(now))
        except CounterError:
            logger.warning('Demo gateway: status_failed')
            status = None
        self._status_cache = (now, status)
        if status is not None:
            if status.off:
                self._close('demo_unavailable', None)
            elif self.cfg.caps.total - status.total < FLOOR_MICRO:
                self._close('demo_budget_exhausted', None)
            elif self.cfg.caps.day - status.day < FLOOR_MICRO:
                self._close('demo_budget_exhausted', utc_day(now))
        return status

    def _budget(self, status: Status | None) -> Literal['ok', 'low', 'exhausted']:
        if status is None:
            return 'ok'
        remaining = min(self.cfg.caps.total - status.total, self.cfg.caps.day - status.day)
        # Exhausted once a typical answer no longer fits, not only at zero.
        if remaining < reserve_micro('respond', 20_000, self.settings, self.cfg):
            return 'exhausted'
        return 'low' if remaining < self.cfg.caps.day // 5 else 'ok'

    def _voice_available(self, status: Status | None) -> bool:
        return (self.cfg.voice and self.clock() >= self._voice_off_until
                and not (status is not None and status.voice_off))

    async def _config(self, send: Send) -> None:
        reason, status = self._not_live(), None
        if reason is None:
            status = await self._status()
            if status is None:
                reason = 'counters_unavailable'
            elif status.off:
                reason = 'off'
        budget = self._budget(status)
        if reason is None and budget == 'exhausted':
            reason = 'budget_exhausted'
        body: dict[str, Any] = {'live': reason is None, 'voice': reason is None and self._voice_available(status),
                                'turnstileSiteKey': self.cfg.site_key, 'budget': budget}
        if reason is not None:
            body['reason'] = reason
        await _json(send, 200, body, cache=CONFIG_CACHE)

    async def _selftest(self, send: Send, path_mode: str) -> None:
        now = self.clock()
        if self._selftest_cache is not None and now - self._selftest_cache[0] < SELFTEST_CACHE_S:
            checks = self._selftest_cache[1]
        else:
            checks = {'configured': self._not_live() is None, 'counters': False, 'reserveSettle': False,
                      'inner': await self._inner_ok(), 'voice': self.cfg.voice}
            if self.counters is not None:
                try:
                    checks['counters'] = await self.counters.ping()
                    checks['reserveSettle'] = await self._round_trip(now)
                except CounterError:
                    pass
            self._selftest_cache = (now, checks)
        await _json(send, 200, {'ok': all(checks.values()), 'checks': checks, 'pathMode': path_mode},
                    cache=SELFTEST_CACHE)

    async def _round_trip(self, now: float) -> bool:
        counters = self.counters.selftest()
        reservation = Reservation('selftest', 'selftest', utc_day(now), 1)
        outcome, _ = await counters.reserve(reservation, SELFTEST_CAPS, 1_000_000)
        if outcome is not Outcome.OK:
            return False
        await counters.settle(reservation, -1)
        return True

    async def _inner_ok(self) -> bool:
        """An inner /v1/connect with no candidates: authentication and validation, and no provider call."""
        if self.inner is None:
            return False
        body = json.dumps({'record': SELFTEST_RECORD, 'candidates': []}).encode('ascii')
        scope = {'type': 'http', 'asgi': {'version': '3.0'}, 'http_version': '1.1', 'method': 'POST',
                 'scheme': 'https', 'path': '/v1/connect', 'raw_path': b'/v1/connect', 'root_path': '',
                 'query_string': b'', 'client': None, 'server': None,
                 'headers': _forward_headers([(b'content-type', b'application/json')], self.internal_token, len(body))}
        buffered = _Buffered()
        try:
            await self.inner(scope, replay_then_block(body), buffered.send)
        except Exception:
            return False
        return buffered.status == 200 and buffered.body() == b'{}'

    # -- sessions --

    async def _mint(self, scope: Scope, receive: Receive, send: Send) -> None:
        if self._not_live() is not None:
            return await _error(send, 503, 'demo_unavailable')
        closed = self._closed_detail()
        if closed is not None:
            return await _error(send, 503, closed)
        read = await self._read_json(scope, receive, send, BODY_CAPS['session'])
        if read is None:
            return
        token = read[0].get('turnstileToken')
        if not isinstance(token, str) or not token or len(token) > 2_048 or not token.isascii():
            return await _error(send, 403, 'turnstile_failed')
        ip = client_ip(scope, self.cfg.on_vercel)
        verdict = await self._siteverify(token, ip)
        if verdict is None:
            return await _error(send, 503, 'demo_unavailable')
        if not verdict:
            return await _error(send, 403, 'turnstile_failed')
        # Only verified mints count, so a flood of unsolved tokens cannot use up the day's sessions.
        now = self.clock()
        try:
            allowed = await self.counters.allow_mint(ip_key(ip, self.cfg.session_secret), now,
                                                     MINT_PER_IP_HOUR, MINT_PER_DAY)
        except CounterError:
            logger.warning('Demo gateway: mint_count_failed')
            return await _error(send, 503, 'demo_unavailable')
        if not allowed:
            return await _error(send, 429, 'session_rate_limited')
        session_token, exp = mint_token(self.cfg.session_secret, now)
        await _json(send, 200, {'token': session_token, 'expiresAt': _iso(exp)})

    async def _siteverify(self, token: str, ip: str | None) -> bool | None:
        """True, False, or None when Cloudflare could not answer."""
        payload = {'secret': self.cfg.secret_key, 'response': token, 'idempotency_key': str(uuid.uuid4())}
        if ip:
            payload['remoteip'] = ip
        data = None
        for _attempt in range(2):  # The same idempotency key, so a retry cannot count twice.
            try:
                response = await self.http().post(SITEVERIFY_URL, json=payload, timeout=TURNSTILE_TIMEOUT,
                                                  follow_redirects=False)
            except httpx.HTTPError as error:
                logger.warning('Demo gateway: siteverify_unreachable error=%s', type(error).__name__)
                continue
            if response.status_code >= 500:
                logger.warning('Demo gateway: siteverify_failed status=%d', response.status_code)
                continue
            try:
                data = response.json()
            except ValueError:
                data = {}
            break
        else:
            return None
        if not isinstance(data, dict) or data.get('success') is not True:
            return False
        if self.cfg.local:
            return True  # Cloudflare's test keys report neither our action nor our hostname.
        hostname = data.get('hostname')
        return (data.get('action') == TURNSTILE_ACTION and isinstance(hostname, str)
                and hostname.lower() in self.cfg.hostnames)

    async def _authorize(self, scope: Scope, send: Send) -> Session | None:
        """Steps 2 to 4 of every guarded call: live, session token, and the in-process 'exhausted' cache."""
        if self._not_live() is not None:
            await _error(send, 503, 'demo_unavailable')
            return None
        session = verify_token(scope.get('headers', []), self.cfg.session_secret, self.clock())
        if not isinstance(session, Session):
            await _error(send, 401, 'session_expired' if session == 'expired' else 'invalid_session')
            return None
        closed = self._closed_detail()
        if closed is not None:
            await _error(send, 503, closed)
            return None
        return session

    async def _read_json(self, scope: Scope, receive: Receive, send: Send,
                         cap: int) -> tuple[dict[str, Any], bytes] | None:
        headers = scope.get('headers', [])
        if _media_type(headers) != 'application/json':
            await _error(send, 415, 'unsupported_media_type')
            return None
        try:
            body = await read_body(receive, headers, cap)
        except TooLarge:
            await _error(send, 413, 'body_too_large')
            return None
        if body is None:
            return None
        try:
            # Stdlib json, as Starlette parses it, so a duplicate key resolves the same way for both of us.
            value = json.loads(body)
        except (ValueError, RecursionError):
            value = None
        if not isinstance(value, dict):
            await _error(send, 422, 'invalid_json')
            return None
        return value, body

    # -- reservations --

    async def _reserve(self, reservation: Reservation, send: Send) -> bool:
        try:
            outcome, _ = await self.counters.reserve(reservation, self.cfg.caps, QUOTAS[reservation.endpoint])
        except CounterError:
            logger.warning('Demo gateway: reserve_failed endpoint=%s', reservation.endpoint)
            await _error(send, 503, 'demo_unavailable')
            return False
        if outcome is Outcome.OK:
            return True
        if outcome in (Outcome.QUOTA, Outcome.SESSION_BUDGET):
            await _error(send, 429, 'session_limit')
            return False
        detail = 'demo_unavailable' if outcome is Outcome.OFF else 'demo_budget_exhausted'
        self._close(detail, reservation.day if outcome is Outcome.DAY_BUDGET else None)
        await _error(send, 503, detail)
        return False

    async def _settle(self, reservation: Reservation, actual: int) -> None:
        delta = actual - reservation.amount
        try:
            await self.counters.settle(reservation, delta)
        except CounterError:
            # The reservation stands, which over-counts; the visitor still gets the answer.
            logger.warning('Demo gateway: settle_failed endpoint=%s delta=%d', reservation.endpoint, delta)

    # -- guarded backend calls --

    async def _guarded(self, name: str, scope: Scope, receive: Receive, send: Send) -> None:
        session = await self._authorize(scope, send)
        if session is None:
            return
        read = await self._read_json(scope, receive, send, BODY_CAPS[name])
        if read is None:
            return
        value, body = read
        if name == 'vision' and not _worksheet(value):
            return await _error(send, 403, 'image_not_allowed')
        if name == 'extract':
            allowed = await self._extract_allowed(value, session.sid)
            if allowed is None:
                return await _error(send, 503, 'demo_unavailable')
            if not allowed:
                return await _error(send, 403, 'extract_not_allowed')
        reservation = Reservation(name, session.sid, utc_day(self.clock()),
                                  reserve_micro(name, len(body), self.settings, self.cfg))
        if not await self._reserve(reservation, send):
            return
        meter = Meter()
        buffered = await self._forward(name, scope, body, meter)
        if name == 'search' and buffered.status == 200:
            await self._record_results(session.sid, buffered.body())
        await self._settle(reservation, max(FLOOR_MICRO, meter.actual_micro(self.cfg.jev_unit_micro)))
        await buffered.replay(send)

    async def _forward(self, name: str, scope: Scope, body: bytes, meter: Meter) -> _Buffered:
        child = {**scope, 'path': f'/v1/{name}', 'raw_path': f'/v1/{name}'.encode('ascii'), 'root_path': '',
                 'query_string': b'', 'headers': _forward_headers(scope.get('headers', []), self.internal_token,
                                                                  len(body))}
        buffered = _Buffered()
        # The inner app's provider tasks copy this context, so both respond calls land on this meter.
        token = _meter.set(meter)
        try:
            await self.inner(child, replay_then_block(body), buffered.send)
        except Exception as error:
            logger.error('Demo gateway: inner_error=%s endpoint=%s', type(error).__name__, name)
            buffered = _Buffered()
        finally:
            _meter.reset(token)
        if buffered.status is None:
            buffered = _Buffered()
            await buffered.send({'type': 'http.response.start', 'status': 502, 'headers': []})
            await buffered.send({'type': 'http.response.body', 'body': b'{"detail":"provider_failed"}'})
        return buffered

    async def _extract_allowed(self, value: dict[str, Any], sid: str) -> bool | None:
        urls = value.get('urls')
        if not isinstance(urls, list) or not 1 <= len(urls) <= 3 or not all(isinstance(url, str) for url in urls):
            return False
        hashes = [url_key(url, self.cfg.session_secret) for url in urls]
        if any(item is None for item in hashes):
            return False
        try:
            return await self.counters.urls_allowed(sid, hashes)
        except CounterError:
            logger.warning('Demo gateway: url_check_failed')
            return None

    async def _record_results(self, sid: str, body: bytes) -> None:
        try:
            results = json.loads(body)['results']
            hashes = sorted({item for result in results if (item := url_key(result['url'], self.cfg.session_secret))})
        except (ValueError, KeyError, TypeError):
            return
        if hashes:
            try:
                await self.counters.record_urls(sid, hashes)
            except CounterError:
                logger.warning('Demo gateway: url_record_failed')

    # -- speech --

    async def _voice_session(self, scope: Scope, send: Send) -> Session | None:
        session = await self._authorize(scope, send)
        if session is not None and not self._voice_available(self._fresh_status()):
            await _error(send, 503, 'voice_unavailable')
            return None
        return session

    def _fresh_status(self) -> Status | None:
        """The status config last read, while it is fresh; voice calls never read the counters themselves."""
        if self._status_cache is None or self.clock() - self._status_cache[0] >= CONFIG_CACHE_S:
            return None
        return self._status_cache[1]

    async def _transcribe(self, scope: Scope, receive: Receive, send: Send) -> None:
        session = await self._voice_session(scope, send)
        if session is None:
            return
        headers = scope.get('headers', [])
        if _media_type(headers) not in _WAV_TYPES:
            return await _error(send, 415, 'unsupported_media_type')
        prompt = _prompt(headers)
        if prompt is None:
            return await _error(send, 422, 'invalid_audio')
        try:
            wav = await read_body(receive, headers, BODY_CAPS['transcribe'])
        except TooLarge:
            return await _error(send, 413, 'body_too_large')
        if wav is None:
            return
        try:
            seconds = wav_seconds(wav)
        except AudioError as error:
            return await _error(send, error.status, error.code)
        reservation = Reservation('transcribe', session.sid, utc_day(self.clock()), transcribe_micro(seconds))
        if not await self._reserve(reservation, send):
            return
        try:
            text = await self.audio.transcribe(wav, prompt)
        except AudioError as error:
            await self._audio_failed(reservation, error)
            return await _error(send, error.status, error.code)
        await self._settle(reservation, reservation.amount)
        await _json(send, 200, {'text': text})

    async def _speech(self, scope: Scope, receive: Receive, send: Send) -> None:
        session = await self._voice_session(scope, send)
        if session is None:
            return
        read = await self._read_json(scope, receive, send, BODY_CAPS['speech'])
        if read is None:
            return
        try:
            text = clean_speech_text(read[0].get('text'))
        except AudioError as error:
            return await _error(send, error.status, error.code)
        reservation = Reservation('speech', session.sid, utc_day(self.clock()), speech_micro(text))
        if not await self._reserve(reservation, send):
            return
        try:
            audio = await self.audio.speak(text)
        except AudioError as error:
            await self._audio_failed(reservation, error)
            return await _error(send, error.status, error.code)
        await self._settle(reservation, reservation.amount)
        await _send(send, 200, audio, content_type=b'audio/mpeg')

    async def _audio_failed(self, reservation: Reservation, error: AudioError) -> None:
        if error.voice_off:
            # OpenAI's hard limit was reached: every instance stops offering voice for an hour.
            self._voice_off_until = self.clock() + VOICE_OFF_S
            try:
                await self.counters.set_voice_off(VOICE_OFF_S)
            except CounterError:
                logger.warning('Demo gateway: voice_off_failed')
        logger.warning('Demo gateway: audio_failed endpoint=%s status=%d', reservation.endpoint, error.status)
        await self._settle(reservation, reservation.amount if error.billed else FLOOR_MICRO)


def _forward_headers(headers: list[tuple[bytes, bytes]], token: str, length: int) -> list[tuple[bytes, bytes]]:
    kept = [(name, value) for name, value in headers if name.lower() not in _DROPPED_HEADERS]
    return kept + [(b'authorization', f'Bearer {token}'.encode('ascii')),
                   (b'content-length', str(length).encode('ascii'))]


def _worksheet(value: dict[str, Any]) -> bool:
    image = value.get('image')
    if (not isinstance(image, dict) or image.get('mimeType') != 'image/png'
            or not isinstance(image.get('dataBase64'), str)):
        return False
    try:
        data = base64.b64decode(image['dataBase64'], validate=True)
    except ValueError:
        return False
    return hashlib.sha256(data).hexdigest() == WORKSHEET_SHA256


def _closed_gateway(reason: str, clock: Callable[[], float]) -> DemoGateway:
    return DemoGateway(DemoConfig.closed(reason), None, None, '', None, None, None, None, clock)


def create_demo_app(env: Mapping[str, str] | None = None, *, transport: httpx.AsyncBaseTransport | None = None,
                    counters: Counters | None = None, local: bool = False,
                    clock: Callable[[], float] = time.time) -> ASGIApp:
    """Never raises: any failure gives a gateway whose config reports live:false."""
    try:
        source = os.environ if env is None else env
        from .app import create_app
        settings = replace(settings_from_env(source), **DEMO_OVERRIDES, backend_token=secrets.token_urlsafe(32))
        cfg = DemoConfig.from_env(source, local=local, settings=settings)
        hosts = {TYPESAFE_HOST, TAVILY_HOST, urlsplit(settings.nebius_base_url).hostname}
        metered = MeteredClient(frozenset(host for host in hosts if host), transport=transport)
        if counters is None:
            counters = UpstashCounters.from_env(source, Keys(cfg.env_name), metered._client)
            if counters is None:
                cfg = cfg.not_live('counters_unconfigured')
        elif cfg.on_vercel and isinstance(counters, MemoryCounters):
            cfg = cfg.not_live('local_on_vercel')
        inner = create_app(settings, http_client=metered, store=DisabledStore())
        audio = DemoAudio(cfg.openai_key, cfg.transcribe_model, cfg.tts_model, cfg.tts_voice, metered._client)
        return DemoGateway(cfg, settings, inner, settings.backend_token, counters, metered, audio, metered._client,
                           clock)
    except Exception as error:
        logger.error('Demo gateway: misconfigured error=%s', type(error).__name__)
        return _closed_gateway('misconfigured', clock)
