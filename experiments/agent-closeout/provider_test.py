"""Offline budget and production-wire regression checks; no credentials/inference."""
import asyncio, json, tempfile, unittest
from decimal import Decimal
from pathlib import Path
import provider as p
from moolai_backend.settings import Settings
from moolai_backend.providers import NebiusProvider
from moolai_backend.schemas import RespondInput

def request(case='j01',step=1):
    return dict(callId=f'{p.EXPERIMENT}:{case}:route:{step}',caseId=case,method='route',step=step,
                input=dict(text='I am dictating a question.',recentContext='',activeConversation=False))
class BudgetTests(unittest.TestCase):
    def ledger(self):
        directory=tempfile.TemporaryDirectory();self.addCleanup(directory.cleanup)
        return p.Ledger(Path(directory.name)/'ledger.json',limit=p.TOTAL_CAP)
    def test_duplicate_failure_keeps_reservation(self):
        with self.ledger() as ledger:
            entry=p.reserve(ledger,request());entry['status']='failed_or_unknown_charge';ledger.save()
            with self.assertRaisesRegex(ValueError,'retry forbidden'):p.reserve(ledger,request())
            self.assertEqual(ledger.reserved,Decimal('.01'))
    def test_cumulative_budget_prevents_dispatch(self):
        with self.ledger() as ledger:
            ledger.entries=[dict(reservedUsd='35.87')]
            with self.assertRaisesRegex(ValueError,'Cumulative'):p.reserve(ledger,request())
    def test_run_budget_prevents_dispatch(self):
        with self.ledger() as ledger:
            ledger.entries=[dict(validation=p.EXPERIMENT,reservedUsd='10',method='legacy')]
            with self.assertRaisesRegex(ValueError,'Run cap'):p.reserve(ledger,request())
    def test_nonsequential_or_unknown_cases_rejected(self):
        with self.ledger() as ledger:
            for req in [request(step=2),request(case='invented')]:
                with self.assertRaises(ValueError):p.reserve(ledger,req)
            self.assertEqual(len(ledger.entries),0)
    def test_per_case_cap_and_cross_phase_misuse(self):
        with self.ledger() as ledger:
            req=request();req.update(method='vision',callId=f'{p.EXPERIMENT}:j01:vision:1')
            with self.assertRaisesRegex(ValueError,'isolation'):p.reserve(ledger,req)
    def test_frozen_hash_detects_change(self):
        with tempfile.TemporaryDirectory() as directory:
            target=Path(directory)/'freeze.json';target.write_text(json.dumps({'experiment':p.EXPERIMENT,'sourceHashes':{}}))
            with self.assertRaisesRegex(ValueError,'Incomplete freeze'):p.verify_freeze(target)
    def test_production_output_cap_and_answer_only_control(self):
        class Fake(p.Gateway):
            def __init__(self):super().__init__(Settings(),None);self.payload=None
            async def request(self,provider,url,key,payload=None,method='POST'):
                if method=='GET':return {'data':[{'id':Settings.agent_model}]}
                self.payload=payload
                return {'model':Settings.agent_model,'choices':[{'finish_reason':'stop','message':{'content':'A supported answer.'}}]}
        async def check():
            g=Fake();await NebiusProvider(g).respond(RespondInput(messages=[{'role':'user','content':'Answer.'}],tools=[],responseMode='answer_only'))
            self.assertEqual(g.payload['max_completion_tokens'],2400);self.assertEqual(g.payload['tool_choice'],'none');self.assertNotIn('tools',g.payload)
        asyncio.run(check())
if __name__=='__main__':unittest.main()
