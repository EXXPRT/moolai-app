"""Meter unchanged production providers; credentials never enter experiment artifacts."""
import argparse, asyncio, hashlib, json, sys, time
from copy import deepcopy
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
import httpx
from dotenv import dotenv_values
from moolai_backend.providers import Gateway,JevProvider,NebiusProvider,ServiceError
from moolai_backend.schemas import RouteInput,TagInput,ConnectInput,RecordInput,RespondInput,VisionInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

EXPERIMENT='agent_closeout_20260924_v1'
CAPS={'route':(75,Decimal('.01')),'tag':(20,Decimal('.01')),'connect':(20,Decimal('.01')),
      'summary':(20,Decimal('.03')),'respond':(100,Decimal('.05')),'vision':(10,Decimal('.05'))}
RUN_CAP=Decimal('10');TOTAL_CAP=Decimal('35.87');TEXT_BYTES=40000;INPUT_TOKENS=50000
MODELS={'route':'jev-1.13.0','tag':'jev-1.13.0','connect':'jev-1.13.0',
        'summary':'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B','respond':'nvidia/nemotron-3-super-120b-a12b','vision':'openbmb/MiniCPM-V-4_5'}
SCHEMAS={'route':RouteInput,'tag':TagInput,'connect':ConnectInput,'summary':RecordInput,'respond':RespondInput,'vision':VisionInput}
OUTPUT={'summary':1200,'respond':2400,'vision':1600}

def config():
    env=dotenv_values(ROOT/'backend/.env')
    result=Settings(typesafe_api_key=env.get('TYPESAFE_API_KEY') or '',nebius_api_key=env.get('NEBIUS_API_KEY') or '',
        nebius_base_url=env.get('NEBIUS_BASE_URL') or Settings.nebius_base_url,
        jev_model=env.get('JEV_MODEL') or Settings.jev_model,summary_model=env.get('NEBIUS_SUMMARY_MODEL') or Settings.summary_model,
        agent_model=env.get('NEBIUS_AGENT_MODEL') or Settings.agent_model,vision_model=env.get('NEBIUS_VISION_MODEL') or Settings.vision_model)
    if (result.jev_model,result.summary_model,result.agent_model,result.vision_model)!=(MODELS['route'],MODELS['summary'],MODELS['respond'],MODELS['vision']):
        raise ValueError('Configured production profile differs; no silent substitution')
    return result

def validate(req):
    if set(req)!={'callId','caseId','method','step','input'}:raise ValueError('Unexpected request fields')
    method=req['method'];case=req['caseId'];step=req['step']
    cases=json.loads((ROOT/'experiments/agent-closeout/cases.json').read_text())
    allowed={c['id'] for group in ('j1','answers','enrichment') for c in cases[group]}|{f'o{i:02}' for i in range(1,7)}
    if method not in CAPS or case not in allowed or type(step) is not int or not 1<=step<=12:raise ValueError('Undeclared request')
    if req['callId']!=f'{EXPERIMENT}:{case}:{method}:{step}':raise ValueError('Unstable call ID')
    if case.startswith('j') and method!='route':raise ValueError('J1 isolation violated')
    if case.startswith('e') and method not in ('summary','tag','connect'):raise ValueError('Enrichment isolation violated')
    if case.startswith('a') and method!='respond':raise ValueError('Answer isolation violated')
    if case.startswith('o') and method not in ('respond','vision'):raise ValueError('OCR isolation violated')
    SCHEMAS[method].model_validate(req['input'])

def reserve(ledger,req):
    validate(req);prior=[r for r in ledger.entries if r.get('validation')==EXPERIMENT]
    if any(r.get('callId')==req['callId'] for r in ledger.entries):raise ValueError('Already reserved; retry forbidden')
    method=req['method'];maximum,amount=CAPS[method]
    if sum(r.get('method')==method for r in prior)>=maximum:raise ValueError('Category cap exceeded')
    group=[r for r in prior if r.get('caseId')==req['caseId'] and r.get('method')==method]
    maximum_case=12 if method in ('respond','route') else 1
    if len(group)>=maximum_case or req['step']!=len(group)+1:raise ValueError('Per-case bound/sequence violated')
    if sum((Decimal(r['reservedUsd']) for r in prior),Decimal(0))+amount>RUN_CAP:raise ValueError('Run cap exceeded')
    if ledger.reserved+amount>TOTAL_CAP:raise ValueError('Cumulative cap exceeded')
    ledger.ensure_budget(1,amount)
    entry={k:req[k] for k in ('callId','caseId','method','step')}
    entry.update(validation=EXPERIMENT,reservedUsd=str(amount),model=MODELS[method],status='reserved_before_dispatch',at=datetime.now(timezone.utc).isoformat())
    ledger.entries.append(entry);ledger.save();return entry

async def preflight(settings,client):
    inventory=await NebiusProvider(Gateway(settings,client)).models(refresh=True)
    source='https://tokenfactory.nebius.com/api/public/models_info'
    response=await client.get(source);response.raise_for_status()
    rows={f['model_id']:f for m in response.json() for f in m.get('flavors',[])}
    checked=[]
    for method in ('summary','respond','vision'):
        model=MODELS[method];row=rows[model]
        pin,pout=[Decimal(str(row[k])) for k in ('input_price_per_million_tokens','output_price_per_million_tokens')]
        allowance=row['max_model_len'] if method=='vision' else INPUT_TOKENS
        bound=(pin*allowance+pout*OUTPUT[method])/1000000
        if not pin.is_finite() or not pout.is_finite() or min(pin,pout)<0 or bound>CAPS[method][1] or model not in inventory:raise ValueError('Model or price not qualified: '+model)
        checked.append(dict(method=method,model=model,available=True,inputUsdPerMillion=str(pin),outputUsdPerMillion=str(pout),inputTokenAllowance=allowance,outputCap=OUTPUT[method],boundUsd=str(bound)))
    docs=await client.get('https://docs.typesafe.ai/models');docs.raise_for_status()
    if '0.042' not in docs.text or not settings.typesafe_api_key:raise ValueError('Jev pricing/configuration not qualified')
    return dict(at=datetime.now(timezone.utc).isoformat(),models=checked,priceSource=source,jevInputUsdPerMillion='0.042',jevPriceSource='https://docs.typesafe.ai/models',inferenceCalls=0,runCapUsd=str(RUN_CAP),cumulativeCapUsd=str(TOTAL_CAP))

def verify_freeze(path):
    frozen=json.loads(Path(path).read_text())
    if frozen.get('experiment')!=EXPERIMENT:raise ValueError('Wrong freeze')
    required={'experiments/agent-closeout/provider.py','experiments/agent-closeout/cases.json','experiments/agent-closeout/run.ts','backend/moolai_backend/providers.py'}
    if not required.issubset(frozen['sourceHashes']):raise ValueError('Incomplete freeze')
    for relative,expected in frozen['sourceHashes'].items():
        file=(ROOT/relative).resolve()
        if not file.is_relative_to(ROOT) or hashlib.sha256(file.read_bytes()).hexdigest()!=expected:raise ValueError('Frozen source changed: '+relative)
    age=(datetime.now(timezone.utc)-datetime.fromisoformat(frozen['preflight']['at'])).total_seconds()
    if not 0<=age<14400:raise ValueError('Preflight expired')
    for row in frozen['preflight']['models']:
        method=row['method'];bound=(Decimal(row['inputUsdPerMillion'])*row['inputTokenAllowance']+Decimal(row['outputUsdPerMillion'])*OUTPUT[method])/1000000
        if row['model']!=MODELS[method] or not row['available'] or bound>CAPS[method][1]:raise ValueError('Invalid frozen pricing')

class Metered(Gateway):
    def __init__(self,settings,client,ledger,req):
        super().__init__(settings,client);self.ledger=ledger;self.req=req;self.entry=None;self.wire=None;self.raw=None
    async def request(self,provider,url,key,payload=None,method='POST'):
        if method=='POST':
            if self.entry is not None:raise ValueError('Second dispatch forbidden')
            api=self.req['method'];bound=800000 if api=='vision' else TEXT_BYTES
            if len(json.dumps(payload,ensure_ascii=False).encode())>bound:raise ValueError('Outbound payload too large; no clipping')
            if payload.get('model')!=MODELS[api]:raise ValueError('Wrong model')
            if api in OUTPUT and (payload.get('max_completion_tokens')!=OUTPUT[api] or payload.get('temperature')!=0.2):raise ValueError('Wrong production generation settings')
            self.wire=deepcopy(payload);self.entry=reserve(self.ledger,self.req)
        output=await super().request(provider,url,key,payload,method)
        if method=='POST':self.raw=deepcopy(output)
        return output

async def dispatch(settings,client,req,freeze):
    validate(req);verify_freeze(freeze)
    result=deepcopy(req)
    with Ledger(ROOT/'.data/provider-validation.json',limit=TOTAL_CAP) as ledger:
        g=Metered(settings,client,ledger,req);started=time.perf_counter()
        try:
            method=req['method'];item=SCHEMAS[method].model_validate(req['input']);jev=JevProvider(g);nebius=NebiusProvider(g)
            if method=='route':output=await jev.route(item)
            elif method=='tag':output=await jev.tag(item)
            elif method=='connect':output=await jev.connect(item)
            elif method=='summary':output=await nebius.summarize(item.record)
            elif method=='respond':output=await nebius.respond(item)
            else:output=await nebius.vision(item)
            result.update(status='succeeded',output=output.model_dump(exclude_none=True) if hasattr(output,'model_dump') else output)
        except Exception as error:
            result.update(status='failed_or_unknown_charge' if g.entry else 'not_dispatched',error=str(error) if isinstance(error,(ValueError,ServiceError)) else type(error).__name__)
        result.update(elapsedMs=round((time.perf_counter()-started)*1000),wireInput=g.wire,rawResponse=g.raw,usage=(g.raw or {}).get('usage',{}),reservedUsd=g.entry['reservedUsd'] if g.entry else '0',cumulativeReservedUsd=str(ledger.reserved))
        if g.entry:g.entry.update(status=result['status'],elapsedMs=result['elapsedMs'],usage=result['usage']);ledger.save()
    return result

async def main():
    parser=argparse.ArgumentParser();parser.add_argument('--preflight',action='store_true');parser.add_argument('--freeze');args=parser.parse_args()
    async with httpx.AsyncClient(trust_env=False,timeout=95) as client:
        if args.preflight:result=await preflight(config(),client)
        else:
            if not args.freeze:raise ValueError('Frozen manifest required')
            text=sys.stdin.read(1200001)
            if len(text.encode())>1200000:raise ValueError('Oversized bridge input')
            result=await dispatch(config(),client,json.loads(text),args.freeze)
        print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':asyncio.run(main())
