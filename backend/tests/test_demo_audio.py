"""OpenAI speech for the web demo: WAV validation, the exact outbound requests, and the error mapping."""
import json
import struct

import httpx
import pytest

from moolai_backend.demo_audio import (
    INSTRUCTIONS, MAX_AUDIO, MAX_TEXT, SPEECH_URL, TRANSCRIBE_URL, AudioError, DemoAudio, canonical_wav,
    clean_speech_text, map_openai_error, wav_seconds,
)

KEY = 'openai-fixture-key'


def wav(seconds=1.0, *, rate=16_000, channels=1, bits=16, code=1, fmt_size=16, before_data=b'', declared=None,
        samples=None, fmt_first=True):
    data = samples if samples is not None else b'\x01\x02' * round(seconds * rate) * channels
    block = channels * bits // 8
    fmt = struct.pack('<HHIIHH', code, channels, rate, rate * block, block, bits) + b'\x00' * (fmt_size - 16)
    fmt_chunk = b'fmt ' + struct.pack('<I', fmt_size) + fmt
    data_chunk = b'data' + struct.pack('<I', len(data) if declared is None else declared) + data
    chunks = fmt_chunk + before_data + data_chunk if fmt_first else data_chunk + fmt_chunk
    return b'RIFF' + struct.pack('<I', 4 + len(chunks)) + b'WAVE' + chunks


@pytest.mark.parametrize('clip,seconds', [
    (wav(1.0), 1.0),
    (wav(0.2), 0.2),
    (wav(34.0), 34.0),
    (wav(1.0, fmt_size=18), 1.0),  # WAVEFORMATEX with an empty extension.
    (wav(1.0, before_data=b'LIST' + struct.pack('<I', 3) + b'abc\x00'), 1.0),  # Odd chunk plus its pad byte.
    (wav(1.0, declared=0xFFFF_FFFF), 1.0),  # A streamed header: only the bytes that arrived count.
    (wav(1.0, declared=16_000), 0.5),  # The header's size wins when it is smaller.
])
def test_valid_wav_durations(clip, seconds):
    assert wav_seconds(clip) == pytest.approx(seconds)


@pytest.mark.parametrize('clip', [
    b'',
    b'RIFF',
    wav(1.0)[:44 - 8],
    b'RIFX' + wav(1.0)[4:],
    wav(1.0)[:8] + b'AVI ' + wav(1.0)[12:],
    wav(1.0, code=3),  # IEEE float.
    wav(1.0, code=0xFFFE),  # WAVE_FORMAT_EXTENSIBLE is not plain PCM.
    wav(1.0, channels=2),
    wav(1.0, rate=44_100),
    wav(1.0, rate=8_000),
    wav(1.0, bits=8),
    wav(1.0, bits=24),
    wav(1.0, fmt_size=14),
    wav(1.0, fmt_first=False),
    wav(0.19),
    wav(34.01),
    wav(samples=b''),
])
def test_invalid_wavs_are_refused(clip):
    with pytest.raises(AudioError) as raised:
        wav_seconds(clip)
    assert (raised.value.status, raised.value.code) == (422, 'invalid_audio')


def chunk(tag: bytes, payload: bytes) -> bytes:
    return tag + struct.pack('<I', len(payload)) + payload + b'\x00' * (len(payload) & 1)


def riff(*chunks: bytes) -> bytes:
    body = b''.join(chunks)
    return b'RIFF' + struct.pack('<I', 4 + len(body)) + b'WAVE' + body


FMT = chunk(b'fmt ', struct.pack('<HHIIHH', 1, 1, 16_000, 32_000, 2, 16))


def test_a_plain_wav_is_sent_as_it_came():
    for clip in (wav(1.0), wav(34.0), wav(0.2)):
        assert canonical_wav(clip) == (clip, len(clip[44:]) / 32_000)


@pytest.mark.parametrize('clip,pcm', [
    # Only the first data chunk is audio, whatever follows it: another data chunk, other chunks or junk.
    (riff(FMT, chunk(b'data', b'\x01\x02' * 3_200), chunk(b'data', b'\x03\x04' * 536_000)), b'\x01\x02' * 3_200),
    (riff(FMT, chunk(b'data', b'\x01\x02' * 3_200), chunk(b'LIST', b'abc'), chunk(b'data', b'\x03\x04' * 9_000)),
     b'\x01\x02' * 3_200),
    (riff(FMT, chunk(b'data', b'\x01\x02' * 8_000)) + b'junk' * 4_000, b'\x01\x02' * 8_000),
    # Extension bytes and chunks before the data are dropped, and an odd last byte is not a sample.
    (wav(1.0, fmt_size=18, before_data=b'LIST' + struct.pack('<I', 3) + b'abc\x00'), b'\x01\x02' * 16_000),
    (riff(FMT, chunk(b'data', b'\x01\x02' * 8_000 + b'\x05')), b'\x01\x02' * 8_000),
    (wav(1.0, declared=0xFFFF_FFFF), b'\x01\x02' * 16_000),
    (wav(1.0, declared=16_000), b'\x01\x02' * 8_000),
], ids=['two data chunks', 'data, list, data', 'trailing junk', 'extension and list', 'odd byte', 'streamed',
        'short header'])
def test_only_the_measured_audio_is_rebuilt_into_the_wav_that_is_sent(clip, pcm):
    sent, seconds = canonical_wav(clip)
    assert sent == wav(samples=pcm) and seconds == len(pcm) / 32_000


def test_a_second_format_chunk_is_refused_however_it_is_ordered():
    # A decoder that reads the first format hears 1,088 s where the one before the data says 34.
    slow = chunk(b'fmt ', struct.pack('<HHIIHH', 1, 1, 1_000, 1_000, 1, 8))
    clips = (riff(slow, FMT, chunk(b'data', b'\x01' * 1_088_000)), riff(FMT, slow, chunk(b'data', b'\x01' * 16_000)),
             riff(FMT, FMT, chunk(b'data', b'\x01\x02' * 16_000)))
    for clip in clips:
        with pytest.raises(AudioError) as raised:
            canonical_wav(clip)
        assert (raised.value.status, raised.value.code) == (422, 'invalid_audio')


def test_speech_text_is_normalised_and_bounded():
    assert clean_speech_text('  Osmosis\nmoves\twater.  ') == 'Osmosis moves water.'
    assert clean_speech_text('x' * MAX_TEXT) == 'x' * MAX_TEXT
    for value in ['', ' \n ', 'x' * (MAX_TEXT + 1), 'bell\x07', 'nul\x00', 'lone \ud800 surrogate', 42, None, ['text']]:
        with pytest.raises(AudioError) as raised:
            clean_speech_text(value)
        assert (raised.value.status, raised.value.code) == (422, 'invalid_json')


@pytest.mark.parametrize('status,body,exc,expected', [
    (429, {'error': {'code': 'insufficient_quota', 'type': 'insufficient_quota'}}, None, (503, 'voice_unavailable', True)),
    (429, {'error': {'code': None, 'type': 'project_spend_limit_exceeded'}}, None, (503, 'voice_unavailable', True)),
    (429, {'error': {'code': 'rate_limit_exceeded', 'type': 'requests'}}, None, (502, 'provider_failed', False)),
    (429, 'not json', None, (502, 'provider_failed', False)),
    (401, {'error': {'code': 'invalid_api_key'}}, None, (503, 'voice_unavailable', False)),
    (403, {'error': {'code': 'unsupported_country_region_territory'}}, None, (503, 'voice_unavailable', False)),
    (400, {'error': {'code': 'invalid_value'}}, None, (422, 'invalid_audio', False)),
    (500, None, None, (502, 'provider_failed', False)),
    (503, None, None, (502, 'provider_failed', False)),
    (404, None, None, (502, 'provider_failed', False)),
])
def test_openai_statuses_map_to_fixed_codes(status, body, exc, expected):
    raw = json.dumps(body).encode() if isinstance(body, dict) else (body or '').encode()
    error = map_openai_error(status, raw, exc)
    assert (error.status, error.code, error.voice_off) == expected
    assert error.billed is False  # OpenAI does not charge for a refused request.


@pytest.mark.parametrize('exc,expected', [
    (httpx.ReadTimeout('slow'), (504, 'provider_timeout', True)),
    (httpx.WriteTimeout('slow'), (504, 'provider_timeout', True)),
    (httpx.ConnectTimeout('slow'), (504, 'provider_timeout', False)),
    (httpx.ConnectError('refused'), (502, 'provider_failed', False)),
    (httpx.RemoteProtocolError('reset'), (502, 'provider_failed', True)),
])
def test_network_failures_map_to_fixed_codes(exc, expected):
    error = map_openai_error(None, None, exc)
    assert (error.status, error.code, error.billed) == expected


async def run(handler, call):
    requests = []

    def record(request):
        requests.append(request)
        return handler(request)
    async with httpx.AsyncClient(transport=httpx.MockTransport(record)) as client:
        audio = DemoAudio(KEY, 'gpt-transcribe', 'gpt-4o-mini-tts', 'marin', lambda: client)
        result = await call(audio)
    return result, requests


async def test_transcription_sends_the_wav_as_multipart_with_its_fields():
    clip = wav(1.0)
    text, requests = await run(lambda request: httpx.Response(200, json={'text': 'Osmosis moves water.'}),
                               lambda audio: audio.transcribe(clip, 'Moo. Osmosis, dilution'))
    assert text == 'Osmosis moves water.'
    (request,) = requests
    assert request.method == 'POST' and str(request.url) == TRANSCRIBE_URL
    assert request.headers['authorization'] == f'Bearer {KEY}'
    boundary = request.headers['content-type'].split('boundary=')[1].encode()
    assert request.headers['content-type'].startswith('multipart/form-data; boundary=')
    body = request.content
    for name, value in [('model', 'gpt-transcribe'), ('language', 'en'), ('response_format', 'json'),
                        ('prompt', 'Moo. Osmosis, dilution')]:
        assert f'Content-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode() in body
    assert (b'Content-Disposition: form-data; name="file"; filename="clip.wav"\r\nContent-Type: audio/wav\r\n\r\n'
            + clip + b'\r\n--' + boundary) in body
    assert body.count(b'Content-Disposition') == 5


async def test_transcription_without_a_prompt_sends_no_prompt_field():
    _, requests = await run(lambda request: httpx.Response(200, json={'text': ''}),
                            lambda audio: audio.transcribe(wav(1.0), ''))
    assert b'name="prompt"' not in requests[0].content


@pytest.mark.parametrize('reply', [
    httpx.Response(200, json={'text': 'x' * 4_001}),
    httpx.Response(200, json={'text': 42}),
    httpx.Response(200, json={'transcript': 'missing'}),
    httpx.Response(200, text='not json'),
])
async def test_an_unusable_transcript_is_a_billed_provider_failure(reply):
    with pytest.raises(AudioError) as raised:
        await run(lambda request: reply, lambda audio: audio.transcribe(wav(1.0), ''))
    assert (raised.value.status, raised.value.code, raised.value.billed) == (502, 'provider_failed', True)


async def test_speech_sends_the_exact_json_and_returns_mp3_bytes():
    audio, requests = await run(lambda request: httpx.Response(200, content=b'ID3-mp3-bytes'),
                                lambda audio: audio.speak('Dilution keeps the moles the same.'))
    assert audio == b'ID3-mp3-bytes'
    (request,) = requests
    assert str(request.url) == SPEECH_URL and request.headers['authorization'] == f'Bearer {KEY}'
    assert json.loads(request.content) == {
        'model': 'gpt-4o-mini-tts', 'voice': 'marin', 'input': 'Dilution keeps the moles the same.',
        'instructions': INSTRUCTIONS, 'response_format': 'mp3'}
    assert 'calm' in INSTRUCTIONS and 'study partner' in INSTRUCTIONS


@pytest.mark.parametrize('reply,expected', [
    (httpx.Response(200, content=b'\x00' * (MAX_AUDIO + 1)), (502, 'provider_failed')),
    (httpx.Response(200, content=b''), (502, 'provider_failed')),
    (httpx.Response(429, json={'error': {'code': 'insufficient_quota', 'message': f'PRIVATE {KEY}'}}),
     (503, 'voice_unavailable')),
    (httpx.Response(400, json={'error': {'message': f'PRIVATE {KEY} input'}}), (422, 'invalid_audio')),
    (httpx.Response(500, text=f'PRIVATE {KEY}'), (502, 'provider_failed')),
])
async def test_speech_failures_are_capped_and_never_echo_openai(reply, expected):
    with pytest.raises(AudioError) as raised:
        await run(lambda request: reply, lambda audio: audio.speak('Hello there.'))
    assert (raised.value.status, raised.value.code) == expected
    assert 'PRIVATE' not in str(raised.value) and KEY not in str(raised.value)


@pytest.mark.parametrize('call', ['transcribe', 'speak'])
async def test_timeouts_and_unreachable_openai_map_to_504_and_502(call):
    def invoke(audio):
        return audio.transcribe(wav(1.0), '') if call == 'transcribe' else audio.speak('Hello.')

    def timeout(request):
        raise httpx.ReadTimeout('slow', request=request)

    def refused(request):
        raise httpx.ConnectError('refused', request=request)
    for handler, expected in ((timeout, (504, 'provider_timeout', True)), (refused, (502, 'provider_failed', False))):
        with pytest.raises(AudioError) as raised:
            await run(handler, invoke)
        assert (raised.value.status, raised.value.code, raised.value.billed) == expected
