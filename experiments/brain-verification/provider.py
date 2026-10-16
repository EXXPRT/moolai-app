"""Metered JSON-line bridge for the frozen synthetic verification (no retries)."""
import asyncio,base64,hashlib,html,json,re,sys,time
from dataclasses import replace
from decimal import Decimal
from pathlib import Path
import httpx
from dotenv import load_dotenv
ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'backend'))
from moolai_backend import providers as p,schemas as s
from moolai_backend.settings import Settings
from moolai_backend.validate_live import Ledger,safe_usage
OUT=ROOT/'.data/validation/growing-graph-20261008'
RUN='growing-graph-20261008'
CEILING=Decimal('35.87');CAP=Decimal('4.50')
LIMITS={'ultra':(84,Decimal('.04'),2400,24000),'vision':(8,Decimal('.03'),1600,800000),
        'lightning':(60,Decimal('.01'),4096,32000),'jev':(60,Decimal('.005'),0,80000)}
load_dotenv(ROOT/'backend/.env',override=False)
SETTINGS=Settings.from_env()
MODELS={'ultra':'nvidia/Nemotron-3-Ultra-550b-a55b','lightning':'nvidia/Nemotron-3_5-Lightning','vision':'openbmb/MiniCPM-V-4_5','jev':'jev-1.13.0'}
MODE=sys.argv[1]
def digest(b):return hashlib.sha256(b).hexdigest()
def save(path,v):path.write_text(json.dumps(v,ensure_ascii=False,indent=2)+'\n');path.chmod(0o600)
def verify():
 f=json.loads((OUT/'freeze.json').read_text())
 for file,sha in f['files'].items():assert digest((ROOT/file).read_bytes())==sha,'Frozen code changed: '+file
 return f
async def preflight():
 async with httpx.AsyncClient(trust_env=False,timeout=30) as c:
  inventory=await p.NebiusProvider(p.Gateway(SETTINGS,c)).models(refresh=True)
  response=await c.get('https://tokenfactory.nebius.com/api/public/models_info');response.raise_for_status()
  rows={f['model_id']:f for m in response.json() for f in m.get('flavors',[])}
  qualified={}
  for group,tokens in [('ultra',30000),('lightning',50000),('vision',32768)]:
   m=MODELS[group];r=rows[m];assert m in inventory
   pin,pout=Decimal(str(r['input_price_per_million_tokens'])),Decimal(str(r['output_price_per_million_tokens']))
   bound=(pin*tokens+pout*LIMITS[group][2])/1000000
   assert bound<=LIMITS[group][1] and pin>=0 and pout>=0
   if group=='vision':assert r['max_model_len']<=32768
   qualified[group]={'model':m,'input':str(pin),'output':str(pout),'inputAllowance':tokens,'outputCap':LIMITS[group][2],'bound':str(bound)}
  docs=await c.get('https://docs.typesafe.ai/models');docs.raise_for_status()
  text=' '.join(html.unescape(re.sub(r'<[^>]*>',' ',docs.text)).split())
  assert MODELS['jev'] in text and '$0.042' in text and 'Output tokens are free' in text and SETTINGS.typesafe_api_key
  qualified['jev']={'model':MODELS['jev'],'input':'.042','output':'0','inputAllowance':100000,'bound':'.0042'}
 with Ledger(ROOT/'.data/provider-validation.json',limit=CEILING) as ledger:
  history=sum((Decimal(e['reservedUsd']) for e in ledger.entries if e.get('validation')!=RUN),Decimal(0))
  assert history==Decimal('28.226'),'Historical balance changed'
  assert history+CAP<=CEILING
 save(OUT/'qualified.json',{'models':qualified,'runCap':str(CAP),'ceiling':str(CEILING),'historical':str(history),'inferenceCalls':0})
 return qualified

async def main():
 if MODE=='preflight':print(json.dumps(await preflight()));return
 assert MODE=='paid';verify();qualified=json.loads((OUT/'qualified.json').read_text())['models']
 async with httpx.AsyncClient(trust_env=False,timeout=180) as client:
  print(json.dumps({'ready':True}),flush=True)
  for line in sys.stdin:
   row=json.loads(line);verify();method=row['method'];ident=row['id'];group='ultra' if method=='respond' else 'vision' if method=='vision' else 'jev' if method in ['tag','connect'] else 'lightning'
   assert method in ['respond','vision','tag','connect','plan','summary','consolidate']
   assert re.fullmatch(r'[a-zA-Z0-9._-]+',ident)
   raw=None;payload=None;entry=None;started=time.perf_counter()
   try:
    settings=replace(SETTINGS,agent_model=MODELS['ultra'],agent_max_tokens=2400,summary_model=MODELS['lightning'],vision_model=MODELS['vision'],jev_model=MODELS['jev'],thought_organization_format='units')
    class Meter(p.Gateway):
     async def request(self,provider,url,key,body=None,method='POST'):
      nonlocal raw,payload,entry
      if method=='GET':return {'data':[{'id':m} for m in MODELS.values()]}
      payload=body;wire=httpx.Request('POST',url,json=body).content
      maximum,amount,output,byte_limit=LIMITS[group]
      assert len(wire)<=byte_limit,'Complete request exceeds frozen byte limit'
      assert body['model']==MODELS[group]
      if group!='jev':
       assert body['temperature']==.2 and body['max_completion_tokens']<=output
       if row['method']=='summary':assert body.get('chat_template_kwargs')=={'enable_thinking':False}
       else:assert 'chat_template_kwargs' not in body and 'reasoning_effort' not in body
      if group=='ultra':
       assert row['area'] in ['graph','narration','handoff']
       per_case=6 if row['area']=='graph' else 1
      with Ledger(ROOT/'.data/provider-validation.json',limit=CEILING) as ledger:
       entries=[e for e in ledger.entries if e.get('validation')==RUN]
       assert not any(e.get('callId')==ident for e in entries),'Repeated dispatch blocked'
       assert sum(e.get('group')==group for e in entries)<maximum
       assert sum((Decimal(e['reservedUsd']) for e in entries),Decimal(0))+amount<=CAP
       if group=='ultra':assert sum(e.get('workflow')==row['workflow'] for e in entries)<per_case
       entry=ledger.reserve(provider,amount);entry.update(validation=RUN,callId=ident,group=group,workflow=row['workflow'],area=row['area'],model=body['model'],wireBytes=len(wire),payloadSha256=digest(wire));ledger.save()
      raw=await super().request(provider,url,key,body,method)
      return raw
    class Provider(p.NebiusProvider):
     async def completion(self,model,messages,max_completion_tokens,**parameters):
      parameters['max_request_bytes']=LIMITS[group][3]
      return await super().completion(model,messages,max_completion_tokens,**parameters)
    gateway=Meter(settings,client);provider=Provider(gateway);jev=p.JevProvider(gateway);v=row['input']
    if method=='respond':result=await provider.respond(s.RespondInput.model_validate(v))
    elif method=='vision':result=await provider.vision(s.VisionInput.model_validate(v))
    elif method=='plan':result=await provider.plan_thoughts(s.ThoughtInput.model_validate(v))
    elif method=='consolidate':result=await provider.consolidate(s.ThoughtInput.model_validate(v))
    elif method=='summary':result=await provider.summarize(s.BrainRecord.model_validate(v))
    elif method=='tag':result=await jev.tag(s.TagInput.model_validate(v))
    else:result=await jev.connect(s.ConnectInput.model_validate(v))
    result=result.model_dump(exclude_none=True) if hasattr(result,'model_dump') else result
    reply={'id':ident,'result':result,'ok':True}
   except Exception as e:reply={'id':ident,'ok':False,'error':type(e).__name__+': '+str(e)}
   reply.update(seconds=round(time.perf_counter()-started,4),raw=raw,usage=safe_usage(raw or {}),payload=payload,request=row)
   if entry:
    with Ledger(ROOT/'.data/provider-validation.json',limit=CEILING) as ledger:
     saved=next(e for e in ledger.entries if e.get('validation')==RUN and e.get('callId')==ident)
     saved.update(status='succeeded' if reply['ok'] else 'failed_or_unknown_charge',seconds=reply['seconds'],usage=reply['usage']);ledger.save()
     reply['reserved']=str(ledger.reserved)
   save(OUT/'calls'/(ident+'.json'),reply)
   print(json.dumps({k:v for k,v in reply.items() if k not in ['raw','payload','request']}),flush=True)
if __name__=='__main__':asyncio.run(main())
