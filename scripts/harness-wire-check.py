"""Serialize saved harness frames through the real provider, without network or keys.

Usage: backend/.venv/bin/python scripts/harness-wire-check.py REPORT.json
Checks complete UTF-8 wire size, including backend-injected closure tools.
"""
import argparse
import asyncio
import importlib
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from moolai_backend.providers import Gateway
from moolai_backend.schemas import RespondInput
from moolai_backend.settings import Settings

bridge = importlib.import_module('harness-provider')


class OfflineGateway(Gateway):
    def __init__(self, model):
        super().__init__(Settings(agent_model=model), None)
        self.payload = None

    async def request(self, provider, url, key, payload=None, method='POST'):
        if key or provider != 'Nebius':
            raise ValueError('Offline serialization must have no credential')
        if method == 'GET':
            return {'data': [{'id': self.settings.agent_model}]}
        if method != 'POST' or self.payload is not None:
            raise ValueError('Expected exactly one offline serialization')
        self.payload = payload
        return {'model': self.settings.agent_model, 'choices': [
            {'finish_reason': 'stop', 'message': {'role': 'assistant', 'content': 'Offline wire check.'}},
        ]}


async def check(report):
    rows = []
    groups = {}
    for call in report['calls']:
        request = {key: call[key] for key in ('callId', 'phase', 'caseId', 'profile', 'modelProfile', 'repeat', 'step', 'input')}
        model = bridge.validate_request(request)
        gateway = OfflineGateway(model)
        await bridge.HarnessProvider(gateway).respond(RespondInput.model_validate(call['input']))
        wire = gateway.payload
        # Same conservative serializer and complete payload used at paid reservation.
        size = len(json.dumps(wire, ensure_ascii=False).encode('utf-8'))
        row = {'callId': call['callId'], 'bytes': size, 'withinBound': size <= bridge.WIRE_BYTES,
               'toolChoice': wire['tool_choice'], 'toolNames': [tool['function']['name'] for tool in wire.get('tools', [])]}
        rows.append(row)
        key = ':'.join(call[key] for key in ('phase', 'profile', 'modelProfile'))
        group = groups.setdefault(key, {'frames': 0, 'maximumWireBytes': 0, 'exceedsBound': 0})
        group['frames'] += 1
        group['maximumWireBytes'] = max(group['maximumWireBytes'], size)
        group['exceedsBound'] += int(not row['withinBound'])
        if wire['max_completion_tokens'] != 4000 or wire['temperature'] != .2 or wire['stream'] is not False:
            raise ValueError('Frozen model settings changed')
        if call['input'].get('responseMode', 'auto') == 'answer_only' and (wire.get('tools') or wire['tool_choice'] != 'none'):
            raise ValueError('Answer-only frame exposes tools')
    return {'experiment': bridge.EXPERIMENT, 'paidCalls': 0, 'networkRequests': 0,
            'frames': len(rows), 'maximumWireBytes': max((row['bytes'] for row in rows), default=0),
            'wireBoundBytes': bridge.WIRE_BYTES, 'allWithinBound': all(row['withinBound'] for row in rows),
            'groups': groups, 'framesById': rows}


async def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('report', type=Path)
    args = parser.parse_args()
    result = await check(json.loads(args.report.read_text()))
    print(json.dumps(result, indent=2))
    if not result['allWithinBound']:
        raise SystemExit(1)


if __name__ == '__main__':
    asyncio.run(main())
