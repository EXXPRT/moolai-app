"""Single-dispatch, metered provider bridge for synthetic closing comparisons."""
import argparse, asyncio, hashlib, importlib.util, json, sys, time
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
from copy import deepcopy
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
import httpx
from moolai_backend.providers import Gateway,JevProvider,NebiusProvider,ServiceError
from moolai_backend.schemas import RouteInput,RespondInput
from moolai_backend.validate_live import Ledger
spec=importlib.util.spec_from_file_location('pricing_helpers',ROOT/'experiments/contextual-help/provider.py')
helpers=importlib.util.module_from_spec(spec);spec.loader.exec_module(helpers)
EXPERIMENT='j1_closing_20260926_v1'
RUN_CAP=Decimal('1.20');TOTAL_CAP=Decimal('35.87');PRIOR=Decimal('26.196')
CAPS={'route':(112,Decimal('.01')),'respond':(2,Decimal('.03'))}
MODELS={'route':'jev-1.13.0','respond':'nvidia/Nemotron-3-Ultra-550b-a55b'}
FILES=['experiments/j1-closing/'+name for name in ('provider.py','cases.json','scenario.ts','run.ts')]+[
    'experiments/contextual-help/provider.py','experiments/agent-closeout/support.ts',
    'packages/agent/src/index.ts','packages/contracts/src/index.ts','backend/moolai_backend/providers.py',
    'backend/moolai_backend/schemas.py']
def hashes():return {name:hashlib.sha256((ROOT/name).read_bytes()).hexdigest() for name in FILES}
def history(ledger):
    rows=[r for r in ledger.entries if r.get('validation')!=EXPERIMENT]
    total=sum((Decimal(r['reservedUsd']) for r in rows),Decimal(0))
    if total!=PRIOR:raise ValueError('Historical ledger changed; review required')
    return {'reservedUsd':str(total),'rows':len(rows),'sha256':hashlib.sha256(json.dumps(rows,sort_keys=True).encode()).hexdigest()}
def validate(req):
    cases=json.loads((ROOT/'experiments/j1-closing/cases.json').read_text())
    ids={c['id'] for c in cases['cases']}|{c+'r' for c in cases['repeats']}
    method=req['method'];case=req['caseId'];profile=req['profile'];step=req['step']
    if method not in CAPS or type(step)!=int or not 1<=step<=2:raise ValueError('Undeclared request')
    if method=='route' and (case not in ids or profile not in ('current','contextual')):raise ValueError('Undeclared route')
    if method=='respond' and (case not in {c['id'] for c in cases['compatibility']} or profile!='contextual' or step!=1):raise ValueError('Undeclared compatibility check')
    if req['callId']!=f'{EXPERIMENT}:{case}:{profile}:{method}:{step}':raise ValueError('Unstable call ID')
    return (RouteInput if method=='route' else RespondInput).model_validate(req['input'])
def reserve(ledger,req):
    validate(req);rows=[r for r in ledger.entries if r.get('validation')==EXPERIMENT]
    if any(r.get('callId')==req['callId'] for r in ledger.entries):raise ValueError('Duplicate dispatch forbidden')
    maximum,amount=CAPS[req['method']]
    group=[r for r in rows if all(r.get(k)==req[k] for k in ('caseId','profile','method'))]
    if len(group)+1!=req['step']:raise ValueError('Request sequence violated')
    if sum(r.get('method')==req['method'] for r in rows)>=maximum:raise ValueError('Category cap exceeded')
    if sum((Decimal(r['reservedUsd']) for r in rows),Decimal(0))+amount>RUN_CAP:raise ValueError('Run cap exceeded')
    ledger.ensure_budget(1,amount)
    row={k:req[k] for k in ('callId','caseId','profile','method','step')}
    row.update(validation=EXPERIMENT,reservedUsd=str(amount),model=MODELS[req['method']],status='reserved_before_dispatch')
    ledger.entries.append(row);ledger.save();return row
class Metered(Gateway):
    def __init__(self,settings,client,ledger,req):
        super().__init__(settings,client);self.ledger=ledger;self.req=req;self.entry=None;self.wire=None;self.raw=None
    async def request(self,provider,url,key,payload=None,method='POST'):
        if method=='POST':
            if self.entry is not None:raise ValueError('Second dispatch forbidden')
            if len(json.dumps(payload,ensure_ascii=False).encode())>16000:raise ValueError('Outbound payload exceeds 16000 bytes; no clipping')
            if payload.get('model')!=MODELS[self.req['method']]:raise ValueError('Wrong model')
            if self.req['method']=='respond' and (payload.get('max_completion_tokens')!=2400 or payload.get('temperature')!=.2):raise ValueError('Unbounded generation')
            self.wire=deepcopy(payload);self.entry=reserve(self.ledger,self.req)
        result=await super().request(provider,url,key,payload,method)
        if method=='POST':self.raw=deepcopy(result)
        return result
async def preflight(client):
    settings=helpers.config()
    with Ledger(ROOT/'.data/provider-validation.json',limit=TOTAL_CAP) as ledger:
        prior=history(ledger)
        if any(r.get('validation')==EXPERIMENT for r in ledger.entries):raise ValueError('Already dispatched; no refreeze')
    response=await client.get('https://docs.typesafe.ai/models');response.raise_for_status()
    jev=helpers.jev_pricing(response.text)
    response=await client.get('https://tokenfactory.nebius.com/api/public/models_info');response.raise_for_status()
    row=next(f for m in response.json() for f in m.get('flavors',[]) if f['model_id']==MODELS['respond'])
    pin,pout=[Decimal(str(row[k])) for k in ('input_price_per_million_tokens','output_price_per_million_tokens')]
    bound=(20000*pin+2400*pout)/1000000
    if not pin.is_finite() or not pout.is_finite() or min(pin,pout)<0 or bound>CAPS['respond'][1]:raise ValueError('Price exceeds reservation')
    inventory=await NebiusProvider(Gateway(settings,client)).models(refresh=True)
    if MODELS['respond'] not in inventory:raise ValueError('Ultra unavailable; no substitution')
    return dict(experiment=EXPERIMENT,at=datetime.now(timezone.utc).isoformat(),sourceHashes=hashes(),historicalLedger=prior,
        jev=jev,ultra={'inputUsdPerMillion':str(pin),'outputUsdPerMillion':str(pout),'boundUsd':str(bound),'available':True},
        runCapUsd=str(RUN_CAP),totalCapUsd=str(TOTAL_CAP),maxCalls=114)
def verify(freeze):
    if freeze['experiment']!=EXPERIMENT or freeze['sourceHashes']!=hashes():raise ValueError('Frozen source changed')
    if (datetime.now(timezone.utc)-datetime.fromisoformat(freeze['at'])).total_seconds()>14400:raise ValueError('Pricing preflight expired')
async def dispatch(client,req,freeze):
    item=validate(req);verify(freeze)
    with Ledger(ROOT/'.data/provider-validation.json',limit=TOTAL_CAP) as ledger:
        if history(ledger)!=freeze['historicalLedger']:raise ValueError('Ledger changed since freeze')
        gateway=Metered(helpers.config(),client,ledger,req);start=time.perf_counter();result=deepcopy(req)
        try:
            output=await (JevProvider(gateway).route(item) if req['method']=='route' else NebiusProvider(gateway).respond(item))
            result.update(status='succeeded',output=output.model_dump(exclude_none=True))
        except Exception as e:
            result.update(status='failed_or_unknown_charge' if gateway.entry else 'not_dispatched',error=str(e) if isinstance(e,(ValueError,ServiceError)) else type(e).__name__)
        result.update(elapsedMs=round((time.perf_counter()-start)*1000),wireInput=gateway.wire,rawResponse=gateway.raw,
            usage=(gateway.raw or {}).get('usage',{}),reservedUsd=gateway.entry['reservedUsd'] if gateway.entry else '0',cumulativeReservedUsd=str(ledger.reserved))
        if gateway.entry:gateway.entry.update(status=result['status'],elapsedMs=result['elapsedMs'],usage=result['usage']);ledger.save()
        return result
async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--preflight',action='store_true');parser.add_argument('--freeze');args=parser.parse_args()
    async with httpx.AsyncClient(trust_env=False,timeout=95) as client:
        result=await preflight(client) if args.preflight else await dispatch(client,json.loads(sys.stdin.read(200000)),json.loads(Path(args.freeze).read_text()))
        print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':asyncio.run(main())
