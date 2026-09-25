"""Meter unchanged production providers; credentials never enter experiment artifacts."""
import argparse, asyncio, hashlib, html, json, re, sys, time
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

EXPERIMENT='contextual_help_20260925_v1'
CAPS={'route':(20,Decimal('.01')),'tag':(0,Decimal('.01')),'connect':(0,Decimal('.01')),
      'summary':(0,Decimal('.01')),'respond':(48,Decimal('.03')),'vision':(5,Decimal('.03'))}
RUN_CAP=Decimal('1.80');TOTAL_CAP=Decimal('35.87');TEXT_BYTES=16000;INPUT_TOKENS=20000
PRIOR_RESERVED=Decimal('24.996')
CASE_FILE=ROOT/'experiments/contextual-help/cases.json'
if '--recheck' in sys.argv:
    sys.argv.remove('--recheck')
    EXPERIMENT='contextual_help_recheck_20260925_v1'
    PRIOR_RESERVED=Decimal('25.746')
    RUN_CAP=Decimal('.67')
    CAPS={**CAPS, 'route':(4,Decimal('.01')), 'respond':(18,Decimal('.03')), 'vision':(3,Decimal('.03'))}
    CASE_FILE=ROOT/'experiments/contextual-help/recheck.json'

if '--final' in sys.argv:
    sys.argv.remove('--final')
    EXPERIMENT='contextual_help_final_20260925_v1'
    PRIOR_RESERVED=Decimal('25.996')
    RUN_CAP=Decimal('.34')
    CAPS={**CAPS, 'route':(4,Decimal('.01')), 'respond':(8,Decimal('.03')), 'vision':(2,Decimal('.03'))}
    CASE_FILE=ROOT/'experiments/contextual-help/final.json'
MODELS={'route':'jev-1.13.0','tag':'jev-1.13.0','connect':'jev-1.13.0',
        'summary':'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B','respond':'nvidia/Nemotron-3-Ultra-550b-a55b','vision':'openbmb/MiniCPM-V-4_5'}
SCHEMAS={'route':RouteInput,'tag':TagInput,'connect':ConnectInput,'summary':RecordInput,'respond':RespondInput,'vision':VisionInput}
OUTPUT={'summary':1200,'respond':2400,'vision':1600}
JEV_INPUT_PRICE=Decimal('.042')

def jev_pricing(document):
    text=' '.join(html.unescape(re.sub(r'<[^>]*>', ' ', document)).split())
    if MODELS['route'] not in text or '$0.042' not in text or 'Output tokens are free' not in text:
        raise ValueError('Jev input/output pricing changed or could not be verified; manual review required')
    bound=JEV_INPUT_PRICE*INPUT_TOKENS/1000000
    if bound>CAPS['route'][1]:raise ValueError('Jev reservation does not cover bounded input')
    return dict(model=MODELS['route'],inputUsdPerMillion=str(JEV_INPUT_PRICE),outputUsdPerMillion='0',
                inputTokenAllowance=INPUT_TOKENS,boundUsd=str(bound),
                source='https://docs.typesafe.ai/models',sourceSha256=hashlib.sha256(document.encode()).hexdigest())

def historical_ledger(ledger):
    entries=[entry for entry in ledger.entries if entry.get('validation')!=EXPERIMENT]
    balance=sum((Decimal(entry['reservedUsd']) for entry in entries),Decimal(0))
    if balance!=PRIOR_RESERVED:
        raise ValueError('Historical reservation balance changed; review before freezing/dispatch')
    return dict(reservedUsd=str(balance),calls=len(entries),sha256=hashlib.sha256(
        json.dumps(entries,sort_keys=True,separators=(',',':')).encode()).hexdigest())

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
    cases=json.loads(CASE_FILE.read_text())
    allowed={c['id'] for group in ('j1','answers','enrichment','ocr') for c in cases[group]}
    if method not in CAPS or case not in allowed or type(step) is not int or not 1<=step<=12:raise ValueError('Undeclared request')
    if req['callId']!=f'{EXPERIMENT}:{case}:{method}:{step}':raise ValueError('Unstable call ID')
    if case.startswith('j') and method!='route':raise ValueError('J1 isolation violated')
    if case.startswith('e') and method not in ('summary','tag','connect'):raise ValueError('Enrichment isolation violated')
    if case.startswith('a') and method!='respond':raise ValueError('Answer isolation violated')
    if case.startswith('o') and method not in ('route','respond','vision'):raise ValueError('OCR isolation violated')
    SCHEMAS[method].model_validate(req['input'])

def reserve(ledger,req):
    validate(req);prior=[r for r in ledger.entries if r.get('validation')==EXPERIMENT]
    if any(r.get('callId')==req['callId'] for r in ledger.entries):raise ValueError('Already reserved; retry forbidden')
    method=req['method'];maximum,amount=CAPS[method]
    if sum(r.get('method')==method for r in prior)>=maximum:raise ValueError('Category cap exceeded')
    group=[r for r in prior if r.get('caseId')==req['caseId'] and r.get('method')==method]
    cases=json.loads(CASE_FILE.read_text())
    case=next(c for group in ('j1','answers','enrichment','ocr') for c in cases[group] if c['id']==req['caseId'])
    maximum_case=(len(case['turns'])*6 if method=='respond' and 'turns' in case else 6 if method=='respond' else len(case['turns']) if method=='route' else 1)
    if len(group)>=maximum_case or req['step']!=len(group)+1:raise ValueError('Per-case bound/sequence violated')
    if sum((Decimal(r['reservedUsd']) for r in prior),Decimal(0))+amount>RUN_CAP:raise ValueError('Run cap exceeded')
    if ledger.reserved+amount>TOTAL_CAP:raise ValueError('Cumulative cap exceeded')
    ledger.ensure_budget(1,amount)
    entry={k:req[k] for k in ('callId','caseId','method','step')}
    entry.update(validation=EXPERIMENT,reservedUsd=str(amount),model=MODELS[method],status='reserved_before_dispatch',at=datetime.now(timezone.utc).isoformat())
    ledger.entries.append(entry);ledger.save();return entry

async def preflight(settings,client):
    with Ledger(ROOT/'.data/provider-validation.json',limit=TOTAL_CAP) as ledger:
        history=historical_ledger(ledger)
        if any(row.get('validation')==EXPERIMENT for row in ledger.entries):
            raise ValueError('This experiment already has reservations; no automatic repeat')
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
    jev=jev_pricing(docs.text)
    if not settings.typesafe_api_key:raise ValueError('Jev configuration not qualified')
    return dict(at=datetime.now(timezone.utc).isoformat(),models=checked,priceSource=source,jev=jev,inferenceCalls=0,runCapUsd=str(RUN_CAP),cumulativeCapUsd=str(TOTAL_CAP),historicalLedger=history)

def verify_freeze(path):
    frozen=json.loads(Path(path).read_text())
    if frozen.get('experiment')!=EXPERIMENT:raise ValueError('Wrong freeze')
    required={'experiments/contextual-help/provider.py','experiments/contextual-help/cases.json','experiments/contextual-help/run.ts','backend/moolai_backend/providers.py','backend/moolai_backend/schemas.py','packages/agent/src/index.ts','experiments/agent-closeout/support.ts'}
    if not required.issubset(frozen['sourceHashes']):raise ValueError('Incomplete freeze')
    for relative,expected in frozen['sourceHashes'].items():
        file=(ROOT/relative).resolve()
        if not file.is_relative_to(ROOT) or hashlib.sha256(file.read_bytes()).hexdigest()!=expected:raise ValueError('Frozen source changed: '+relative)
    age=(datetime.now(timezone.utc)-datetime.fromisoformat(frozen['preflight']['at'])).total_seconds()
    if not 0<=age<14400:raise ValueError('Preflight expired')
    for row in frozen['preflight']['models']:
        method=row['method'];bound=(Decimal(row['inputUsdPerMillion'])*row['inputTokenAllowance']+Decimal(row['outputUsdPerMillion'])*OUTPUT[method])/1000000
        if row['model']!=MODELS[method] or not row['available'] or bound>CAPS[method][1]:raise ValueError('Invalid frozen pricing')
    if {row['method'] for row in frozen['preflight']['models']}!={'summary','respond','vision'}:
        raise ValueError('Incomplete pricing preflight')
    jev=frozen['preflight'].get('jev',{})
    if (jev.get('model')!=MODELS['route'] or jev.get('inputUsdPerMillion')!=str(JEV_INPUT_PRICE)
            or jev.get('outputUsdPerMillion')!='0' or jev.get('inputTokenAllowance')!=INPUT_TOKENS
            or jev.get('boundUsd')!=str(JEV_INPUT_PRICE*INPUT_TOKENS/1000000) or not jev.get('sourceSha256')):
        raise ValueError('Invalid frozen Jev pricing')
    return frozen

class Metered(Gateway):
    def __init__(self,settings,client,ledger,req):
        super().__init__(settings,client);self.ledger=ledger;self.req=req;self.entry=None;self.wire=None;self.raw=None
    async def request(self,provider,url,key,payload=None,method='POST'):
        if method=='POST':
            if self.entry is not None:raise ValueError('Second dispatch forbidden')
            api=self.req['method'];wire=deepcopy(payload)
            if api=='vision':
                for message in wire.get('messages',[]):
                    if isinstance(message.get('content'),list):
                        for part in message['content']:
                            if part.get('type')=='image_url':
                                image_url=part['image_url']['url']
                                if len(image_url.encode())>800000:raise ValueError('Image payload too large; no clipping')
                                part['image_url']['url']='[bounded image bytes]'
            if len(json.dumps(wire,ensure_ascii=False).encode())>TEXT_BYTES:raise ValueError('Outbound text payload too large; no clipping')
            if payload.get('model')!=MODELS[api]:raise ValueError('Wrong model')
            if api in OUTPUT and (payload.get('max_completion_tokens')!=OUTPUT[api] or payload.get('temperature')!=0.2):raise ValueError('Wrong production generation settings')
            self.wire=deepcopy(payload);self.entry=reserve(self.ledger,self.req)
        output=await super().request(provider,url,key,payload,method)
        if method=='POST':self.raw=deepcopy(output)
        return output

async def dispatch(settings,client,req,freeze):
    validate(req);frozen=verify_freeze(freeze)
    result=deepcopy(req)
    with Ledger(ROOT/'.data/provider-validation.json',limit=TOTAL_CAP) as ledger:
        if historical_ledger(ledger)!=frozen['preflight']['historicalLedger']:
            raise ValueError('Historical ledger changed after freeze')
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
