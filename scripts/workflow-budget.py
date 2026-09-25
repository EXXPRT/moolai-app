#!/usr/bin/env python3
"""Fail-closed budget bridge for the explicitly approved no-microphone validation.

Reservations are conservative bounds, not invoices. Every dispatch reserves first;
failed/unknown requests keep their reservation. This script never calls providers.
"""
import json
import os
from pathlib import Path
import sys
from decimal import Decimal
from datetime import datetime, timezone

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'backend'))
from moolai_backend.validate_live import Ledger

CAPS = {'route': (48, '.01'), 'tag': (8, '.01'), 'connect': (5, '.01'),
        'summarize': (4, '.05'), 'vision': (3, '.03'), 'respond': (9, '.20')}
# The frozen baseline permits eight Super calls. One separately recorded, manual
# OCR follow-through uses unused reservations; the same US$2.50 run cap applies.
TOTAL = Decimal('15')
RUN = Decimal('2.50')
VALIDATION = 'full-workflow-no-microphone-v1'

def main(args):
    path = Path(os.environ.get('MOOLAI_VALIDATION_LEDGER', ROOT / '.data/provider-validation.json'))
    with Ledger(path, limit=TOTAL) as ledger:
        if args[0] == 'reserve':
            method, requested, call_id, run_id = args[1:]
            count, amount = CAPS[method]
            if Decimal(requested) != Decimal(amount):
                raise ValueError('Unexpected reservation amount')
            if any(entry.get('callId') == call_id for entry in ledger.entries):
                raise ValueError('Operation already reserved; automatic retries are disabled')
            # All invocations share this plan allowance; changing runId cannot reset it.
            entries = [entry for entry in ledger.entries if entry.get('validation') == VALIDATION]
            if sum(Decimal(entry['reservedUsd']) for entry in entries) + Decimal(amount) > RUN:
                raise ValueError('This validation would exceed US$2.50')
            if sum(entry.get('apiMethod') == method for entry in entries) >= count:
                raise ValueError(f'{method} call limit reached')
            ledger.ensure_budget(1, Decimal(amount))
            entry = {'provider': 'TypeSafe' if method in ('route', 'tag', 'connect') else 'Nebius',
                     'at': datetime.now(timezone.utc).isoformat(), 'reservedUsd': amount,
                     'status': 'reserved_before_dispatch', 'actualCostUsd': None,
                     'callId': call_id, 'apiMethod': method, 'runId': run_id, 'validation': VALIDATION}
            ledger.entries.append(entry)
            # Reservation and run identity share one atomic write, including on crash.
            ledger.save()
        elif args[0] == 'complete':
            call_id, status = args[1:]
            if status not in ('succeeded', 'failed_or_unknown_charge'):
                raise ValueError('Invalid completion status')
            matches = [entry for entry in ledger.entries if entry.get('callId') == call_id]
            if len(matches) != 1:
                raise ValueError('Missing or duplicate reservation')
            matches[0]['status'] = status
            ledger.save()
        elif args[0] != 'status':
            raise ValueError('Unknown command')
        print(json.dumps({'reservedUsd': str(ledger.reserved), 'totalCapUsd': str(TOTAL),
                         'runCapUsd': str(RUN), 'calls': len(ledger.entries)}))

if __name__ == '__main__':
    main(sys.argv[1:])
