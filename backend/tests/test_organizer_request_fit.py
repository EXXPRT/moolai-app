"""Cross-language check: every organizer request the TypeScript controller builds fits the real backend request bound.

The controller packs requests with its own estimate (packages/agent/src/organizer-budget.ts). This test runs the real
TypeScript organizer on long workloads, then measures each request with the real backend request builder for every
organization format. Exact state-byte equality pins the estimator; the measured overhead pins its fixed reserve.
"""
import json
import os
import shutil
import subprocess
from pathlib import Path

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import ThoughtInput
from moolai_backend.settings import Settings

ROOT = Path(__file__).resolve().parents[2]
REQUEST_BYTES, FIXED_RESERVE_BYTES = 32000, 5200  # ORGANIZER_REQUEST in organizer-budget.ts


@pytest.fixture(scope='module')
def captured():
    tsx = ROOT / 'node_modules' / '.bin' / 'tsx'
    if not shutil.which('node') or not tsx.exists():
        if os.getenv('GITHUB_ACTIONS') == 'true':
            pytest.fail('CI must run the cross-language organizer check (node and tsx are required)')
        pytest.skip('node and the repository tsx install are required for the cross-language organizer check')
    result = subprocess.run(['node', '--import', 'tsx', str(Path(__file__).with_name('organizer_capture.mts'))],
                            cwd=ROOT, capture_output=True, text=True, timeout=180, check=True)
    items = json.loads(result.stdout)
    assert {item['name'] for item in items} >= {'denseLog', 'sameTopic', 'answers', 'spaceless', 'manualSummary'}
    assert any(item['input'].get('activeNote') for item in items)
    return items


async def measure(item: ThoughtInput, organization_format: str) -> tuple[int, int]:
    settings = Settings(nebius_api_key='fixture', thought_organization_format=organization_format)
    posted = []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.summary_model}]})
        posted.append(request.content)
        return httpx.Response(500, json={'error': 'measurement only'})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError):
            await NebiusProvider(Gateway(settings, client)).consolidate(item)
    assert len(posted) == 1, 'The request was refused before dispatch'
    payload = json.loads(posted[0])
    state = payload['messages'][1]['content']
    state_bytes = len(json.dumps(state, ensure_ascii=False).encode('utf-8')) - 2
    return len(posted[0]), state_bytes


@pytest.mark.parametrize('organization_format', ['units', 'units_top_level', 'compact'])
async def test_controller_built_requests_fit_the_backend_bound(captured, organization_format):
    for item in captured:
        total, state_bytes = await measure(ThoughtInput.model_validate(item['input']), organization_format)
        if organization_format == 'compact':
            # The opt-in compact format addresses units by index, which is never larger than the estimate's unit IDs.
            assert state_bytes <= item['stateBytes'], (item['name'], 'TypeScript estimate is below the compact state')
        else:
            assert state_bytes == item['stateBytes'], (item['name'], 'TypeScript estimate differs from the backend state')
        assert total <= REQUEST_BYTES, (item['name'], total)
        assert total - state_bytes <= FIXED_RESERVE_BYTES, (item['name'], organization_format, total - state_bytes)
