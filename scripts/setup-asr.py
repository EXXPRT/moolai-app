#!/usr/bin/env python3
"""Install the explicitly selected local Whisper model; never capture or infer audio."""
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
import venv

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / '.data' / 'asr' / 'whisper'
EXPERIMENT = ROOT / '.data' / 'asr' / 'whisper-experiment'


def digest(path):
    with path.open('rb') as source:
        return hashlib.file_digest(source, 'sha256').hexdigest()


def matches(path, artifact):
    return path.is_file() and path.stat().st_size == artifact['size'] and digest(path) == artifact['sha256']


def fetch(artifact, target, candidates=()):
    """Reuse only identical verified bytes, then atomically publish a verified download."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if matches(target, artifact):
        print(f'Verified {target.name}', flush=True)
        return
    temporary = target.with_name(target.name + '.part')
    try:
        for candidate in candidates:
            if matches(candidate, artifact):
                print(f'Reusing verified {target.name}', flush=True)
                shutil.copyfile(candidate, temporary)
                break
        else:
            url = artifact.get('url') or f"https://huggingface.co/{artifact['repo']}/resolve/{artifact['revision']}/{artifact['filename']}"
            print(f'Downloading {target.name} ({artifact["size"]:,} bytes)', flush=True)
            request = urllib.request.Request(url, headers={'User-Agent': 'Moolai-local-ASR-setup'})
            with urllib.request.urlopen(request, timeout=60) as response, temporary.open('wb') as output:
                shutil.copyfileobj(response, output)
        if not matches(temporary, artifact):
            raise RuntimeError(f'Pinned size or SHA256 mismatch: {target.name}')
        temporary.replace(target)
    finally:
        temporary.unlink(missing_ok=True)


def read_config():
    # Share the Node validation boundary rather than maintain a Python copy.
    result = subprocess.run(
        ['node', '--input-type=module', '-e',
         'const {readAsrConfig}=await import(process.argv[1]); console.log(JSON.stringify(await readAsrConfig()));',
         (ROOT / 'scripts' / 'asr-config.mjs').as_uri()],
        cwd=ROOT, check=True, text=True, capture_output=True,
    )
    return json.loads(result.stdout)


def cmake_tool(artifact):
    environment = DEST / 'build-env'
    executable = environment / 'bin' / 'cmake'
    if executable.exists():
        version = subprocess.run([str(executable), '--version'], check=True, capture_output=True, text=True).stdout.splitlines()[0]
        if version == f'cmake version {artifact["version"]}':
            return executable
    wheel = DEST / 'tools' / artifact['filename']
    fetch(artifact, wheel, [EXPERIMENT / artifact['filename']])
    if not (environment / 'bin' / 'python').exists():
        venv.EnvBuilder(with_pip=True).create(environment)
    subprocess.run([str(environment / 'bin' / 'python'), '-m', 'pip', 'install', '--disable-pip-version-check',
                    '--no-input', '--no-index', '--no-deps', '--force-reinstall', str(wheel)], check=True)
    return executable


def build_runtime(manifest):
    runtime = manifest['runtime']
    server = DEST / 'build' / 'bin' / 'whisper-server'
    stamp_path = DEST / 'runtime-install.json'
    try:
        stamp = json.loads(stamp_path.read_text())
    except (FileNotFoundError, json.JSONDecodeError):
        stamp = {}
    if (stamp.get('revision') == runtime['revision'] and stamp.get('sourceSha256') == runtime['sha256']
            and stamp.get('cmakeVersion') == manifest['cmake']['version'] and server.is_file()
            and stamp.get('serverSha256') == digest(server)):
        print(f'Verified built whisper.cpp {runtime["version"]}', flush=True)
        return
    archive = DEST / 'whisper.cpp.tar.gz'
    fetch(runtime, archive, [EXPERIMENT / 'whisper.cpp.tar.gz'])
    source = DEST / f'source-{runtime["revision"]}'
    if not source.exists():
        with tempfile.TemporaryDirectory(prefix='source-', dir=DEST) as unpacked:
            unpacked = Path(unpacked)
            with tarfile.open(archive) as package:
                package.extractall(unpacked, filter='data')
            entries = list(unpacked.iterdir())
            if len(entries) != 1 or not (entries[0] / 'CMakeLists.txt').is_file():
                raise RuntimeError('Unexpected pinned whisper.cpp archive layout')
            entries[0].rename(source)
    cmake = cmake_tool(manifest['cmake'])
    subprocess.run([str(cmake), '-S', str(source), '-B', str(DEST / 'build'), '-DCMAKE_BUILD_TYPE=Release',
                    '-DGGML_METAL=ON', '-DWHISPER_COREML=OFF', '-DWHISPER_BUILD_TESTS=OFF',
                    '-DWHISPER_BUILD_EXAMPLES=ON', '-DWHISPER_SDL2=OFF'], check=True)
    subprocess.run([str(cmake), '--build', str(DEST / 'build'), '--config', 'Release',
                    '--target', 'whisper-server', '-j', str(min(os.cpu_count() or 1, 8))], check=True)
    stamp_path.write_text(json.dumps({
        'revision': runtime['revision'], 'version': runtime['version'],
        'sourceSha256': runtime['sha256'], 'cmakeVersion': manifest['cmake']['version'],
        'serverSha256': digest(server), 'metal': True, 'coreML': False,
    }, indent=2) + '\n')


def main():
    if sys.version_info < (3, 12):
        raise SystemExit('ASR setup requires Python 3.12 or newer for safe archive extraction.')
    if platform.system() != 'Darwin' or platform.machine() != 'arm64':
        raise SystemExit('ASR setup supports macOS Apple Silicon with Metal.')
    for command in ['node', 'ffmpeg', 'xcrun']:
        if not shutil.which(command):
            raise SystemExit(f'Missing prerequisite: {command}. Install Node, ffmpeg and Xcode command-line tools before setup.')
    subprocess.run(['xcrun', '--find', 'clang++'], check=True, capture_output=True)
    config = read_config()
    manifest = json.loads((ROOT / 'docs' / 'whisper-artifacts.json').read_text())
    DEST.mkdir(parents=True, exist_ok=True)
    build_runtime(manifest)
    for artifact in [manifest['models'][config['model']], manifest['vad']]:
        fetch(artifact, DEST / 'models' / artifact['filename'], [EXPERIMENT / artifact['filename']])
    print(f'Installed {config["model"]} + Silero VAD. Run npm run asr. No audio was captured or inferred.')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        if error.stderr:
            print(error.stderr, file=sys.stderr)
        raise SystemExit(f'ASR setup command failed with exit code {error.returncode}.') from error
    except (OSError, RuntimeError) as error:
        raise SystemExit(f'ASR setup failed: {error}') from error
