import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Agent,type AgentOptions} from '../src/index.js';
import {rememberEvidence,loadEvidence,noteEvidence} from '../src/evidence.js';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';
import type {AgentReply,BrainPort,ChatMessage,SearchResult,VisionEvidence} from '../../contracts/src/index.js';

// Blocker 7 step 1: web pages and screen readings reach the model once, in the request that fetched them.
// Later requests see receipts, so a few web questions no longer lock the conversation with a 422.
const at='2026-10-19T09:00:00Z';
// Realistic page text: newlines, quotes and non-ASCII characters all grow the backend's JSON measure.
const page=(marker:string)=>`${marker}\n`+'A "quoted" line about naïve café résumés — with détails.\n'.repeat(220);
for(const kind of ['memory','sqlite'] as const) {
  async function rig() {
    const dir=await mkdtemp(join(tmpdir(),'moolai-receipts-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const fixtures=new FixtureProviders();let n=0;
    const frames:{request:number;messages:ChatMessage[]}[]=[];const extracted:string[][]=[];
    let request=0;const script:((messages:ChatMessage[])=>AgentReply)[]=[];
    const options:AgentOptions={brain,id:()=>`${kind}-${++n}`,now:()=>at,
      decisions:{route:async i=>({route:i.activeConversation?'continue_agent':'start_agent',confidence:1}),
        tag:async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1}),connect:async()=>({})},
      // Growing notes on, as in production.
      generation:{summarize:async()=>({title:'Summary',summary:'Summary'}),consolidate:input=>fixtures.consolidate(input),
        respond:async messages=>{frames.push({request,messages:structuredClone(messages)});return script.shift()!(messages);}},
      search:{search:async query=>[0,1,2].map((i):SearchResult=>({url:`https://example.test/${query.replace(/\W+/g,'-')}/${i}`,title:`Result ${i} for ${query}`,content:`SNIPPET_${query}_${i}`})),
        extract:async urls=>{extracted.push(urls);return urls.map(url=>({url,title:'Page',content:page(`PAGE_${url}`)}));}},
      vision:{interpret:async():Promise<VisionEvidence>=>({raw:'',observations:[{field:'Label',status:'readable',value:'A-17',label:'Label',sourceExcerpt:'Label A-17'}],interpretation:'',validated:true,validationErrors:[]})},
      capture:{capture:async()=>({mimeType:'image/png',bytes:new Uint8Array([137,80,78,71])})},
      speech:{speak:async()=>{},stop:async()=>{}}};
    const agent=new Agent(options);await agent.initialize();await agent.startSession();
    return {brain,agent,frames,extracted,script,
      async ask(text:string,...replies:((messages:ChatMessage[])=>AgentReply)[]){request++;script.push(...replies);await agent.submitText(text);await agent.drain();assert.equal(script.length,0,'Every scripted reply was used');},
      async close(){await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}};
  }
  const call=(id:string,name:string,args:Record<string,unknown>)=>():AgentReply=>({text:'',toolCalls:[{id,name,arguments:args}]});
  const answer=(text:string)=>():AgentReply=>({text,toolCalls:[]});

  test(`${kind}: three web research requests, then an unrelated question, stay within the backend limits`,async()=>{
    const t=await rig();try{
      for(const [i,topic] of ['enzymes','ribosomes','plasmids'].entries())
        await t.ask(i?`And what about ${topic}?`:`Moo, research ${topic} on the web.`,
          call(`search-${i}`,'search_web',{query:topic}),call(`extract-${i}`,'extract_web',{urls:[`https://example.test/${topic}/0`]}),answer(`Here is what I found about ${topic}.`));
      await t.ask('Thanks. What is the capital of France?',answer('Paris.'));
      assert.ok(!t.agent.getState().lastError,`No request failed: ${t.agent.getState().lastError}`);
      for(const frame of t.frames) {
        const system=frame.messages[0]!.content,body=JSON.stringify(frame.messages);
        assert.doesNotMatch(system,/PAGE_|SNIPPET_/,'Page text never sits in the system message');
        assert.ok(system.length<100_000,`system message is ${system.length} characters`);
        assert.ok(body.length<180_000,`request is ${body.length} characters`);
        for(const marker of new Set(body.match(/PAGE_https:[^\\"]+/g) ?? []))
          assert.equal(body.split(marker).length-1,1,`${marker} appears once in request ${frame.request}`);
      }
      const last=t.frames.filter(frame=>frame.request===4);
      assert.equal(last.length,1);
      assert.doesNotMatch(JSON.stringify(last[0]!.messages),/PAGE_|SNIPPET_/,'The unrelated question carries no page text');
      assert.match(last[0]!.messages[0]!.content,/example\.test\/plasmids\/0/,'Earlier pages remain as receipts');
    }finally{await t.close();}
  });

  test(`${kind}: a request's own results are not repeated in the index, and a follow-up may open an earlier search result`,async()=>{
    const t=await rig();try{
      await t.ask('Moo, research enzymes on the web.',call('search-a','search_web',{query:'enzymes'}),answer('Found three sources.'));
      const own=t.frames.filter(frame=>frame.request===1).at(-1)!;
      assert.match(JSON.stringify(own.messages),/SNIPPET_enzymes_0/,'The result is in its tool message');
      assert.doesNotMatch(own.messages[0]!.content,/example\.test\/enzymes/,'and not again as a receipt in the same request');
      await t.ask('Open the second result.',call('extract-b','extract_web',{urls:['https://example.test/enzymes/1']}),answer('It explains enzyme kinetics.'));
      assert.deepEqual(t.extracted,[['https://example.test/enzymes/1']],'A URL from the earlier search may be opened');
      const later=t.frames.filter(frame=>frame.request===2)[0]!.messages[0]!.content;
      assert.match(later,/\[2\] Result 1 for enzymes <https:\/\/example\.test\/enzymes\/1>/,'The later request sees numbered results');
      assert.match(later,/open its URL with extract_web/);
      assert.doesNotMatch(later,/callId|requestTurnId/,'Bookkeeping fields are not shown to the model');
    }finally{await t.close();}
  });

  test(`${kind}: an earlier screen reading is a receipt in the next request, never current evidence`,async()=>{
    const t=await rig();try{
      await t.ask('Moo, take a screenshot and read the label.',call('shot','capture_screen',{question:'Read the label.',mode:'ocr'}),answer('I read the label.'));
      assert.match(JSON.stringify(t.frames.filter(frame=>frame.request===1).at(-1)!.messages),/A-17/,'The reading reaches its own request');
      await t.ask('What is on my screen now?',answer('I would need a new screenshot.'));
      const next=t.frames.filter(frame=>frame.request===2)[0]!;
      assert.doesNotMatch(JSON.stringify(next.messages),/A-17/);
      assert.match(next.messages[0]!.content,/Earlier screen reading captured 2026-10-19T09:00:00Z/);
      assert.match(next.messages[0]!.content,/new screen capture needs a new user request/);
      assert.doesNotMatch(next.messages[0]!.content,/"tool":"capture_screen"/,'A receipt is a sentence, not a tool-shaped object');
    }finally{await t.close();}
  });

  test(`${kind}: an old evidence index holding raw pages is reduced to receipts on load`,async()=>{
    const t=await rig();try{
      await t.brain.setState('evidence-index:old',{refs:[],outcomes:[
        {status:'success',tool:'search_web',query:'q',executed:true,previewOnly:false,result:[{url:'https://example.test/a',title:'A'.repeat(400),content:'RAW_SNIPPET'}]},
        {status:'success',tool:'extract_web',executed:true,previewOnly:false,result:[{url:'https://example.test/a',title:'A',content:'RAW_BODY'.repeat(2000)}]}]});
      const loaded=JSON.stringify((await loadEvidence(t.brain,'old')).recentOutcomes);
      assert.doesNotMatch(loaded,/RAW_SNIPPET|RAW_BODY/);
      assert.match(loaded,/example\.test\/a/);
      assert.match(loaded,/16000 characters/);
      assert.doesNotMatch(loaded,/"tool":"(?:search|extract)_web"/,'A receipt is a sentence, not a tool-shaped object');
      assert.ok(!loaded.includes('A'.repeat(121)),'Titles are cut to 120 characters');
    }finally{await t.close();}
  });

  test(`${kind}: a request rebuilt within the same turn keeps its own screen reading; other turns get a receipt`,async()=>{
    const t=await rig();try{
      const event={call:{id:'shot',name:'capture_screen',arguments:{question:'Read the label.'}},status:'success' as const,
        result:{attachmentId:'image-1',observations:[{field:'Label',status:'readable',value:'A-17',label:'Label',sourceExcerpt:'Label A-17'}],validated:true}};
      await rememberEvidence(t.brain,'conversation',event,{requestTurnId:'turn-1',at});
      assert.match(JSON.stringify((await loadEvidence(t.brain,'conversation',undefined,true,['turn-1'])).recentOutcomes),/A-17/);
      const other=JSON.stringify((await loadEvidence(t.brain,'conversation',undefined,true,['turn-2'])).recentOutcomes);
      assert.doesNotMatch(other,/A-17/);
      assert.match(other,/captured 2026-10-19T09:00:00Z/);
      await rememberEvidence(t.brain,'conversation',{call:{id:'web',name:'search_web',arguments:{query:'q'}},status:'success',result:[]},{requestTurnId:'turn-2',at});
      assert.doesNotMatch(JSON.stringify(await t.brain.getState('evidence-index:conversation')),/A-17/,'A later request stores only the receipt');
    }finally{await t.close();}
  });

  test(`${kind}: one read after a five-note search keeps the top hit (ATR-02)`,async()=>{
    const t=await rig();try{
      for(const id of ['best','weak-1','weak-2','weak-3','weak-4']) {
        const created=await t.brain.createRecord({id,kind:'note',createdAt:at});
        await t.brain.updateRecord(id,created.revision,{title:id,body:`${id}: the pressure minimum is 18 kPa.`});
      }
      const records=await Promise.all(['best','weak-1','weak-2','weak-3','weak-4'].map(async id=>(await t.brain.getRecord(id))!));
      await rememberEvidence(t.brain,'conversation',{call:{id:'search',name:'search_notes',arguments:{query:'pressure'}},status:'success',result:records.map(r=>noteEvidence(r,0,2400,'pressure'))});
      await rememberEvidence(t.brain,'conversation',{call:{id:'read',name:'read_note',arguments:{id:'weak-2',offset:10,length:200}},status:'success',result:noteEvidence(records[2]!,10,200)});
      const notes=(await loadEvidence(t.brain,'conversation')).notes.map(note=>note.id);
      assert.ok(notes.includes('best'),`kept ${notes.join(', ')}`);
    }finally{await t.close();}
  });
}
