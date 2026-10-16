#!/usr/bin/env python3
"""Resident offline Qwen decoder. Audio never leaves RAM; no word times are fabricated."""
import base64
import hashlib
from importlib.metadata import version
import json
import os
from pathlib import Path
import queue
import sys
import threading

out = sys.stdout
sys.stdout = sys.stderr
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')
ROOT = Path(__file__).resolve().parents[2]
ASSETS = ROOT / '.data/asr/qwen'
MAX_TOKENS = 1024


def emit(event):
    out.write(json.dumps(event) + '\n')
    out.flush()


def has_speech(audio, session):
    """Gate whole utterances, without trimming quiet beginnings or final words."""
    import numpy as np
    state = np.zeros((2, 1, 128), dtype=np.float32)
    context = np.zeros((1, 64), dtype=np.float32)
    run = 0
    for offset in range(0, len(audio), 512):
        frame = audio[offset:offset + 512]
        frame = np.pad(frame, (0, 512 - len(frame))).reshape(1, 512)
        data = np.concatenate([context, frame], axis=1)
        probability, state = session.run(None, {'input': data, 'state': state, 'sr': np.array(16000, dtype=np.int64)})
        context = data[:, -64:]
        run = run + 1 if float(probability.reshape(-1)[0]) >= .5 else 0
        if run >= 3: return True
    return False


def main():
    import numpy as np
    import onnxruntime as ort
    import mlx.core as mx
    from mlx_audio.stt import load

    manifest = json.loads((Path(__file__).parent / 'artifacts.json').read_text())
    if version('mlx-audio') != manifest['runtime']['version']:
        raise RuntimeError('MLX Audio runtime pin mismatch')
    for artifact, base in [(item, ASSETS / 'model') for item in manifest['files']] + [(dict(manifest['vad'], path=manifest['vad']['filename']), ASSETS)]:
        path = base / artifact['path']
        with path.open('rb') as source: digest = hashlib.file_digest(source, 'sha256').hexdigest()
        if path.stat().st_size != artifact['size'] or digest != artifact['sha256']:
            raise RuntimeError('ASR artifact pin mismatch: ' + artifact['path'])

    commands = queue.Queue(maxsize=2)
    cancelled = set()
    pending_ids = set()
    closed = threading.Event()

    def receive():
        while not closed.is_set():
            line = sys.stdin.readline(2_600_001)
            if not line: break
            if len(line) > 2_600_000 or not line.endswith('\n'):
                closed.set(); break
            try:
                value = json.loads(line)
                line = ''  # Do not retain the encoded audio while waiting for the next command.
                if value.get('method') == 'cancel':
                    if value.get('id') in pending_ids: cancelled.add(value.get('id'))
                else:
                    pending_ids.add(value.get('id'))
                    commands.put_nowait(value)
            except Exception:
                emit({'event': 'failed', 'error': 'Invalid or excessive local ASR command'})
                closed.set()
        closed.set()

    threading.Thread(target=receive, daemon=True).start()
    model = load(str(ASSETS / 'model'))
    options = ort.SessionOptions(); options.inter_op_num_threads = 1; options.intra_op_num_threads = 1
    vad = ort.InferenceSession(str(ASSETS / manifest['vad']['filename']), options, providers=['CPUExecutionProvider'])
    # Warm the kernels with discarded synthetic silence; never publish warmup text.
    model.generate(np.zeros(8000, dtype=np.float32), language='English', max_tokens=4, verbose=False)
    emit({'event': 'ready', 'model': manifest['model'], 'wordTimestamps': False})
    while not closed.is_set():
        try: command = commands.get(timeout=.2)
        except queue.Empty: continue
        ident = command.get('id')
        raw = audio = None
        stream = None
        try:
            if ident in cancelled: continue
            context = command.get('context', '')
            if not isinstance(context, str) or len(context) > 601: raise ValueError('Recognition context exceeds its bound')
            raw = base64.b64decode(command.get('pcm', ''), validate=True)
            if not raw or len(raw) % 2 or len(raw) > 16000 * 2 * 60: raise ValueError('Invalid or oversized PCM16 audio')
            audio = np.frombuffer(raw, dtype='<i2').astype(np.float32) / 32768
            if not has_speech(audio, vad):
                emit({'id': ident, 'text': '', 'reason': 'no_speech'}); continue
            if ident in cancelled or closed.is_set(): continue
            # Stream tokens internally for cancellation; publish only the completed transcript.
            stream = model.generate(audio, language='English', temperature=0, max_tokens=MAX_TOKENS,
                stream=True, system_prompt=context or None, verbose=False)
            parts = []; final = False
            for result in stream:
                if ident in cancelled or closed.is_set(): break
                parts.append(result.text)
                if result.is_final:
                    if result.generation_tokens >= MAX_TOKENS: raise ValueError('Qwen output limit reached; transcript is incomplete')
                    final = True
            if ident not in cancelled and not closed.is_set():
                if not final: raise ValueError('Qwen returned an incomplete transcript')
                emit({'id': ident, 'text': ''.join(parts).strip()})
        except Exception as error:
            if ident not in cancelled: emit({'id': ident, 'error': str(error)})
        finally:
            if stream is not None: stream.close()
            if audio is not None: audio.fill(0)
            raw = audio = None
            command.clear()
            mx.clear_cache()
            if ident in cancelled: emit({'id': ident, 'event': 'cancelled'})
            cancelled.discard(ident); pending_ids.discard(ident)


if __name__ == '__main__':
    try: main()
    except Exception as error:
        emit({'event': 'failed', 'error': str(error)})
        sys.exit(1)
