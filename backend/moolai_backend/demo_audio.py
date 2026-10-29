"""OpenAI speech for the web demo: raw WAV in and multipart out, text in and MP3 out.

The browser never sends multipart, so the gateway needs no form parser. OpenAI's error bodies can
carry diagnostics; they are mapped to fixed codes and never echoed.
"""
import json
import struct
import unicodedata
from collections.abc import Callable

import httpx

TRANSCRIBE_URL = 'https://api.openai.com/v1/audio/transcriptions'
SPEECH_URL = 'https://api.openai.com/v1/audio/speech'
DEFAULTS = dict(transcribe='gpt-transcribe', tts='gpt-4o-mini-tts', voice='marin')
# The models the gateway's audio prices are for; any other model would be spent at a price it doesn't know.
PRICED_MODELS = dict(transcribe=frozenset({'gpt-transcribe', 'gpt-4o-mini-transcribe'}),
                     tts=frozenset({'gpt-4o-mini-tts'}))
WAV_RATE = 16_000
MIN_S, MAX_S = 0.2, 34.0
MAX_TEXT = 1_000
MAX_AUDIO = 4_000_000
MAX_TRANSCRIPT = 4_000
OPENAI_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
INSTRUCTIONS = ('Speak as a calm, friendly study partner: clear and unhurried, warm but not theatrical, '
                'with natural pauses between ideas.')
# Spending stops, not a passing rate limit: voice stays off for an hour instead of failing each utterance.
QUOTA_CODES = frozenset({'insufficient_quota', 'project_spend_limit_exceeded'})
_FORMAT = (1, 1, WAV_RATE, WAV_RATE * 2, 2, 16)  # PCM, mono, 16 kHz, byte rate, block align, 16-bit


class AudioError(Exception):
    """`billed` is false when OpenAI cannot have charged for the call, so the gateway refunds it."""

    def __init__(self, status: int, code: str, *, billed: bool = False, voice_off: bool = False):
        super().__init__(code)
        self.status = status
        self.code = code
        self.billed = billed
        self.voice_off = voice_off


def canonical_wav(data: bytes) -> tuple[bytes, float]:
    """The audio the gateway measured, rebuilt as a plain 44-byte-header WAV, and its length in seconds.

    Only this is sent on: a decoder reading a later data chunk, or a format chunk this check didn't use, would hear
    far more audio than was charged for.
    """
    if len(data) < 12 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise AudioError(422, 'invalid_audio')
    offset, fmt = 12, None
    while offset + 8 <= len(data):
        chunk, size = data[offset:offset + 4], int.from_bytes(data[offset + 4:offset + 8], 'little')
        start = offset + 8
        if chunk == b'fmt ':
            # Two format chunks would describe the same bytes differently to different decoders.
            if fmt is not None or size < 16 or start + 16 > len(data):
                break
            fmt = struct.unpack('<HHIIHH', data[start:start + 16])
        elif chunk == b'data':
            if fmt != _FORMAT:
                break
            # A streamed header can declare more than arrived; only the whole samples present are audio.
            pcm = data[start:start + min(size, len(data) - start)]
            pcm = pcm[:len(pcm) - len(pcm) % 2]
            seconds = len(pcm) / 2 / WAV_RATE
            if not MIN_S <= seconds <= MAX_S:
                break
            header = b'RIFF' + struct.pack('<I', 36 + len(pcm)) + b'WAVEfmt ' + struct.pack('<IHHIIHH', 16, *_FORMAT)
            return header + b'data' + struct.pack('<I', len(pcm)) + pcm, seconds
        offset = start + size + (size & 1)  # Chunks are padded to an even length.
    raise AudioError(422, 'invalid_audio')


def wav_seconds(data: bytes) -> float:
    return canonical_wav(data)[1]


def clean_speech_text(value: object) -> str:
    if not isinstance(value, str) or len(value) > MAX_TEXT:
        raise AudioError(422, 'invalid_json')
    text = ' '.join(value.split())
    # Lone surrogates cannot be encoded for OpenAI, and other control characters are never speech.
    if not text or any(unicodedata.category(char) in ('Cc', 'Cs') for char in text):
        raise AudioError(422, 'invalid_json')
    return text


def map_openai_error(status: int | None, body: bytes | None, exc: Exception | None) -> AudioError:
    if exc is not None:
        unsent = isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))
        if isinstance(exc, httpx.TimeoutException):
            return AudioError(504, 'provider_timeout', billed=not unsent)
        return AudioError(502, 'provider_failed', billed=not unsent)
    if status == 429 and _error_code(body) in QUOTA_CODES:
        return AudioError(503, 'voice_unavailable', voice_off=True)
    if status in (401, 403):
        return AudioError(503, 'voice_unavailable')
    if status == 400:
        return AudioError(422, 'invalid_audio')
    return AudioError(502, 'provider_failed')


def _error_code(body: bytes | None) -> str | None:
    try:
        error = json.loads(body or b'')['error']
        codes = [error.get('code'), error.get('type')]
    except Exception:
        return None
    return next((code for code in codes if code in QUOTA_CODES), None)


class DemoAudio:
    def __init__(self, api_key: str, transcribe_model: str, tts_model: str, voice: str,
                 client: Callable[[], httpx.AsyncClient]):
        self._key = api_key
        self.transcribe_model = transcribe_model
        self.tts_model = tts_model
        self.voice = voice
        self._client = client

    def _headers(self) -> dict[str, str]:
        return {'Authorization': f'Bearer {self._key}'}

    async def transcribe(self, wav: bytes, prompt: str) -> str:
        data = {'model': self.transcribe_model, 'language': 'en', 'response_format': 'json'}
        if prompt:
            data['prompt'] = prompt
        try:
            response = await self._client().post(TRANSCRIBE_URL, headers=self._headers(), data=data,
                                                 files={'file': ('clip.wav', wav, 'audio/wav')},
                                                 timeout=OPENAI_TIMEOUT, follow_redirects=False)
        except httpx.HTTPError as error:
            raise map_openai_error(None, None, error) from None
        if not response.is_success:
            raise map_openai_error(response.status_code, response.content[:64_000], None)
        try:
            text = response.json()['text'] if len(response.content) <= 1_000_000 else None
        except (ValueError, KeyError, TypeError):
            text = None
        if not isinstance(text, str) or len(text) > MAX_TRANSCRIPT:
            raise AudioError(502, 'provider_failed', billed=True)
        return text

    async def speak(self, text: str) -> bytes:
        payload = {'model': self.tts_model, 'voice': self.voice, 'input': text,
                   'instructions': INSTRUCTIONS, 'response_format': 'mp3'}
        chunks, size = [], 0
        try:
            async with self._client().stream('POST', SPEECH_URL, headers=self._headers(), json=payload,
                                             timeout=OPENAI_TIMEOUT, follow_redirects=False) as response:
                if not response.is_success:
                    body = b''
                    async for chunk in response.aiter_bytes():
                        body += chunk
                        if len(body) > 64_000:
                            break
                    raise map_openai_error(response.status_code, body, None)
                async for chunk in response.aiter_bytes():
                    size += len(chunk)
                    if size > MAX_AUDIO:
                        raise AudioError(502, 'provider_failed', billed=True)
                    chunks.append(chunk)
        except httpx.HTTPError as error:
            raise map_openai_error(None, None, error) from None
        if not size:
            raise AudioError(502, 'provider_failed', billed=True)
        return b''.join(chunks)
