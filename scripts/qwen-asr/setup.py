#!/usr/bin/env python3
"""Explicit Qwen trial setup. Downloads pinned public artifacts; never captures audio."""
import hashlib
import json
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import urllib.request
import venv
import zipfile

ROOT = Path(__file__).resolve().parents[2]
DEST = ROOT / '.data/asr/qwen'


def matches(path, item):
    if not path.is_file() or path.stat().st_size != item['size']: return False
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest() == item['sha256']


def fetch(url, path, item):
    if matches(path, item): return
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix('.part')
    print('Downloading', path.name, item['size'], 'bytes', flush=True)
    try:
        with urllib.request.urlopen(url, timeout=60) as response, temp.open('wb') as output:
            shutil.copyfileobj(response, output, length=1024 * 1024)
        if not matches(temp, item): raise RuntimeError('Artifact size/hash mismatch: ' + path.name)
        temp.replace(path)
    finally: temp.unlink(missing_ok=True)


def main():
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise RuntimeError('This trial requires Apple Silicon macOS')
    if sys.version_info < (3, 13): raise RuntimeError('Use Python 3.13 or newer for the pinned trial environment')
    manifest = json.loads((Path(__file__).parent / 'artifacts.json').read_text())
    for item in manifest['files']:
        fetch(f"https://huggingface.co/{manifest['repo']}/resolve/{manifest['revision']}/{item['path']}", DEST / 'model' / item['path'], item)
    vad = manifest['vad']; target = DEST / vad['filename']
    if not matches(target, vad):
        wheel = vad['wheel']; archive = DEST / wheel['filename']
        fetch(wheel['url'], archive, wheel)
        with zipfile.ZipFile(archive) as source:
            data = source.read('silero_vad/data/' + vad['filename'])
        if len(data) != vad['size'] or hashlib.sha256(data).hexdigest() != vad['sha256']:
            raise RuntimeError('Silero model pin mismatch')
        target.write_bytes(data)
    python = DEST / 'venv/bin/python'
    if not python.exists(): venv.EnvBuilder(with_pip=True).create(DEST / 'venv')
    subprocess.run([str(python), '-m', 'pip', 'install', '--no-input', '-r', str(Path(__file__).parent / 'requirements.lock')], check=True)
    print('Qwen assets verified. No model selection or microphone state was changed.')


if __name__ == '__main__': main()
