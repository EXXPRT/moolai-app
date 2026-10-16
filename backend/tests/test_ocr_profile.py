"""OCR profile changes cannot silently change scene or Agent reasoning settings."""
import json
from dataclasses import replace

import httpx
import pytest

from moolai_backend.providers import Gateway, NebiusProvider, ServiceError
from moolai_backend.schemas import VisionInput
from moolai_backend.settings import Settings


def test_ocr_defaults_and_environment_are_independent_from_scene_model(monkeypatch):
    for name in ('NEBIUS_OCR_MODEL', 'NEBIUS_OCR_REASONING_EFFORT', 'NEBIUS_VISION_MODEL'):
        monkeypatch.delenv(name, raising=False)
    settings = Settings.from_env()
    assert settings.ocr_model == 'zai-org/GLM-5.3-Flash'
    assert settings.ocr_reasoning_effort == 'low'
    assert settings.vision_model == 'openbmb/MiniCPM-V-4_5'
    monkeypatch.setenv('NEBIUS_OCR_MODEL', 'explicit-ocr')
    monkeypatch.setenv('NEBIUS_OCR_REASONING_EFFORT', 'medium')
    configured = Settings.from_env()
    assert configured.ocr_model == 'explicit-ocr' and configured.ocr_reasoning_effort == 'medium'
    assert configured.vision_model == settings.vision_model and configured.agent_model == settings.agent_model
    with pytest.raises(ValueError, match='OCR reasoning'):
        replace(settings, ocr_reasoning_effort='unbounded')


@pytest.mark.parametrize('mode', ['ocr', 'visual'])
async def test_model_and_reasoning_match_requested_analysis_mode(mode):
    settings = Settings(nebius_api_key='fixture')
    payloads = []
    def respond(request):
        if request.method == 'GET':
            return httpx.Response(200, json={'data': [{'id': settings.ocr_model}, {'id': settings.vision_model}]})
        body = json.loads(request.content)
        payloads.append(body)
        return httpx.Response(200, json={'model': body['model'], 'choices': [{
            'finish_reason': 'stop', 'message': {'content': '{"observations":[],"interpretation":""}'}}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        await NebiusProvider(Gateway(settings, client)).vision(VisionInput(
            mode=mode, question='Read the name.' if mode == 'ocr' else 'Describe the shape.',
            image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert len(payloads) == 1 and payloads[0]['max_completion_tokens'] == 1600
    assert payloads[0]['model'] == (settings.ocr_model if mode == 'ocr' else settings.vision_model)
    assert payloads[0].get('reasoning_effort') == ('low' if mode == 'ocr' else None)


async def test_missing_ocr_model_does_not_fall_back_to_available_scene_model():
    settings = Settings(nebius_api_key='fixture')
    calls = []
    def respond(request):
        calls.append(request.method)
        return httpx.Response(200, json={'data': [{'id': settings.vision_model}]})
    async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
        with pytest.raises(ServiceError, match='unavailable'):
            await NebiusProvider(Gateway(settings, client)).vision(VisionInput(
                question='Read a serial.', image={'mimeType': 'image/png', 'dataBase64': 'YWJj'}))
    assert calls == ['GET']
