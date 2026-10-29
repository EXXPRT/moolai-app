"""Deploy files: what Vercel installs, bundles and ignores; an entrypoint that imports with nothing set;
and a local runner that never runs on Vercel or prints a key."""
import importlib.util
import json
import os
import re
import subprocess
import sys
from importlib import metadata
from pathlib import Path, PurePosixPath

import httpx
import pytest

from moolai_backend import demo_local
from moolai_backend.demo_counters import Caps, MemoryCounters, UpstashCounters
from moolai_backend.demo_gateway import ROUTES, recover_path

ROOT = Path(__file__).resolve().parents[2]
VERCEL_MARKERS = {'python_version': '3.13', 'python_full_version': '3.13.5', 'sys_platform': 'linux',
                  'platform_system': 'Linux', 'os_name': 'posix', 'implementation_name': 'cpython',
                  'platform_python_implementation': 'CPython', 'platform_machine': 'x86_64'}


def canonical(name: str) -> str:
    return re.sub(r'[-_.]+', '-', name).lower()


def pins(path: Path) -> dict[str, tuple[str, frozenset[str]]]:
    result = {}
    for line in path.read_text().splitlines():
        line = line.split('#')[0].strip()
        if line:
            match = re.fullmatch(r'([A-Za-z0-9_.-]+)(?:\[([a-z,]+)\])?==([0-9][0-9A-Za-z.]*)', line)
            assert match, line
            result[canonical(match[1])] = (match[3], frozenset(filter(None, (match[2] or '').split(','))))
    return result


def test_function_requirements_are_exact_pins_from_the_backend_constraints():
    api, constraints = pins(ROOT / 'api' / 'requirements.txt'), pins(ROOT / 'backend' / 'constraints.txt')
    assert {name: version for name, (version, _) in api.items()}.items() <= {
        name: version for name, (version, _) in constraints.items()}.items()
    assert api['psycopg'] == ('3.2.9', frozenset({'binary'}))
    # Vercel brings its own uvicorn; nothing for tests or local runs is deployed.
    assert not set(api) & {'uvicorn', 'python-dotenv', 'pytest', 'pytest-asyncio'}
    assert (ROOT / 'api' / '.python-version').read_text().strip() == '3.13'


def test_function_requirements_include_everything_they_import_on_vercel():
    requirements = pytest.importorskip('packaging.requirements')
    api = pins(ROOT / 'api' / 'requirements.txt')
    pending, missing = [(name, extras) for name, (_, extras) in api.items()], set()
    while pending:
        name, extras = pending.pop()
        for line in metadata.requires(name) or []:
            requirement = requirements.Requirement(line)
            wanted = requirement.marker is None or any(
                requirement.marker.evaluate({**VERCEL_MARKERS, 'extra': extra}) for extra in (extras | {''}))
            if wanted:
                dependency = canonical(requirement.name)
                if dependency not in api:
                    missing.add(dependency)
                elif requirement.extras - api[dependency][1]:
                    pending.append((dependency, frozenset(requirement.extras)))
    assert missing == set()


def test_vercel_json_builds_the_page_and_bundles_only_the_gateway():
    config = json.loads((ROOT / 'vercel.json').read_text())
    assert config['framework'] is None
    assert config['installCommand'] == 'ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci --no-audit --no-fund'
    assert (config['buildCommand'], config['outputDirectory']) == ('npm run build:web', 'apps/web/dist')
    assert set(config['functions']) == {'api/index.py'}
    function = config['functions']['api/index.py']
    assert function['maxDuration'] == 300 and function['includeFiles'] == 'backend/moolai_backend/**'
    excluded = function['excludeFiles']
    assert isinstance(excluded, str) and excluded[0] == '{' and excluded[-1] == '}'
    patterns = set(excluded[1:-1].split(','))
    assert {'**/.env', '**/.env.*', 'runtime.env', '.data/**', '**/*.sqlite*', 'backend/tests/**'} <= patterns
    assert not any(pattern.endswith('.md') for pattern in patterns)  # prompts.py reads instructions/*.md.
    assert not any('moolai_backend' in pattern for pattern in patterns)
    assert config['rewrites'] == [{'source': '/api/(.*)', 'destination': '/api?__path=$1'}]
    headers = {rule['source']: {header['key']: header['value'] for header in rule['headers']}
               for rule in config['headers']}
    assert headers['/api/(.*)'] == {'X-Content-Type-Options': 'nosniff', 'X-Robots-Tag': 'noindex'}
    assert headers['/((?!api/).*)'] == {
        'Content-Security-Policy': "frame-ancestors 'none'",
        'Permissions-Policy': 'microphone=(self), camera=(), geolocation=()',
        'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Content-Type-Options': 'nosniff'}
    assert not any(key.lower() == 'cache-control' for rule in headers.values() for key in rule)  # Set in code.


def test_every_public_route_survives_the_vercel_rewrite():
    source, destination = r'/api/(.*)', '/api?__path=$1'
    for path in ROUTES:
        captured = re.fullmatch(source, path)[1]
        rewritten = destination.replace('$1', captured)
        target, query = rewritten.split('?')
        assert recover_path({'path': target, 'query_string': query.encode()}) == (path, 'rewrite')
        assert recover_path({'path': path, 'query_string': b''}) == (path, 'original')


def test_vercelignore_keeps_keys_and_local_data_out_of_any_upload():
    patterns = [line for line in (ROOT / '.vercelignore').read_text().splitlines() if line and not line.startswith('#')]
    assert {'**/.env', '**/.env.*', '!**/.env.example', 'runtime.env', '.data', '**/*.sqlite*', 'backend/.venv',
            'obsidian-notes'} <= set(patterns)
    ignored = [pattern for pattern in patterns if not pattern.startswith('!')]
    for path in ('backend/.env', '.env', 'apps/web/.env.local', '.data/brain.sqlite', 'brain.sqlite-wal'):
        assert any(PurePosixPath(path).full_match(pattern) or PurePosixPath(path).parts[0] == pattern
                   for pattern in ignored), path


async def test_the_vercel_entrypoint_imports_with_an_empty_environment_and_is_not_live(monkeypatch):
    for name in list(os.environ):
        monkeypatch.delenv(name)
    monkeypatch.setattr(sys, 'path', list(sys.path))
    spec = importlib.util.spec_from_file_location('moolai_vercel_entrypoint', ROOT / 'api' / 'index.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    assert sys.path[0] == str(ROOT / 'backend')
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url='https://demo.test') as client:
        config = await client.get('/api/demo/config')
        rewritten = await client.get('/api', params={'__path': 'demo/config'})
        refused = await client.post('/api/v1/route', json={})
    assert config.status_code == 200 and config.json()['live'] is False and config.json()['voice'] is False
    assert rewritten.json() == config.json()
    assert (refused.status_code, refused.json()) == (503, {'detail': 'demo_unavailable'})
    assert module.app.cfg.local is False and module.app.counters is None


def test_a_fresh_interpreter_imports_the_entrypoint_with_no_environment_at_all():
    script = '''
import asyncio, importlib.util, json
import httpx
spec = importlib.util.spec_from_file_location('entrypoint', 'api/index.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
async def main():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=module.app), base_url='https://x.test') as client:
        print(json.dumps((await client.get('/api/demo/config')).json()))
asyncio.run(main())
'''
    result = subprocess.run([sys.executable, '-I', '-c', script], cwd=ROOT, env={}, capture_output=True, text=True,
                            timeout=120)
    assert result.returncode == 0, result.stderr
    config = json.loads(result.stdout.strip().splitlines()[-1])
    assert config['live'] is False and config['reason'] == 'disabled'


def test_the_local_runner_refuses_to_run_on_vercel(monkeypatch):
    monkeypatch.setattr(demo_local, 'serve', lambda app: pytest.fail('The local runner served on Vercel'))
    for name in ('VERCEL', '__VC_HANDLER_ENTRYPOINT'):
        monkeypatch.delenv('VERCEL', raising=False)
        monkeypatch.delenv('__VC_HANDLER_ENTRYPOINT', raising=False)
        monkeypatch.setenv(name, '1')
        with pytest.raises(SystemExit):
            demo_local.main([])


ENV_FILE = {'NEBIUS_API_KEY': 'local-nebius-value', 'TYPESAFE_API_KEY': 'local-typesafe-value',
            'TAVILY_API_KEY': 'local-tavily-value', 'OPENAI_API_KEY': 'local-openai-value',
            'KV_REST_API_URL': 'https://kv.upstash.test', 'KV_REST_API_TOKEN': 'local-upstash-value'}


@pytest.fixture
def local_run(tmp_path, monkeypatch):
    path = tmp_path / '.env'
    path.write_text(''.join(f'{name}={value}\n' for name, value in ENV_FILE.items()))
    for name in list(os.environ):
        monkeypatch.delenv(name)
    for name in ENV_FILE:
        monkeypatch.delenv(name, raising=False)  # Recorded, so whatever the .env sets is removed again.
    monkeypatch.setenv('TAVILY_API_KEY', 'from-the-shell')
    monkeypatch.setattr(demo_local, 'ENV_FILE', path)
    served = []
    monkeypatch.setattr(demo_local, 'serve', served.append)
    return served


def test_the_local_runner_loads_backend_env_without_printing_it(local_run, capsys):
    demo_local.main([])
    (app,) = local_run
    assert app.settings.nebius_api_key == 'local-nebius-value'
    assert app.settings.tavily_api_key == 'from-the-shell'  # The shell wins over .env.
    assert app.cfg.live and app.cfg.local and app.cfg.voice and isinstance(app.counters, MemoryCounters)
    assert app.cfg.caps == Caps(total=2_000_000, day=2_000_000, session=1_000_000)
    assert (app.cfg.site_key, app.cfg.secret_key) == (demo_local.TEST_SITE_KEY, demo_local.TEST_SECRET)
    assert len(app.cfg.session_secret) == 64 and app.cfg.hostnames == frozenset({'localhost', '127.0.0.1'})
    output = capsys.readouterr()
    assert 'local-' not in output.out + output.err and 'from-the-shell' not in output.out + output.err


def test_the_local_runner_can_use_upstash_under_local_keys(local_run):
    demo_local.main(['--upstash'])
    (app,) = local_run
    assert isinstance(app.counters, UpstashCounters) and app.counters.keys.prefix == 'moolai:demo:local:'
    assert app.cfg.live and app.cfg.local
