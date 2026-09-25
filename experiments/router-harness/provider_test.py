import importlib.util,json,tempfile,unittest
from pathlib import Path
from decimal import Decimal
spec=importlib.util.spec_from_file_location('router_provider',Path(__file__).with_name('provider.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)

def request(phase='harness',case='c01',profile='native',model='super',step=1):
    body={'messages':[{'role':'user','content':'Synthetic input'}],'tools':[],'responseMode':'answer_only'}
    if phase=='complexity':body={'request':'Synthetic request','context':'Synthetic context','tools':['read_note'],'notesOnly':True}
    if phase=='j1':body={'text':'Synthetic text','recentContext':'Synthetic context','activeConversation':False}
    return {'callId':f'{p.EXPERIMENT}:{phase}:{case}:{profile}:{model}:{step}','phase':phase,'caseId':case,'profile':profile,'modelProfile':model,'step':step,'input':body}
class Ledger:
    def __init__(self,entries=None):self.entries=entries or [];self.saved=0
    @property
    def reserved(self):return sum((Decimal(e['reservedUsd']) for e in self.entries),Decimal(0))
    def ensure_budget(self,count,amount):
        if self.reserved+count*amount>p.CUMULATIVE_CAP:raise ValueError('Budget')
    def save(self):self.saved+=1
class Tests(unittest.TestCase):
    def test_manifest_maximum_fits(self):
        # 3 harnesses, two additional fixed models, worst-case high routed model;
        # 10 compatibility calls, 20 complexity decisions, 20 J1 decisions.
        total=3*8*6*p.RATES['super']+8*6*(p.RATES['lightning']+p.RATES['glm'])+8*6*p.RATES['glm']
        total+=6*p.RATES['super']+2*p.RATES['lightning']+2*p.RATES['glm']+40*p.RATES['jev']
        self.assertEqual(total,Decimal('5.970'));self.assertLessEqual(Decimal('19.40')+total,p.CUMULATIVE_CAP)
    def test_reservation_precedes_dispatch_and_duplicate_never_retries(self):
        l=Ledger();r=request();e=p.reserve(l,r);self.assertEqual(e['status'],'reserved_before_dispatch');self.assertEqual(l.saved,1)
        with self.assertRaisesRegex(ValueError,'Already reserved'):p.reserve(l,r)
    def test_total_and_historical_caps(self):
        for entries,message in [([{'reservedUsd':'25.865'}],'Cumulative'),([{'reservedUsd':'5.965','validation':p.EXPERIMENT}],'Experiment')]:
            with self.assertRaisesRegex(ValueError,message):p.reserve(Ledger(entries),request())
    def test_routed_switch_cannot_reset_six_call_group(self):
        l=Ledger()
        for step in range(1,7):p.reserve(l,request('routed','c01','native','glm' if step%2 else 'super',step))
        with self.assertRaises(ValueError):p.reserve(l,request('routed','c01','native','lightning',6))
    def test_undeclared_ids_phases_profiles_and_steps_rejected(self):
        for r in [request(case='c09'),request(model='unapproved'),request(step=True),request('j1','j21','jev','jev'),request('compatibility','compatibility','native','super',3)]:
            with self.assertRaises(ValueError):p.validate(r)
class GatewayTests(unittest.IsolatedAsyncioTestCase):
    async def test_invalid_wire_never_reserves_or_dispatches(self):
        import httpx
        calls=[]
        def handler(req):calls.append(req);return httpx.Response(200,json={'ok':True})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            base={'model':p.MODELS['super'],'max_completion_tokens':4000,'temperature':.2,'stream':False,'store':False,'messages':[],'tool_choice':'none'}
            for patch in [{'messages':[{'role':'user','content':'x'*13000}]},{'tools':[{'name':'read_note'}]},{'max_completion_tokens':4001}]:
                l=Ledger();g=p.MeteredGateway(p.Settings(),client,l,request())
                with self.assertRaises(ValueError):await g.request('Nebius','https://fixture.invalid','fixture-key',{**base,**patch})
                self.assertEqual(l.entries,[])
            self.assertEqual(calls,[])
    async def test_http_failure_retains_reservation_without_second_dispatch(self):
        import httpx
        calls=[]
        def handler(req):calls.append(req);return httpx.Response(503,json={'error':'fixture failure'})
        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            l=Ledger();g=p.MeteredGateway(p.Settings(),client,l,request())
            body={'model':p.MODELS['super'],'max_completion_tokens':4000,'temperature':.2,'stream':False,'store':False,'messages':[],'tool_choice':'none'}
            with self.assertRaises(p.ServiceError):await g.request('Nebius','https://fixture.invalid','fixture-key',body)
            with self.assertRaisesRegex(ValueError,'Second dispatch'):await g.request('Nebius','https://fixture.invalid','fixture-key',body)
            self.assertEqual(len(calls),1);self.assertEqual(l.reserved,p.RATES['super'])
if __name__=='__main__':unittest.main()
