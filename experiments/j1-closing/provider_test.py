import importlib.util,json
from pathlib import Path
from decimal import Decimal
import httpx,pytest
spec=importlib.util.spec_from_file_location('closing_provider',Path(__file__).with_name('provider.py'))
p=importlib.util.module_from_spec(spec);spec.loader.exec_module(p)
def request():return {'callId':p.EXPERIMENT+':c01:current:route:1','caseId':'c01','profile':'current','method':'route','step':1,'input':{'text':'Done.','activeConversation':True,'recentContext':''}}
def test_duplicate_dispatch_retains_reservation(tmp_path):
    with p.Ledger(tmp_path/'ledger.json',limit=p.TOTAL_CAP) as ledger:
        p.reserve(ledger,request())
        with pytest.raises(ValueError,match='Duplicate'):p.reserve(ledger,request())
        assert ledger.reserved==Decimal('.01')
def test_budget_rejection_before_reservation(tmp_path):
    with p.Ledger(tmp_path/'ledger.json',limit=Decimal('.005')) as ledger:
        with pytest.raises(ValueError,match='budget'):p.reserve(ledger,request())
        assert not ledger.entries
@pytest.mark.parametrize('large',[True,False])
async def test_payload_bound_and_failure_never_retry(tmp_path,large):
    calls=[]
    def fail(request):calls.append(request);return httpx.Response(503)
    async with httpx.AsyncClient(transport=httpx.MockTransport(fail)) as client:
        with p.Ledger(tmp_path/'ledger.json',limit=p.TOTAL_CAP) as ledger:
            gateway=p.Metered(p.helpers.config(),client,ledger,request())
            payload={'model':p.MODELS['route'],'state':'x'*(16001 if large else 1)}
            with pytest.raises((ValueError,p.ServiceError)):await gateway.request('TypeSafe','https://example.test','fixture',payload)
            assert len(calls)==(0 if large else 1)
            assert ledger.reserved==(Decimal(0) if large else Decimal('.01'))
            if not large:
                with pytest.raises(ValueError,match='Second dispatch'):await gateway.request('TypeSafe','https://example.test','fixture',payload)
