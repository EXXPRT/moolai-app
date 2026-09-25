import importlib.util
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('harness_wire_check', ROOT / 'scripts/harness-wire-check.py')
checker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(checker)


def report(mode='auto', content='Read the source note.'):
    return {'calls': [{'callId': f'agent_harness_v1:agent:h01:H1:super:0:1',
        'phase': 'agent', 'caseId': 'h01', 'profile': 'H1', 'modelProfile': 'super', 'repeat': 0, 'step': 1,
        'input': {'messages': [{'role': 'user', 'content': content}], 'tools': [], 'responseMode': mode},
    }]}


async def test_offline_wire_check_includes_backend_closure_tool():
    result = await checker.check(report())
    assert result['frames'] == 1 and result['allWithinBound']
    assert result['networkRequests'] == result['paidCalls'] == 0
    assert result['framesById'][0]['toolNames'] == ['propose_end_conversation']


async def test_raw_input_can_fit_while_complete_provider_wire_exceeds_bound():
    data = report(content='x' * 11400)
    assert len(json.dumps(data['calls'][0]['input']).encode()) < 12000
    result = await checker.check(data)
    assert not result['allWithinBound'] and result['maximumWireBytes'] > 12000


async def test_answer_only_wire_has_neither_task_nor_closure_tools():
    data = report('answer_only')
    data['calls'][0]['input']['tools'] = [{'name': 'read_note', 'description': 'Read a source.', 'parameters': {'type': 'object'}}]
    result = await checker.check(data)
    assert result['framesById'][0]['toolNames'] == []
    assert result['framesById'][0]['toolChoice'] == 'none'
