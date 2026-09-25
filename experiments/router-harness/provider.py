"""One metered request at a time for the isolated router/harness experiment."""
import argparse, asyncio, hashlib, importlib, json, sys, time
from copy import deepcopy
from dataclasses import replace
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path
ROOT=Path(__file__).resolve().parents[2]
sys.path[:0]=[str(ROOT/'backend'),str(ROOT/'scripts')]
from dotenv import dotenv_values
import httpx
from moolai_backend.providers import Gateway, JevProvider, NebiusProvider, ServiceError
from moolai_backend.schemas import RespondInput, RouteInput
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger

EXPERIMENT='router_harness_20260924_v1'
MODELS={'super':'nvidia/nemotron-3-super-120b-a12b','lightning':'nvidia/Nemotron-3_5-Lightning','glm':'zai-org/GLM-5.3'}
RATES={'super':Decimal('.01'),'lightning':Decimal('.003'),'glm':Decimal('.04'),'jev':Decimal('.01')}
RUN_CAP=Decimal('5.97');CUMULATIVE_CAP=Decimal('25.87')
INPUT_BOUND=15000;OUTPUT_BOUND=4000;WIRE_BOUND=12000
POLICY=Path(__file__).with_name('router-policy.json')
PRICE_SOURCE='https://tokenfactory.nebius.com/api/public/models_info'

def settings():
    env=dotenv_values(ROOT/'backend/.env')
    return Settings(nebius_api_key=env.get('NEBIUS_API_KEY') or '',typesafe_api_key=env.get('TYPESAFE_API_KEY') or '',
        nebius_base_url=env.get('NEBIUS_BASE_URL') or Settings.nebius_base_url)

def validate(request):
    if set(request)!={'callId','phase','caseId','profile','modelProfile','step','input'}:raise ValueError('Unexpected request fields')
    phase,case,profile,model,step=(request[k] for k in ('phase','caseId','profile','modelProfile','step'))
    if type(step) is not int or not 1<=step<=6:raise ValueError('Invalid step')
    if phase=='harness':
        if profile not in ('native','nanobot','codex') or model!='super' or case not in {f'c{i:02}' for i in range(1,9)}:raise ValueError('Undeclared harness cell')
    elif phase=='fixed':
        if profile!='native' or model not in ('lightning','glm') or case not in {f'c{i:02}' for i in range(1,9)}:raise ValueError('Undeclared fixed-model cell')
    elif phase=='routed':
        if profile!='native' or model not in MODELS or case not in {f'c{i:02}' for i in range(1,9)}:raise ValueError('Undeclared routed cell')
    elif phase=='compatibility':
        if case!='compatibility' or step>2 or (profile,model) not in {('native','super'),('nanobot','super'),('codex','super'),('native','lightning'),('native','glm')}:raise ValueError('Undeclared compatibility cell')
    elif phase in ('complexity','j1'):
        ids={f'r{i:02}' for i in range(1,13)}|{f'c{i:02}' for i in range(1,9)} if phase=='complexity' else {f'j{i:02}' for i in range(1,21)}
        if profile!='jev' or model!='jev' or step!=1 or case not in ids:raise ValueError('Undeclared decision cell')
    else:raise ValueError('Unknown phase')
    if request['callId']!=f'{EXPERIMENT}:{phase}:{case}:{profile}:{model}:{step}':raise ValueError('Invalid operation ID')
    if phase=='j1':RouteInput.model_validate(request['input'])
    elif phase=='complexity':
        if set(request['input'])!={'request','context','tools','notesOnly'}:raise ValueError('Unexpected router state')
    else:RespondInput.model_validate(request['input'])

def reserve(ledger,request):
    validate(request)
    previous=[e for e in ledger.entries if e.get('validation')==EXPERIMENT]
    if any(e.get('callId')==request['callId'] for e in ledger.entries):raise ValueError('Already reserved; no retry')
    # Group routed requests independently of the selected model, preventing model-switch budget evasion.
    group=[e for e in previous if all(e.get(k)==request[k] for k in ('phase','caseId','profile')) and
           (request['phase']=='routed' or e.get('modelProfile')==request['modelProfile'])]
    maximum=1 if request['phase'] in ('j1','complexity') else 2 if request['phase']=='compatibility' else 6
    if len(group)>=maximum or request['step']!=len(group)+1:raise ValueError('Case call limit or sequence violated')
    amount=RATES[request['modelProfile']]
    if sum((Decimal(e['reservedUsd']) for e in previous),Decimal(0))+amount>RUN_CAP:raise ValueError('Experiment budget exhausted')
    if ledger.reserved+amount>CUMULATIVE_CAP:raise ValueError('Cumulative budget exhausted')
    ledger.ensure_budget(1,amount)
    entry={k:request[k] for k in ('callId','phase','caseId','profile','modelProfile','step')}
    entry.update(validation=EXPERIMENT,provider='TypeSafe' if request['modelProfile']=='jev' else 'Nebius',
                 model=Settings.jev_model if request['modelProfile']=='jev' else MODELS[request['modelProfile']],
                 reservedUsd=str(amount),status='reserved_before_dispatch',at=datetime.now(timezone.utc).isoformat())
    ledger.entries.append(entry);ledger.save();return entry

async def preflight(config,client):
    inventory=await NebiusProvider(Gateway(config,client)).models(refresh=True)
    response=await client.get(PRICE_SOURCE);response.raise_for_status()
    rows={f['model_id']:f for m in response.json() for f in m.get('flavors',[])}
    result=[]
    for profile,model in MODELS.items():
        row=rows.get(model,{})
        pin=Decimal(str(row.get('input_price_per_million_tokens','NaN')));pout=Decimal(str(row.get('output_price_per_million_tokens','NaN')))
        valid=pin.is_finite() and pout.is_finite() and pin>=0 and pout>=0
        bound=(pin*INPUT_BOUND+pout*OUTPUT_BOUND)/1000000 if valid else None
        result.append({'profile':profile,'model':model,'available':model in inventory,'inputUsdPerMillion':str(pin),
                       'outputUsdPerMillion':str(pout),'boundUsd':str(bound),'priceWithinReservation':valid and bound<=RATES[profile]})
    return {'at':datetime.now(timezone.utc).isoformat(),'models':result,'jevConfigured':bool(config.typesafe_api_key),
            'jevPriceUsdPerMillionInput':'0.042','jevPriceSource':'https://typesafe.ai/',
            'priceSource':PRICE_SOURCE,'inferenceCalls':0,'runCapUsd':str(RUN_CAP),'cumulativeCapUsd':str(CUMULATIVE_CAP)}

def verify_freeze(path,request):
    frozen=json.loads(Path(path).read_text())
    if frozen.get('experiment')!=EXPERIMENT:raise ValueError('Wrong experiment freeze')
    required={'experiments/router-harness/provider.py','experiments/router-harness/router-policy.json',
              'backend/moolai_backend/providers.py','backend/moolai_backend/validate_live.py','backend/moolai_backend/schemas.py'}
    if not required.issubset(frozen.get('sourceHashes',{})):raise ValueError('Incomplete freeze')
    for relative,expected in frozen['sourceHashes'].items():
        p=(ROOT/relative).resolve()
        if not p.is_relative_to(ROOT) or hashlib.sha256(p.read_bytes()).hexdigest()!=expected:raise ValueError('Frozen source changed: '+relative)
    info=frozen['preflight'];age=(datetime.now(timezone.utc)-datetime.fromisoformat(info['at'])).total_seconds()
    if not 0<=age<=7200:raise ValueError('Preflight expired; no dispatch')
    profile=request['modelProfile']
    if profile!='jev':
        row=next((r for r in info['models'] if r['profile']==profile),None)
        if not row or row['model']!=MODELS[profile] or row['available'] is not True or row['priceWithinReservation'] is not True:raise ValueError('Exact model not qualified')
        bound=(Decimal(row['inputUsdPerMillion'])*INPUT_BOUND+Decimal(row['outputUsdPerMillion'])*OUTPUT_BOUND)/1000000
        if not bound.is_finite() or bound>RATES[profile]:raise ValueError('Frozen price bound invalid')
    elif not info['jevConfigured'] or Decimal(info['jevPriceUsdPerMillionInput'])*INPUT_BOUND/1000000>RATES['jev']:
        raise ValueError('Jev preflight invalid')

class MeteredGateway(Gateway):
    def __init__(self,config,client,ledger,request):
        super().__init__(config,client);self.ledger=ledger;self.info=request;self.entry=None;self.wire=None;self.raw=None
    async def request(self,provider,url,key,payload=None,method='POST'):
        if method=='POST':
            if self.entry is not None:raise ValueError('Second dispatch forbidden')
            if len(json.dumps(payload,ensure_ascii=False).encode())>WIRE_BOUND:raise ValueError('Complete outbound payload exceeds 12000 bytes')
            if self.info['modelProfile']!='jev':
                expected={'model':MODELS[self.info['modelProfile']],'max_completion_tokens':OUTPUT_BOUND,'temperature':0.2,'stream':False,'store':False}
                if any(payload.get(k)!=v for k,v in expected.items()):raise ValueError('Unexpected model settings')
                if set(payload)-set(expected)-{'messages','tools','tool_choice'}:raise ValueError('Unexpected wire options')
                if self.info['input'].get('responseMode')=='answer_only' and (payload.get('tools') or payload.get('tool_choice')!='none'):raise ValueError('Tools in answer-only response')
            elif payload.get('model')!=Settings.jev_model:raise ValueError('Wrong decision model')
            self.wire=deepcopy(payload);self.entry=reserve(self.ledger,self.info)
        result=await super().request(provider,url,key,payload,method)
        if method=='POST':self.raw=deepcopy(result)
        return result
class AgentProvider(NebiusProvider):
    async def completion(self,model,messages,max_completion_tokens,**parameters):
        return await super().completion(model,messages,OUTPUT_BOUND,**parameters)

async def dispatch(config,client,request,freeze):
    validate(request);verify_freeze(freeze,request)
    config=replace(config,agent_model=MODELS.get(request['modelProfile'],MODELS['super']))
    result={k:request[k] for k in ('callId','phase','caseId','profile','modelProfile','step')}
    result['input']=deepcopy(request['input'])
    with Ledger(ROOT/'.data/provider-validation.json',limit=CUMULATIVE_CAP) as ledger:
        gateway=MeteredGateway(config,client,ledger,request);started=time.perf_counter()
        try:
            if request['phase']=='j1':output=(await JevProvider(gateway).route(RouteInput.model_validate(request['input']))).model_dump(exclude_none=True)
            elif request['phase']=='complexity':
                policy=json.loads(POLICY.read_text())
                output=await JevProvider(gateway).evaluate(request['input'],{'complexity':{'type':'choice','criteria':policy['criteria']}})
            else:output=(await AgentProvider(gateway).respond(RespondInput.model_validate(request['input']))).model_dump(exclude_none=True)
            result.update(status='succeeded',output=output)
        except Exception as error:
            result.update(status='failed_or_unknown_charge' if gateway.entry else 'not_dispatched',
                          error=str(error) if isinstance(error,(ServiceError,ValueError)) else type(error).__name__)
        result.update(elapsedMs=round((time.perf_counter()-started)*1000),wireInput=gateway.wire,rawResponse=gateway.raw,
                      reservedUsd=gateway.entry['reservedUsd'] if gateway.entry else '0',usage=(gateway.raw or {}).get('usage',{}),cumulativeReservedUsd=str(ledger.reserved))
        if gateway.entry:
            gateway.entry.update(status=result['status'],usage=result['usage'],elapsedMs=result['elapsedMs']);ledger.save()
    return result
async def main():
    p=argparse.ArgumentParser();p.add_argument('--preflight',action='store_true');p.add_argument('--freeze');a=p.parse_args()
    async with httpx.AsyncClient(trust_env=False,timeout=95) as client:
        if a.preflight:result=await preflight(settings(),client)
        else:
            if not a.freeze:raise ValueError('A frozen manifest is required')
            raw=sys.stdin.read(100001)
            if len(raw.encode())>100000:raise ValueError('Oversized bridge input')
            result=await dispatch(settings(),client,json.loads(raw),a.freeze)
        print(json.dumps(result,ensure_ascii=False))
if __name__=='__main__':asyncio.run(main())
