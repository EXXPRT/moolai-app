#!/usr/bin/env python3
"""Install pinned local speech assets, optionally reusing previously verified files."""
from pathlib import Path
import argparse
import hashlib
import json
import shutil
import subprocess
import sys
import urllib.request
import venv

root = Path(__file__).resolve().parents[1]
parser=argparse.ArgumentParser()
parser.add_argument('--reuse-model',type=Path)
parser.add_argument('--reuse-environment',type=Path)
args=parser.parse_args()
config=json.loads((root/'tts-config.json').read_text())
manifest=json.loads((root/'native/tts/artifacts.json').read_text())
model=root/config['modelPath']; environment=root/'.data/tts/venv'
for item in manifest['files']:
    target=model/item['path']; target.parent.mkdir(parents=True,exist_ok=True)
    def matches(p):
        return p.is_file() and p.stat().st_size==item['size'] and hashlib.file_digest(p.open('rb'),'sha256').hexdigest()==item['sha256']
    if matches(target):continue
    temp=target.with_suffix('.download')
    candidate=args.reuse_model/item['path'] if args.reuse_model else None
    try:
        if candidate and matches(candidate):shutil.copyfile(candidate,temp)
        else:
            url=f"https://huggingface.co/{manifest['repo']}/resolve/{manifest['revision']}/{item['path']}"
            with urllib.request.urlopen(url,timeout=60) as response,temp.open('wb') as output:shutil.copyfileobj(response,output)
        if not matches(temp):raise RuntimeError('Model hash mismatch: '+item['path'])
        temp.replace(target)
    finally:temp.unlink(missing_ok=True)
if args.reuse_environment and not environment.exists():
    environment.parent.mkdir(parents=True,exist_ok=True)
    environment.symlink_to(args.reuse_environment.resolve(),target_is_directory=True)
if not (environment/'bin/python3').exists():venv.EnvBuilder(with_pip=True).create(environment)
python=environment/'bin/python3'
if not args.reuse_environment:
    subprocess.run([str(python),'-m','pip','install','--no-input','-r',str(root/'native/tts/requirements.lock')],check=True)
subprocess.run([str(python),'-c',"from importlib.metadata import version; assert version('kokoro-mlx') == '0.1.2'; import en_core_web_sm"],check=True)
print('Pinned Kokoro and Heart voice are ready. No microphone or playback was started.')
