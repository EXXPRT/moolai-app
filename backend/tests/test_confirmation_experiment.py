import importlib.util
import json
from pathlib import Path
import sys
from decimal import Decimal

import pytest
from moolai_backend.validate_live import Ledger

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'scripts'))
spec = importlib.util.spec_from_file_location('confirmation_experiment', ROOT / 'scripts/validate-j1-confirmation.py')
experiment = importlib.util.module_from_spec(spec)
spec.loader.exec_module(experiment)


def test_actual_first_verdict_selects_candidate_without_threshold_or_expected_label():
    cases = json.loads(experiment.CASES.read_text())['cases']
    negative = next(c for c in cases if c['id'] == 'start-02')
    assert experiment.candidate(negative, {'route': 'start_agent', 'confidence': .2}) == 'start_agent'
    assert experiment.candidate(negative, {'route': 'dictate', 'confidence': 1}) is None
    assert experiment.candidate(negative, {'route': 'end_agent', 'confidence': 1}) is None


def test_confirmation_payload_cannot_leak_labels_or_b_confidence_into_c():
    case = json.loads(experiment.CASES.read_text())['cases'][0]
    payload = experiment.confirmation_input(case, 'start_agent', 'Question')
    encoded = json.dumps(payload)
    assert case['id'] not in encoded
    assert 'expected' not in encoded
    assert 'confidence' not in encoded
    assert payload['original']['text'] == case['input']['text']
    assert payload['latestUserReply']['text'] == case['confirmationReply']['text']


@pytest.mark.parametrize('result', [
    {'verdict':'confirmed','evidenceQuote':'invented'},
    {'verdict':'confirmed','evidenceQuote':''},
    {'verdict':'rejected','evidenceQuote':'Yes','extra':True},
    {'verdict':'incorrect','evidenceQuote':'Yes'},
])
def test_super_ungrounded_or_invalid_assessment_fails_closed(result):
    with pytest.raises(ValueError):
        experiment.parse_super({'content':json.dumps(result)}, 'Yes, use only my notes.')


def test_super_does_not_execute_tool_proposals():
    with pytest.raises(ValueError, match='emitted tools'):
        experiment.parse_super({'content':'{}','tool_calls':[{'name':'create_note'}]}, 'Yes')
    assert experiment.parse_super({'content':'{"verdict":"confirmed","evidenceQuote":"Yes"}'}, 'Yes, use my notes')['verdict'] == 'confirmed'


def test_unknown_work_choice_never_implies_cancel():
    assert experiment.parse_confirmation({'confirmation':{'choice':'end_agent','confidence':.95},
        'end_action':{'choice':'unclear','confidence':.95}}) == {'action':'end_agent','confidence':.95}


def test_comparison_budget_is_atomic_and_preserves_existing_cost(tmp_path):
    path = tmp_path/'ledger.json'
    path.write_text(json.dumps({'version':1,'calls':[{'reservedUsd':'6.69'}]}))
    with Ledger(path, limit=Decimal(15)) as ledger:
        first = experiment.reserve(ledger, 'super', 'call-1', 'case', 'C')
        assert first['validation'] == experiment.EXPERIMENT
        assert ledger.reserved == Decimal('6.89')
        with pytest.raises(ValueError, match='already reserved'):
            experiment.reserve(ledger, 'super', 'call-1', 'case', 'C')
        for index in range(2,17):
            experiment.reserve(ledger, 'super', f'call-{index}', 'case', 'C')
        with pytest.raises(ValueError, match='cap reached'):
            experiment.reserve(ledger, 'super', 'extra-run-id', 'case', 'C')
        for index in range(48):
            experiment.reserve(ledger, 'jev', f'jev-{index}', 'case', 'B')
        assert ledger.reserved == Decimal('10.37')
        assert sum(Decimal(e['reservedUsd']) for e in ledger.entries if e.get('validation') == experiment.EXPERIMENT) == Decimal('3.68')
