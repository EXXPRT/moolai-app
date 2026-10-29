"""One contract suite runs on MemoryCounters and on UpstashCounters, whose REST calls reach a reference
Redis that interprets each Lua script with the same semantics."""
import json
from datetime import datetime, timezone
from decimal import Decimal

import httpx
import pytest

from moolai_backend.demo_counters import (
    DAY_KEY_TTL_S, MINT, MINT_DAY_TTL_S, MINT_IP_TTL_S, RESERVE, SESSION_KEY_TTL_S, SETTLE, URLS, Caps, CounterError,
    Keys, MemoryCounters, Outcome, Reservation, Status, UpstashCounters, usd_to_micro, utc_day, utc_hour,
)

NOW = datetime(2026, 10, 29, 12, 30, tzinfo=timezone.utc).timestamp()
DAY = '2026-10-29'
URL = 'https://kv.upstash.test'
TOKEN = 'upstash-fixture-token'
CAPS = Caps(total=45_000_000, day=6_000_000, session=1_500_000)


class Clock:
    def __init__(self, now: float = NOW):
        self.now = now

    def __call__(self) -> float:
        return self.now


class ReferenceRedis:
    """Upstash's REST API in memory. EVAL runs a line-by-line Python reading of the script it was sent."""

    def __init__(self, clock: Clock):
        self.clock = clock
        self.values: dict[str, object] = {}
        self.expiry: dict[str, float] = {}
        self.commands: list[list[str]] = []
        self.authorization: list[str | None] = []
        self.failures: list[Exception | httpx.Response] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        assert request.method == 'POST' and request.url.host == 'kv.upstash.test' and request.url.path == '/'
        assert request.headers['content-type'] == 'application/json'
        self.authorization.append(request.headers.get('authorization'))
        command = json.loads(request.content)
        assert isinstance(command, list) and all(isinstance(part, str) for part in command)
        self.commands.append(command)
        if self.failures:
            failure = self.failures.pop(0)
            if isinstance(failure, Exception):
                raise failure
            return failure
        return httpx.Response(200, json={'result': self.run(command)})

    # Redis primitives, with expiry on read.
    def live(self, key):
        if key in self.expiry and self.expiry[key] <= self.clock():
            self.values.pop(key, None)
            self.expiry.pop(key, None)
        return self.values.get(key)

    def get(self, key):
        return self.live(key)

    def exists(self, key):
        return 1 if self.live(key) is not None else 0

    def incrby(self, key, by):
        value = int(self.live(key) or '0') + int(by)
        self.values[key] = str(value)
        return value

    def hget(self, key, field):
        return (self.live(key) or {}).get(field)

    def hincrby(self, key, field, by):
        table = self.live(key)
        if table is None:
            table = self.values[key] = {}
        table[field] = str(int(table.get(field, '0')) + int(by))
        return int(table[field])

    def expire(self, key, ttl):
        if self.live(key) is None:
            return 0
        self.expiry[key] = self.clock() + int(ttl)
        return 1

    def ttl(self, key):
        return None if self.live(key) is None or key not in self.expiry else self.expiry[key] - self.clock()

    def run(self, command):
        name, *args = command
        if name == 'EVAL':
            script, numkeys, *rest = args
            keys, argv = rest[:int(numkeys)], rest[int(numkeys):]
            return {RESERVE: self.reserve, SETTLE: self.settle, MINT: self.mint, URLS: self.urls}[script](keys, argv)
        if name == 'MGET':
            return [self.get(key) if isinstance(self.get(key), (str, type(None))) else None for key in args]
        if name == 'SET':
            key, value, *options = args
            self.values[key] = value
            self.expiry.pop(key, None)
            if options:
                assert options[0] == 'EX'
                self.expiry[key] = self.clock() + int(options[1])
            return 'OK'
        if name == 'SMISMEMBER':
            key, *members = args
            current = self.live(key) or set()
            return [1 if member in current else 0 for member in members]
        if name == 'PING':
            return 'PONG'
        raise AssertionError(f'Unexpected command {name}')

    # The scripts, statement by statement.
    def reserve(self, keys, argv):
        total, day, session, off = keys
        if self.exists(off) == 1:
            return [-5, 0]
        a = int(argv[0])
        q = int(self.hget(session, argv[4]) or '0')
        if q >= int(argv[5]):
            return [-1, q]
        s = int(self.hget(session, 'spend') or '0')
        if s + a > int(argv[3]):
            return [-2, s]
        d = int(self.get(day) or '0')
        if d + a > int(argv[2]):
            return [-3, d]
        t = int(self.get(total) or '0')
        if t + a > int(argv[1]):
            return [-4, t]
        self.hincrby(session, argv[4], 1)
        self.hincrby(session, 'spend', a)
        self.expire(session, argv[6])
        self.incrby(day, a)
        self.expire(day, argv[7])
        self.incrby(total, a)
        return [1, t + a]

    def settle(self, keys, argv):
        total, day, session = keys
        x = int(argv[0])
        if x == 0:
            return 0
        self.incrby(total, x)
        self.incrby(day, x)
        self.expire(day, argv[2])
        self.hincrby(session, 'spend', x)
        self.expire(session, argv[1])
        return 1

    def mint(self, keys, argv):
        ip_hour, day = keys
        n = self.incrby(ip_hour, 1)
        if n == 1:
            self.expire(ip_hour, argv[1])
        if n > int(argv[0]):
            return -1
        g = self.incrby(day, 1)
        if g == 1:
            self.expire(day, argv[3])
        if g > int(argv[2]):
            return -2
        return 1

    def urls(self, keys, argv):
        current = self.live(keys[0])
        if current is None:
            current = self.values[keys[0]] = set()
        current.update(argv[1:])
        self.expire(keys[0], argv[0])
        return 1


@pytest.fixture(params=['memory', 'upstash'])
async def backend(request):
    clock = Clock()
    if request.param == 'memory':
        yield MemoryCounters(Keys('test'), clock=clock), clock, None
        return
    redis = ReferenceRedis(clock)
    async with httpx.AsyncClient(transport=httpx.MockTransport(redis)) as client:
        yield UpstashCounters(URL, TOKEN, Keys('test'), lambda: client), clock, redis


def reservation(amount=1_000, sid='sid-a', endpoint='route', day=DAY):
    return Reservation(endpoint, sid, day, amount)


async def spend(counters, sid='sid-a') -> int:
    """A session's spend, read back through a zero-cost probe that the cap refuses."""
    outcome, value = await counters.reserve(reservation(10 ** 12, sid, 'probe'), Caps(10 ** 15, 10 ** 15, 0), 10 ** 6)
    assert outcome is Outcome.SESSION_BUDGET
    return value


async def test_reserve_charges_every_counter_and_settle_corrects_them(backend):
    counters, _, _ = backend
    assert await counters.reserve(reservation(1_000), CAPS, 5) == (Outcome.OK, 1_000)
    assert await counters.reserve(reservation(2_000, sid='sid-b'), CAPS, 5) == (Outcome.OK, 3_000)
    assert await counters.status(DAY) == Status(total=3_000, day=3_000, off=False, voice_off=False)
    await counters.settle(reservation(1_000), -400)
    await counters.settle(reservation(2_000, sid='sid-b'), 2_500)
    assert await counters.status(DAY) == Status(total=5_100, day=5_100, off=False, voice_off=False)
    assert await spend(counters, 'sid-a') == 600 and await spend(counters, 'sid-b') == 4_500


@pytest.mark.parametrize('caps,outcome,value', [
    (Caps(10_000, 10_000, 1_499), Outcome.SESSION_BUDGET, 0),
    (Caps(10_000, 1_499, 10_000), Outcome.DAY_BUDGET, 0),
    (Caps(1_499, 10_000, 10_000), Outcome.TOTAL_BUDGET, 0),
])
async def test_a_refused_reservation_changes_nothing(backend, caps, outcome, value):
    counters, _, _ = backend
    assert await counters.reserve(reservation(1_500), caps, 5) == (outcome, value)
    assert await counters.status(DAY) == Status(0, 0, False, False)
    assert await counters.reserve(reservation(1_499), caps, 1) == (Outcome.OK, 1_499)


async def test_budgets_count_what_is_already_spent(backend):
    counters, _, _ = backend
    caps = Caps(total=10_000, day=6_000, session=4_000)
    assert (await counters.reserve(reservation(3_000), caps, 9))[0] is Outcome.OK
    assert await counters.reserve(reservation(1_001), caps, 9) == (Outcome.SESSION_BUDGET, 3_000)
    assert (await counters.reserve(reservation(2_500, sid='sid-b'), caps, 9))[0] is Outcome.OK
    assert await counters.reserve(reservation(600, sid='sid-c'), caps, 9) == (Outcome.DAY_BUDGET, 5_500)
    assert (await counters.reserve(reservation(500, sid='sid-c', day='2026-10-30'), caps, 9))[0] is Outcome.OK
    assert (await counters.reserve(reservation(4_000, sid='sid-d', day='2026-10-31'), caps, 9))[0] is Outcome.OK
    assert await counters.reserve(reservation(1, sid='sid-e', day='2026-10-31'), caps, 9) == (Outcome.TOTAL_BUDGET, 10_000)


async def test_quotas_are_per_session_and_per_endpoint(backend):
    counters, _, _ = backend
    for _ in range(3):
        assert (await counters.reserve(reservation(1, endpoint='vision'), CAPS, 3))[0] is Outcome.OK
    assert await counters.reserve(reservation(1, endpoint='vision'), CAPS, 3) == (Outcome.QUOTA, 3)
    assert (await counters.reserve(reservation(1, endpoint='search'), CAPS, 3))[0] is Outcome.OK
    assert (await counters.reserve(reservation(1, sid='sid-b', endpoint='vision'), CAPS, 3))[0] is Outcome.OK


async def test_the_kill_switch_refuses_before_anything_else(backend):
    counters, _, redis = backend
    if redis is None:
        counters.values[counters.keys.off()] = '1'
    else:
        redis.values[counters.keys.off()] = '1'
    assert await counters.reserve(reservation(1), Caps(0, 0, 0), 0) == (Outcome.OFF, 0)
    assert (await counters.status(DAY)).off is True


async def test_session_counters_expire_after_three_hours_and_days_after_three_days(backend):
    counters, clock, _ = backend
    for _ in range(2):
        await counters.reserve(reservation(100), CAPS, 2)
    assert (await counters.reserve(reservation(100), CAPS, 2))[0] is Outcome.QUOTA
    clock.now += SESSION_KEY_TTL_S + 1
    assert (await counters.reserve(reservation(100), CAPS, 2))[0] is Outcome.OK
    assert (await counters.status(DAY)).day == 300
    clock.now += DAY_KEY_TTL_S + 1
    assert await counters.status(DAY) == Status(total=300, day=0, off=False, voice_off=False)  # The total never expires.


async def test_a_settle_after_midnight_corrects_the_day_it_reserved(backend):
    counters, clock, _ = backend
    held = reservation(5_000)
    await counters.reserve(held, CAPS, 5)
    clock.now += 86_400
    await counters.settle(held, -4_000)
    assert (await counters.status(DAY)).day == 1_000
    assert (await counters.status('2026-10-30')).day == 0


async def test_mints_are_capped_per_address_hour_and_per_day(backend):
    counters, clock, _ = backend
    assert [await counters.allow_mint('ip-a', clock(), 2, 3) for _ in range(3)] == [True, True, False]
    assert await counters.allow_mint('ip-b', clock(), 2, 3) is True
    assert await counters.allow_mint('ip-c', clock(), 2, 3) is False  # The day's third success was ip-b.
    clock.now += 3_600
    assert await counters.allow_mint('ip-a', clock(), 2, 3) is False  # Same UTC day: the daily cap holds.
    clock.now += 86_400
    assert await counters.allow_mint('ip-a', clock(), 2, 3) is True


async def test_search_urls_are_remembered_per_session_until_it_expires(backend):
    counters, clock, _ = backend
    await counters.record_urls('sid-a', ['h1', 'h2'])
    await counters.record_urls('sid-a', ['h3'])
    assert await counters.urls_allowed('sid-a', ['h1', 'h3']) is True
    assert await counters.urls_allowed('sid-a', ['h1', 'h9']) is False
    assert await counters.urls_allowed('sid-b', ['h1']) is False
    assert await counters.urls_allowed('sid-a', []) is False
    clock.now += SESSION_KEY_TTL_S + 1
    assert await counters.urls_allowed('sid-a', ['h1']) is False


async def test_voice_off_lasts_for_its_ttl(backend):
    counters, clock, _ = backend
    await counters.set_voice_off(3_600)
    assert (await counters.status(DAY)).voice_off is True
    clock.now += 3_601
    assert (await counters.status(DAY)).voice_off is False
    assert await counters.ping() is True


async def test_selftest_keys_never_touch_the_real_counters(backend):
    counters, _, _ = backend
    selftest = counters.selftest()
    assert selftest.keys.total() == 'moolai:demo:test:selftest:total'
    assert (await selftest.reserve(reservation(1, 'selftest', 'selftest'), CAPS, 10))[0] is Outcome.OK
    await selftest.settle(reservation(1, 'selftest', 'selftest'), -1)
    assert await counters.status(DAY) == Status(0, 0, False, False)
    assert await selftest.status(DAY) == Status(0, 0, False, False)


async def test_upstash_commands_have_the_exact_rest_shape_and_bearer_token():
    redis = ReferenceRedis(Clock())
    async with httpx.AsyncClient(transport=httpx.MockTransport(redis)) as client:
        counters = UpstashCounters(URL, TOKEN, Keys('production'), lambda: client)
        held = Reservation('respond', 'SID', DAY, 61_656)
        await counters.reserve(held, CAPS, 60)
        await counters.settle(held, -50_000)
        await counters.settle(held, 0)  # Nothing to send.
        await counters.allow_mint('abcd', NOW, 30, 300)
        await counters.record_urls('SID', ['u1', 'u2'])
        await counters.record_urls('SID', [])  # Nothing to send.
        await counters.urls_allowed('SID', ['u1'])
        await counters.status(DAY)
        await counters.set_voice_off(3_600)
        await counters.ping()
    p = 'moolai:demo:production:'
    assert redis.commands == [
        ['EVAL', RESERVE, '4', p + 'total', p + 'day:2026-10-29', p + 'session:SID', p + 'off',
         '61656', '45000000', '6000000', '1500000', 'respond', '60', str(SESSION_KEY_TTL_S), str(DAY_KEY_TTL_S)],
        ['EVAL', SETTLE, '3', p + 'total', p + 'day:2026-10-29', p + 'session:SID',
         '-50000', str(SESSION_KEY_TTL_S), str(DAY_KEY_TTL_S)],
        ['EVAL', MINT, '2', p + 'mint:ip:abcd:2026-10-29T12', p + 'mint:day:2026-10-29',
         '30', str(MINT_IP_TTL_S), '300', str(MINT_DAY_TTL_S)],
        ['EVAL', URLS, '1', p + 'urls:SID', str(SESSION_KEY_TTL_S), 'u1', 'u2'],
        ['SMISMEMBER', p + 'urls:SID', 'u1'],
        ['MGET', p + 'total', p + 'day:2026-10-29', p + 'off', p + 'voice_off'],
        ['SET', p + 'voice_off', '1', 'EX', '3600'],
        ['PING'],
    ]
    assert redis.authorization == [f'Bearer {TOKEN}'] * len(redis.commands)
    assert redis.ttl(p + 'session:SID') == SESSION_KEY_TTL_S and redis.ttl(p + 'total') is None


async def test_only_a_connect_error_is_retried():
    redis = ReferenceRedis(Clock())
    async with httpx.AsyncClient(transport=httpx.MockTransport(redis)) as client:
        counters = UpstashCounters(URL, TOKEN, Keys('test'), lambda: client)
        held = reservation(1_000)
        redis.failures = [httpx.ConnectError('refused')]
        await counters.settle(held, 5)
        assert len(redis.commands) == 2 and (await counters.status(DAY)).total == 5
        redis.commands.clear()
        redis.failures = [httpx.ReadTimeout('slow')]
        with pytest.raises(CounterError):
            await counters.settle(held, 5)  # It may have run: never sent twice.
        assert len(redis.commands) == 1
        redis.commands.clear()
        redis.failures = [httpx.ConnectError('refused'), httpx.ConnectError('refused')]
        with pytest.raises(CounterError):
            await counters.reserve(held, CAPS, 5)
        assert len(redis.commands) == 2


@pytest.mark.parametrize('reply', [
    httpx.Response(500, text=f'PRIVATE {TOKEN}'),
    httpx.Response(400, json={'error': f'ERR PRIVATE {TOKEN}'}),
    httpx.Response(200, json={'error': 'ERR PRIVATE'}),
    httpx.Response(200, text='not json'),
    httpx.Response(200, json={'result': ['surprise']}),
    httpx.Response(200, json={'result': [7, 0]}),
])
async def test_any_odd_reply_is_a_counter_error_without_its_body(reply):
    redis = ReferenceRedis(Clock())
    redis.failures = [reply]
    async with httpx.AsyncClient(transport=httpx.MockTransport(redis)) as client:
        with pytest.raises(CounterError) as raised:
            await UpstashCounters(URL, TOKEN, Keys('test'), lambda: client).reserve(reservation(), CAPS, 5)
    assert 'PRIVATE' not in str(raised.value) and TOKEN not in str(raised.value)


@pytest.mark.parametrize('env,url', [
    ({'KV_REST_API_URL': URL + '/', 'KV_REST_API_TOKEN': 't'}, URL),
    ({'UPSTASH_REDIS_REST_URL': URL, 'UPSTASH_REDIS_REST_TOKEN': 't'}, URL),
    ({'KV_REST_API_URL': URL, 'KV_REST_API_TOKEN': 't', 'UPSTASH_REDIS_REST_URL': 'https://other.test',
      'UPSTASH_REDIS_REST_TOKEN': 'u'}, URL),
    ({'KV_REST_API_URL': 'http://kv.upstash.test', 'KV_REST_API_TOKEN': 't'}, None),
    ({'KV_REST_API_URL': 'https://user:pw@kv.upstash.test', 'KV_REST_API_TOKEN': 't'}, None),
    ({'KV_REST_API_URL': URL}, None),
    ({}, None),
])
def test_upstash_comes_from_vercel_kv_variables_over_https_only(env, url):
    counters = UpstashCounters.from_env(env, Keys('test'), lambda: None)
    assert (counters.url if counters else None) == url


@pytest.mark.parametrize('value,micro', [('45', 45_000_000), ('1.5', 1_500_000), (' 6 ', 6_000_000),
                                         ('0.0000019', 1), ('60', 60_000_000)])
def test_dollar_amounts_become_integer_micro_dollars(value, micro):
    assert usd_to_micro(value, Decimal(60)) == micro


@pytest.mark.parametrize('value', ['60.01', '0', '-1', 'abc', '', 'NaN', 'Infinity', '0.0000001', '1e3'])
def test_dollar_amounts_outside_their_ceiling_are_refused(value):
    with pytest.raises(ValueError):
        usd_to_micro(value, Decimal(60))


def test_utc_day_and_hour():
    assert utc_day(NOW) == DAY and utc_hour(NOW) == '2026-10-29T12'
    assert utc_day(datetime(2026, 10, 29, 23, 59, 59, tzinfo=timezone.utc).timestamp()) == DAY
