"""Web demo spending counters: integer micro-dollars in Upstash Redis, or in memory for local runs.

Each check-and-charge is one Lua script, so concurrent function instances cannot both spend the
last of a budget. Any counter failure raises CounterError and the caller refuses the request.
"""
import asyncio
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import ROUND_FLOOR, Decimal, InvalidOperation
from enum import IntEnum
from typing import Any, Protocol
from urllib.parse import urlsplit

import httpx

MICRO_PER_USD = 1_000_000
SESSION_KEY_TTL_S = 10_800
DAY_KEY_TTL_S = 259_200
MINT_IP_TTL_S = 7_200
MINT_DAY_TTL_S = 172_800
UPSTASH_TIMEOUT = httpx.Timeout(3.0, connect=2.0)

# KEYS: total, day, session (hash), off
# ARGV: amount, total_cap, day_cap, session_cap, quota_field, quota_limit, session_ttl, day_ttl
RESERVE = """\
if redis.call('EXISTS', KEYS[4]) == 1 then return {-5, 0} end
local a = tonumber(ARGV[1])
local q = tonumber(redis.call('HGET', KEYS[3], ARGV[5]) or '0')
if q >= tonumber(ARGV[6]) then return {-1, q} end
local s = tonumber(redis.call('HGET', KEYS[3], 'spend') or '0')
if s + a > tonumber(ARGV[4]) then return {-2, s} end
local d = tonumber(redis.call('GET', KEYS[2]) or '0')
if d + a > tonumber(ARGV[3]) then return {-3, d} end
local t = tonumber(redis.call('GET', KEYS[1]) or '0')
if t + a > tonumber(ARGV[2]) then return {-4, t} end
redis.call('HINCRBY', KEYS[3], ARGV[5], 1); redis.call('HINCRBY', KEYS[3], 'spend', a)
redis.call('EXPIRE', KEYS[3], tonumber(ARGV[7]))
redis.call('INCRBY', KEYS[2], a); redis.call('EXPIRE', KEYS[2], tonumber(ARGV[8]))
redis.call('INCRBY', KEYS[1], a)
return {1, t + a}
"""
# KEYS: total, day, session   ARGV: delta, session_ttl, day_ttl
SETTLE = """\
local x = tonumber(ARGV[1]); if x == 0 then return 0 end
redis.call('INCRBY', KEYS[1], x)
redis.call('INCRBY', KEYS[2], x); redis.call('EXPIRE', KEYS[2], tonumber(ARGV[3]))
redis.call('HINCRBY', KEYS[3], 'spend', x); redis.call('EXPIRE', KEYS[3], tonumber(ARGV[2]))
return 1
"""
# KEYS: ip_hour, day   ARGV: ip_limit, ip_ttl, day_limit, day_ttl
MINT = """\
local n = redis.call('INCR', KEYS[1]); if n == 1 then redis.call('EXPIRE', KEYS[1], tonumber(ARGV[2])) end
if n > tonumber(ARGV[1]) then return -1 end
local g = redis.call('INCR', KEYS[2]); if g == 1 then redis.call('EXPIRE', KEYS[2], tonumber(ARGV[4])) end
if g > tonumber(ARGV[3]) then return -2 end
return 1
"""
# KEYS: url_set   ARGV: ttl, hash...   (only called with at least one hash)
URLS = """\
redis.call('SADD', KEYS[1], unpack(ARGV, 2)); redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1])); return 1
"""


class CounterError(Exception):
    """A counter command failed. It never carries a reply body; callers fail closed."""


class Outcome(IntEnum):
    OK = 1
    QUOTA = -1
    SESSION_BUDGET = -2
    DAY_BUDGET = -3
    TOTAL_BUDGET = -4
    OFF = -5


@dataclass(frozen=True)
class Caps:
    """Micro-dollars."""
    total: int
    day: int
    session: int


@dataclass(frozen=True)
class Reservation:
    endpoint: str
    sid: str
    day: str  # Fixed at reserve time, so a settle after midnight corrects the day it charged.
    amount: int


@dataclass(frozen=True)
class Status:
    total: int
    day: int
    off: bool
    voice_off: bool


class Keys:
    """Every key lives under moolai:demo:{env}:, so preview and production never share counters."""

    def __init__(self, env_name: str, prefix: str | None = None):
        self.prefix = prefix or f'moolai:demo:{env_name}:'

    def total(self) -> str: return self.prefix + 'total'
    def day(self, d: str) -> str: return f'{self.prefix}day:{d}'
    def session(self, sid: str) -> str: return f'{self.prefix}session:{sid}'
    def urls(self, sid: str) -> str: return f'{self.prefix}urls:{sid}'
    def mint_ip(self, h: str, hour: str) -> str: return f'{self.prefix}mint:ip:{h}:{hour}'
    def mint_day(self, d: str) -> str: return f'{self.prefix}mint:day:{d}'
    def off(self) -> str: return self.prefix + 'off'
    def voice_off(self) -> str: return self.prefix + 'voice_off'

    def selftest(self) -> 'Keys':
        return Keys('', self.prefix + 'selftest:')


class Counters(Protocol):
    keys: Keys
    async def reserve(self, r: Reservation, caps: Caps, quota_limit: int) -> tuple[Outcome, int]: ...
    async def settle(self, r: Reservation, delta: int) -> None: ...
    async def allow_mint(self, ip_key: str, now: float, per_ip_hour: int, per_day: int) -> bool: ...
    async def record_urls(self, sid: str, hashes: list[str]) -> None: ...
    async def urls_allowed(self, sid: str, hashes: list[str]) -> bool: ...
    async def status(self, day: str) -> Status: ...
    async def set_voice_off(self, ttl_s: int) -> None: ...
    async def ping(self) -> bool: ...
    def selftest(self) -> 'Counters': ...


def utc_day(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%d')


def utc_hour(now: float) -> str:
    return datetime.fromtimestamp(now, timezone.utc).strftime('%Y-%m-%dT%H')


def usd_to_micro(value: str, ceiling: Decimal) -> int:
    try:
        amount = Decimal(value.strip())
    except (InvalidOperation, AttributeError):
        raise ValueError('Not a dollar amount') from None
    if not amount.is_finite() or not 0 < amount <= ceiling:
        raise ValueError('Dollar amount out of range')
    micro = int((amount * MICRO_PER_USD).to_integral_value(rounding=ROUND_FLOOR))
    if micro < 1:
        raise ValueError('Dollar amount out of range')
    return micro


def _integer(value: Any) -> int:
    if value is None:
        return 0
    if isinstance(value, bool) or not isinstance(value, (int, str)):
        raise CounterError('Counter value is not an integer')
    try:
        return int(value)
    except ValueError:
        raise CounterError('Counter value is not an integer') from None


def _outcome(result: Any) -> tuple[Outcome, int]:
    if not isinstance(result, list) or len(result) != 2:
        raise CounterError('Unexpected reserve reply')
    try:
        return Outcome(_integer(result[0])), _integer(result[1])
    except ValueError:
        raise CounterError('Unexpected reserve reply') from None


class UpstashCounters:
    """Upstash's REST API: POST the command as a JSON array with a Bearer token."""

    def __init__(self, url: str, token: str, keys: Keys, client: Callable[[], httpx.AsyncClient]):
        self.url = url
        self._token = token
        self.keys = keys
        self._client = client

    @classmethod
    def from_env(cls, env: Mapping[str, str], keys: Keys,
                 client: Callable[[], httpx.AsyncClient]) -> 'UpstashCounters | None':
        for prefix in ('KV_REST_API', 'UPSTASH_REDIS_REST'):
            url, token = env.get(f'{prefix}_URL', '').strip(), env.get(f'{prefix}_TOKEN', '').strip()
            if not url or not token:
                continue
            try:
                parts = urlsplit(url)
                valid = (parts.scheme == 'https' and bool(parts.hostname) and parts.port in (None, 443)
                         and not (parts.username or parts.password or parts.query or parts.fragment))
            except ValueError:
                valid = False
            # The first configured pair decides; an insecure URL never falls back to the other.
            return cls(url.rstrip('/'), token, keys, client) if valid else None
        return None

    def selftest(self) -> 'UpstashCounters':
        return UpstashCounters(self.url, self._token, self.keys.selftest(), self._client)

    async def _command(self, *args: object) -> Any:
        body = [str(arg) for arg in args]
        headers = {'Authorization': f'Bearer {self._token}'}
        for attempt in range(2):
            try:
                response = await self._client().post(self.url, json=body, headers=headers,
                                                     timeout=UPSTASH_TIMEOUT, follow_redirects=False)
                break
            except httpx.ConnectError:
                # Nothing reached Redis, so even a settle is safe to send again. A read timeout is not.
                if attempt:
                    raise CounterError('Upstash could not be reached') from None
            except httpx.HTTPError as error:
                raise CounterError(f'Upstash request failed ({type(error).__name__})') from None
        try:
            data = response.json()
        except ValueError:
            data = None
        if not response.is_success or not isinstance(data, dict) or 'error' in data or 'result' not in data:
            raise CounterError(f'Upstash command failed (HTTP {response.status_code})')
        return data['result']

    async def reserve(self, r: Reservation, caps: Caps, quota_limit: int) -> tuple[Outcome, int]:
        k = self.keys
        return _outcome(await self._command(
            'EVAL', RESERVE, 4, k.total(), k.day(r.day), k.session(r.sid), k.off(),
            r.amount, caps.total, caps.day, caps.session, r.endpoint, quota_limit, SESSION_KEY_TTL_S, DAY_KEY_TTL_S))

    async def settle(self, r: Reservation, delta: int) -> None:
        if delta:
            k = self.keys
            await self._command('EVAL', SETTLE, 3, k.total(), k.day(r.day), k.session(r.sid),
                                delta, SESSION_KEY_TTL_S, DAY_KEY_TTL_S)

    async def allow_mint(self, ip_key: str, now: float, per_ip_hour: int, per_day: int) -> bool:
        k = self.keys
        result = _integer(await self._command('EVAL', MINT, 2, k.mint_ip(ip_key, utc_hour(now)),
                                              k.mint_day(utc_day(now)), per_ip_hour, MINT_IP_TTL_S, per_day,
                                              MINT_DAY_TTL_S))
        if result not in (1, -1, -2):
            raise CounterError('Unexpected mint reply')
        return result == 1

    async def record_urls(self, sid: str, hashes: list[str]) -> None:
        if hashes:
            await self._command('EVAL', URLS, 1, self.keys.urls(sid), SESSION_KEY_TTL_S, *hashes)

    async def urls_allowed(self, sid: str, hashes: list[str]) -> bool:
        if not hashes:
            return False
        result = await self._command('SMISMEMBER', self.keys.urls(sid), *hashes)
        if not isinstance(result, list) or len(result) != len(hashes):
            raise CounterError('Unexpected membership reply')
        return all(_integer(item) == 1 for item in result)

    async def status(self, day: str) -> Status:
        k = self.keys
        result = await self._command('MGET', k.total(), k.day(day), k.off(), k.voice_off())
        if not isinstance(result, list) or len(result) != 4:
            raise CounterError('Unexpected status reply')
        total, spent, off, voice_off = result
        return Status(total=_integer(total), day=_integer(spent), off=off is not None, voice_off=voice_off is not None)

    async def set_voice_off(self, ttl_s: int) -> None:
        await self._command('SET', self.keys.voice_off(), 1, 'EX', ttl_s)

    async def ping(self) -> bool:
        return await self._command('PING') == 'PONG'


class MemoryCounters:
    """The Lua scripts' semantics in process. Only demo_local.py and tests inject it; on Vercel it means not live."""

    def __init__(self, keys: Keys, clock: Callable[[], float] = time.time, *, _shared: dict | None = None):
        self.keys = keys
        self.clock = clock
        # One store for the counters and their selftest twin, as in a single Redis database.
        self._shared = _shared if _shared is not None else {'values': {}, 'expiry': {}, 'lock': asyncio.Lock()}
        self.values: dict[str, Any] = self._shared['values']
        self.expiry: dict[str, float] = self._shared['expiry']
        self.lock: asyncio.Lock = self._shared['lock']

    def selftest(self) -> 'MemoryCounters':
        return MemoryCounters(self.keys.selftest(), self.clock, _shared=self._shared)

    def _get(self, key: str) -> Any:
        if key in self.expiry and self.expiry[key] <= self.clock():
            self.values.pop(key, None)
            self.expiry.pop(key, None)
        return self.values.get(key)

    def _expire(self, key: str, ttl_s: int) -> None:
        if key in self.values:
            self.expiry[key] = self.clock() + ttl_s

    def _incr(self, key: str, by: int) -> int:
        value = int(self._get(key) or 0) + by
        self.values[key] = value
        return value

    def _hash(self, key: str) -> dict[str, int]:
        value = self._get(key)
        if value is None:
            value = self.values[key] = {}
        return value

    async def reserve(self, r: Reservation, caps: Caps, quota_limit: int) -> tuple[Outcome, int]:
        k = self.keys
        async with self.lock:
            if self._get(k.off()) is not None:
                return Outcome.OFF, 0
            session = self._get(k.session(r.sid)) or {}
            quota = int(session.get(r.endpoint, 0))
            if quota >= quota_limit:
                return Outcome.QUOTA, quota
            spend = int(session.get('spend', 0))
            if spend + r.amount > caps.session:
                return Outcome.SESSION_BUDGET, spend
            day = int(self._get(k.day(r.day)) or 0)
            if day + r.amount > caps.day:
                return Outcome.DAY_BUDGET, day
            total = int(self._get(k.total()) or 0)
            if total + r.amount > caps.total:
                return Outcome.TOTAL_BUDGET, total
            session = self._hash(k.session(r.sid))
            session[r.endpoint] = quota + 1
            session['spend'] = spend + r.amount
            self._expire(k.session(r.sid), SESSION_KEY_TTL_S)
            self._incr(k.day(r.day), r.amount)
            self._expire(k.day(r.day), DAY_KEY_TTL_S)
            self._incr(k.total(), r.amount)
            return Outcome.OK, total + r.amount

    async def settle(self, r: Reservation, delta: int) -> None:
        if not delta:
            return
        k = self.keys
        async with self.lock:
            self._incr(k.total(), delta)
            self._incr(k.day(r.day), delta)
            self._expire(k.day(r.day), DAY_KEY_TTL_S)
            session = self._hash(k.session(r.sid))
            session['spend'] = int(session.get('spend', 0)) + delta
            self._expire(k.session(r.sid), SESSION_KEY_TTL_S)

    async def allow_mint(self, ip_key: str, now: float, per_ip_hour: int, per_day: int) -> bool:
        ip_hour, day = self.keys.mint_ip(ip_key, utc_hour(now)), self.keys.mint_day(utc_day(now))
        async with self.lock:
            if (count := self._incr(ip_hour, 1)) == 1:
                self._expire(ip_hour, MINT_IP_TTL_S)
            if count > per_ip_hour:
                return False
            if (count := self._incr(day, 1)) == 1:
                self._expire(day, MINT_DAY_TTL_S)
            return count <= per_day

    async def record_urls(self, sid: str, hashes: list[str]) -> None:
        if hashes:
            async with self.lock:
                key = self.keys.urls(sid)
                members = self._get(key)
                self.values[key] = (members or frozenset()) | frozenset(hashes)
                self._expire(key, SESSION_KEY_TTL_S)

    async def urls_allowed(self, sid: str, hashes: list[str]) -> bool:
        async with self.lock:
            members = self._get(self.keys.urls(sid)) or frozenset()
            return bool(hashes) and all(item in members for item in hashes)

    async def status(self, day: str) -> Status:
        k = self.keys
        async with self.lock:
            return Status(total=int(self._get(k.total()) or 0), day=int(self._get(k.day(day)) or 0),
                          off=self._get(k.off()) is not None, voice_off=self._get(k.voice_off()) is not None)

    async def set_voice_off(self, ttl_s: int) -> None:
        async with self.lock:
            self.values[self.keys.voice_off()] = '1'
            self._expire(self.keys.voice_off(), ttl_s)

    async def ping(self) -> bool:
        return True
