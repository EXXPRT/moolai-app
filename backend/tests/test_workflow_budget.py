import importlib.util
import json
from pathlib import Path

import pytest


@pytest.fixture
def budget(tmp_path, monkeypatch):
    script = Path(__file__).resolve().parents[2] / 'scripts/workflow-budget.py'
    spec = importlib.util.spec_from_file_location('workflow_budget', script)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    ledger = tmp_path / 'ledger.json'
    monkeypatch.setenv('MOOLAI_VALIDATION_LEDGER', str(ledger))
    return module, ledger


def test_workflow_reservation_rejects_duplicate_and_keeps_failed_charge(budget):
    module, path = budget
    module.main(['reserve', 'respond', '.20', 'a', 'run1'])
    module.main(['complete', 'a', 'failed_or_unknown_charge'])
    with pytest.raises(ValueError, match='already reserved'):
        module.main(['reserve', 'respond', '.20', 'a', 'run1'])
    data = json.loads(path.read_text())
    assert len(data['calls']) == 1
    assert data['calls'][0]['reservedUsd'] == '.20'
    assert data['calls'][0]['status'] == 'failed_or_unknown_charge'
    assert data['calls'][0]['validation'] == module.VALIDATION


def test_workflow_caps_do_not_reset_with_run_id(budget):
    module, path = budget
    for i in range(3):
        module.main(['reserve', 'vision', '.03', str(i), 'first'])
    with pytest.raises(ValueError, match='call limit'):
        module.main(['reserve', 'vision', '.03', 'another', 'second'])
    with pytest.raises(ValueError, match='Unexpected reservation'):
        module.main(['reserve', 'respond', '.01', 'cheap', 'second'])
    assert len(json.loads(path.read_text())['calls']) == 3


def test_workflow_honors_existing_cumulative_spend(budget):
    module, path = budget
    path.write_text(json.dumps({'version':1,'calls':[{'reservedUsd':'14.99'}]}))
    with pytest.raises(ValueError, match='US\\$15'):
        module.main(['reserve', 'respond', '.20', 'over', 'first'])
    assert len(json.loads(path.read_text())['calls']) == 1
