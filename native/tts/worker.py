#!/usr/bin/env python3
"""Single local MLX owner. PCM is streamed in memory; cancellation never restarts a reply."""
import base64
import contextlib
import hashlib
import json
import os
from pathlib import Path
import queue
import sys
import threading

out = sys.stdout
sys.stdout = sys.stderr  # libraries must never contaminate the JSON transport
os.environ.update(HF_HUB_OFFLINE='1', TRANSFORMERS_OFFLINE='1')

def emit(value):
    out.write(json.dumps(value) + '\n'); out.flush()

commands = queue.Queue(maxsize=4)
cancelled = set()
closed = threading.Event()
def receive():
    for line in sys.stdin:
        try:
            value = json.loads(line)
            if value.get('method') == 'cancel': cancelled.add(value.get('id'))
            else: commands.put_nowait(value)
        except Exception: emit({'error': 'Invalid or excessive speech command'})
    closed.set()
threading.Thread(target=receive, daemon=True).start()
try:
    import numpy as np
    from importlib.metadata import version
    from kokoro_mlx import KokoroTTS
    if version('kokoro-mlx') != '0.1.2': raise RuntimeError('Kokoro runtime pin mismatch')
    config = json.loads(Path(sys.argv[1]).read_text())
    root = Path(sys.argv[1]).resolve().parent
    model = (root / config['modelPath']).resolve()
    manifest = json.loads((Path(__file__).parent / 'artifacts.json').read_text())
    for item in manifest['files']:
        path = model / item['path']
        if path.stat().st_size != item['size'] or hashlib.file_digest(path.open('rb'), 'sha256').hexdigest() != item['sha256']:
            raise RuntimeError('Speech model artifact pin mismatch: ' + item['path'])
    voice = config.get('voice', 'af_heart')
    speed = float(config.get('speed', 1))
    if voice != 'af_heart' or not .75 <= speed <= 1.25:
        raise RuntimeError('Use pinned af_heart voice and speed between 0.75 and 1.25')
    tts = KokoroTTS.from_pretrained(model)
    for _ in tts.generate_stream('Ready.', voice=voice, speed=speed): pass
    emit({'event': 'ready', 'sampleRate': 24000, 'voice': voice})
    while not closed.is_set():
        try: command = commands.get(timeout=.25)
        except queue.Empty: continue
        ident = command.get('id')
        try:
            text = command.get('text', '')
            if not isinstance(text, str) or not text.strip() or len(text) > 16000: raise ValueError('Speech text is empty or exceeds its bound')
            total = 0
            for chunk in tts.generate_stream(text, voice=voice, speed=speed):
                if ident in cancelled or closed.is_set(): break
                pcm = np.asarray(chunk, dtype='<f4').reshape(-1)
                if not np.isfinite(pcm).all(): raise ValueError('Invalid synthesized audio')
                total += len(pcm)
                if total > 24000 * 240: raise ValueError('Speech exceeds four minutes')
                for offset in range(0, len(pcm), 24000):
                    if ident in cancelled: break
                    emit({'id':ident,'pcm':base64.b64encode(pcm[offset:offset+24000].tobytes()).decode()})
            emit({'id':ident,'done':True,'cancelled':ident in cancelled})
        except Exception as error: emit({'id':ident,'error':str(error)})
        finally: cancelled.discard(ident)
except Exception as error:
    emit({'event':'failed','error':str(error)}); sys.exit(1)
