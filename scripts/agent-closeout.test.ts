import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../packages/brain/src/index.js';
import {Agent} from '../packages/agent/src/index.js';
import {transcriptText,type AgentReply,type BrainPort} from '../packages/contracts/src/index.js';
import {rig,note,segment,snapshot} from '../experiments/agent-closeout/support.js';
import {readFile} from 'node:fs/promises';

const deferred=<T>()=>{let resolve!:(v:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const tool=(id:string,name:string,args:Record<string,unknown>):AgentReply=>({text:'',toolCalls:[{id,name,arguments:args}]});
for(const adapter of ['memory','sqlite'] as const){
  function run(name:string,action:(f:ReturnType<typeof rig>,brain:BrainPort)=>Promise<void>,todo?:string){
    test(`${adapter}: closeout ${name}`,{timeout:6000,...(todo?{todo}:{})},async()=>{
      const directory=await mkdtemp(join(tmpdir(),'moolai-closeout-'));
      let brain:BrainPort=adapter==='memory'?new MemoryBrain():new SQLiteBrain(directory);const f=rig(brain,adapter);
      try{await f.agent.initialize();await action(f,brain);await f.agent.drain();
        if(adapter==='sqlite'){const records=await brain.listRecords(),ops=await brain.listOperations(),state=await brain.getState('agent');await brain.close();brain=new SQLiteBrain(directory);
          assert.deepEqual(await brain.listRecords(),records);assert.deepEqual(await brain.listOperations(),ops);assert.deepEqual(await brain.getState('agent'),state);}
      }finally{await brain.close();await rm(directory,{recursive:true,force:true});}
    });
  }
  run('three separately received blocks form one request with all constraints',async({agent,observed})=>{
    await agent.ingest(segment('one','Moo, compare these methods.','speech'));
    await agent.ingest(segment('two','Use only my notes.','speech'));
    await agent.ingest(segment('three','Keep it to two sentences.','speech'));
    assert.equal(observed.routes.length,0);assert.equal(observed.generations.length,0);
    await agent.settleTurn('speech');await agent.drain();
    assert.equal(observed.routes.length,1);assert.equal(observed.generations.length,1);
    assert.equal(observed.routes[0].input.text,'Moo, compare these methods. Use only my notes. Keep it to two sentences.');
    assert.equal(agent.getState().webAllowed,false);
    assert.ok(!observed.generations[0].tools.some((t:any)=>t.name==='search_web'));
    for(const text of ['compare these methods','only my notes','two sentences'])assert.ok(observed.generations[0].messages.some((m:any)=>m.content.includes(text)));
  });
  run('late start classification cannot act on a corrected dictation',async({agent,hooks,observed},brain)=>{
    const entered=deferred<void>(),pending=deferred<any>();let n=0;
    hooks.decisions.route=async()=>{if(++n===1){entered.resolve();return pending.promise;}return {route:'dictate',confidence:1};};
    await agent.ingest(segment('correction','Moo, explain the pressure.','turn',1));const task=agent.settleTurn('turn');await entered.promise;
    await agent.ingest(segment('correction','I was dictating the words: explain the pressure.','turn',2));pending.resolve({route:'start_agent',confidence:1});
    await task;await agent.drain();assert.equal(observed.generations.length,0);assert.equal(agent.getState().conversationId,undefined);
    assert.ok((await brain.listRecords()).some(r=>r.kind==='dictation'&&transcriptText(r).includes('I was dictating')));
  });
  for(const choice of ['finish','cancel','continue'] as const)run(`pending work ${choice} respects the user's choice`,async({agent,hooks},brain)=>{
    const entered=deferred<void>(),response=deferred<AgentReply>();hooks.generation.respond=async()=>{entered.resolve();return response.promise;};
    await agent.submitText('Moo, use only my notes and explain the procedure.');await entered.promise;
    await agent.requestEnd();assert.equal(agent.getState().pendingOffer?.kind,'end_work');
    await agent.resolveEnd(choice);response.resolve({text:'The supported procedure answer.',toolCalls:[]});await agent.drain();
    assert.equal(!!agent.getState().conversationId,choice==='continue');
    const text=(await brain.listRecords()).filter(r=>r.kind==='conversation').map(transcriptText).join('\n');
    assert.equal(text.includes('The supported procedure answer.'),choice!=='cancel');
    assert.ok(text.includes('explain the procedure'));
  });
  run('notes-only blocks a provider-proposed web call and preserves its error',async(f,brain)=>{
    let n=0;f.hooks.generation.respond=async()=>++n===1?tool('forbidden','search_web',{query:'pressure trial'}):{text:'Web is unavailable for this notes-only request.',toolCalls:[]};
    await f.agent.submitText('Moo, use only my notes. Explain the pressure trial.');await f.agent.drain();
    assert.equal(f.observed.webCalls,0);assert.match(JSON.stringify((await snapshot(brain,f)).tools),/Web access disabled/);
  });
  run('no match and failed lookup remain distinguishable to the next model call',async(f,brain)=>{
    let n=0;brain.search=async query=>{if(query==='catalyst')throw Error('Storage unavailable');return [];};
    f.hooks.generation.respond=async()=>++n===1?{text:'',toolCalls:[{id:'empty',name:'search_notes',arguments:{query:'zephyrium'}},{id:'failed',name:'search_notes',arguments:{query:'catalyst'}}]}:{text:'Neither query supplied an answer.',toolCalls:[]};
    await f.agent.submitText('Moo, use only my notes. Check zephyrium and the catalyst result.');await f.agent.drain();
    const messages=f.observed.generations[1]!.messages.filter((m:any)=>m.role==='tool');
    assert.equal(JSON.parse(messages.find((m:any)=>m.toolCallId==='empty').content).status,'no_matches');
    assert.equal(JSON.parse(messages.find((m:any)=>m.toolCallId==='failed').content).status,'failed');
    assert.equal(JSON.parse(messages.find((m:any)=>m.toolCallId==='failed').content).error,'Storage unavailable');
  });
  run('creating a checklist produces one real note with source attribution',async(f,brain)=>{
    let n=0;f.hooks.generation.respond=async()=>++n===1?tool('write','create_note',{title:'Packing',text:'Bring the slide tray and lens cloth.'}):{text:'Saved the checklist.',toolCalls:[]};
    await f.agent.submitText('Moo, save a packing checklist with the slide tray and lens cloth.');await f.agent.drain();
    const records=await brain.listRecords(),created=records.filter(r=>r.kind==='note');assert.equal(created.length,1);
    assert.equal(created[0]!.segments[0]!.speaker,'assistant');
    assert.equal(created[0]!.segments[0]!.text,'Bring the slide tray and lens cloth.');
    assert.ok(created[0]!.links.some(l=>l.provenance==='source'&&l.targetId===f.agent.getState().conversationId));
  });
  run('an explicitly requested note title survives automatic enrichment',async(f,brain)=>{
    let n=0;f.hooks.generation.respond=async()=>++n===1?tool('named-note','create_note',{title:'Microscopy packing checklist',text:'Slide tray, lens cloth and notebook.'}):{text:'The note is saved.',toolCalls:[]};
    f.hooks.generation.summarize=async()=>({title:'Automatically suggested title',summary:'Bring the slide tray, lens cloth and notebook.'});
    await f.agent.submitText('Moo, save a note titled Microscopy packing checklist with those items.');await f.agent.drain();
    assert.equal((await brain.listRecords()).find(r=>r.kind==='note')!.title,'Microscopy packing checklist');
  });
  run('declined help and general help acceptance never capture a screen',async(f)=>{
    f.hooks.decisions.route=async input=>input.pendingOffer?{route:'no_action',confidence:1}:{route:'offer_help',confidence:1};
    await f.agent.submitText("What's even going on?");await f.agent.drain();await f.agent.submitText('No, just save it.');await f.agent.drain();
    assert.equal(f.observed.captures,0);assert.equal(f.agent.getState().conversationId,undefined);
    await f.agent.submitText("What's even going on?");await f.agent.drain();
    f.hooks.decisions.route=async()=>({route:'start_agent',confidence:1,helpAccepted:true});
    await f.agent.submitText('Yes, explain using my notes.');await f.agent.drain();assert.equal(f.observed.captures,0);assert.ok(f.agent.getState().conversationId);
  });
  run('permission-denied capture reports a limitation without invented evidence',async(f,brain)=>{
    f.hooks.capture.capture=async()=>{throw Error('Screen permission denied');};let n=0;
    f.hooks.generation.respond=async()=>++n===1?tool('screen','capture_screen',{question:'Read the pressure value.'}):{text:'Screen permission was denied; please describe the value.',toolCalls:[]};
    await f.agent.submitText('Moo, read my screen and tell me the pressure value.');await f.agent.drain();
    assert.equal(f.observed.captures,1);assert.ok((await brain.listRecords()).every(r=>!r.attachmentIds.length));
    assert.match(f.observed.generations[1]!.messages.find((m:any)=>m.role==='tool').content,/permission denied/);
  });
  run('manual summary edits survive delayed Nano and J7 assessment',async(f,brain)=>{
    const started=deferred<void>(),summary=deferred<any>();const r=await note(brain,{id:'n-edit',title:'Observation',text:'We measured 12 mL, not 120 mL.'});
    await brain.updateRecord(r.id,r.revision,{summary:'',quality:'pending'});
    f.hooks.generation.summarize=async()=>{started.resolve();return summary.promise;};
    await f.agent.queueEnrichment(r.id);await started.promise;const current=(await brain.getRecord(r.id))!;
    await brain.updateRecord(r.id,current.revision,{summary:'User verified: 12 mL; the pipette needs calibration.',manualFields:['summary']});
    summary.resolve({title:'Pipette result',summary:'Generated summary that must not replace the manual edit.'});await f.agent.drain();
    assert.equal((await brain.getRecord(r.id))!.summary,'User verified: 12 mL; the pipette needs calibration.');
  });
  run('J7 failure preserves a pending record; J6 failure preserves quality and failed work',async(f,brain)=>{
    f.hooks.decisions.route=async()=>({route:'dictate',confidence:1});f.hooks.decisions.tag=async()=>{throw Error('Tag provider unavailable');};
    await f.agent.submitText('The sensor recorded 128 lux at 40 cm.');await f.agent.drain();
    const pending=(await brain.listRecords()).find(r=>r.kind==='dictation')!;assert.equal(pending.quality,'pending');assert.match(pending.error??'',/Tag provider unavailable/);
    f.hooks.decisions.tag=async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1});
    f.hooks.decisions.connect=async()=>{throw Error('Connection provider unavailable');};
    await note(brain,{id:'related',title:'Sensor method',text:'Keep the sensor 40 cm from the lamp.'});
    await f.agent.retryPending(pending.id);await f.agent.drain();const result=(await brain.getRecord(pending.id))!;
    assert.equal(result.quality,'ready');assert.match(result.error??'',/Connection provider unavailable/);
    assert.ok((await brain.listOperations()).some(o=>o.status==='failed'));assert.match(transcriptText(result),/128 lux/);
  });
  run('off-topic notes remain searchable and J6 sees actual content with at most five candidates',async(f,brain)=>{
    await f.agent.setSubject('Optics');for(let i=0;i<8;i++)await note(brain,{id:'b'+i,title:'Basil observations '+i,text:'Basil leaves droop before watering and recover afterwards.'});
    f.hooks.decisions.route=async()=>({route:'dictate',confidence:1});
    f.hooks.decisions.tag=async()=>({purpose:'Reference',purposeConfidence:1,topics:{},doubt:0,faithful:1,understandable:1,relevant:0});
    f.hooks.decisions.connect=async(record,candidates)=>{assert.match(transcriptText(record),/Basil/);assert.ok(candidates.length<=5);return Object.fromEntries(candidates.map(c=>[c.id,1]));};
    await f.agent.submitText('Basil leaves droop before watering and recover afterwards.');await f.agent.drain();
    const record=(await brain.listRecords()).find(r=>r.kind==='dictation')!;
    assert.deepEqual(record.offTopic,{subject:'Optics'});assert.ok(record.links.length>0&&record.links.length<=5);
    assert.ok((await brain.search('Basil',20)).some(r=>r.id===record.id));assert.equal((await brain.listRecords()).filter(r=>r.kind==='note').length,8);
  });
  run('restart clears interrupted busy status while retaining the conversation and constraints',async(f,brain)=>{
    await f.agent.submitText('Moo, use only my notes and explain the method.');await f.agent.drain();
    const state=f.agent.getState();await brain.setState('agent',{...state,busy:true,listening:true});
    const restarted=new Agent({...f.options,id:()=>adapter+'-restart'});await restarted.initialize();
    assert.equal(restarted.getState().conversationId,state.conversationId);assert.equal(restarted.getState().webAllowed,false);
    assert.equal(restarted.getState().busy,false);assert.equal(restarted.getState().listening,false);assert.match(restarted.getState().lastError??'',/interrupted/);
  });
  run('an in-flight answer must not publish an obsolete note value',async(f,brain)=>{
    await note(brain,{id:'n-current',title:'Incubator',text:'The incubator setting is 28 C.'});
    const entered=deferred<void>(),pending=deferred<AgentReply>();let n=0;
    f.hooks.generation.respond=async()=>{if(++n===1)return tool('read','read_note',{id:'n-current'});entered.resolve();return pending.promise;};
    await f.agent.submitText('Moo, use only my notes. Read n-current and tell me the current setting.');await entered.promise;
    await brain.upsertSegment('n-current',segment('n-current-source','Correction: the setting is 31 C.','n-current-source',2));
    pending.resolve({text:'The current setting is 28 C [n-current].',toolCalls:[]});await f.agent.drain();
    assert.ok(!(await brain.listRecords()).filter(r=>r.kind==='conversation').some(r=>r.segments.some(s=>s.speaker==='assistant'&&s.text.includes('current setting is 28'))));
  });
  run('contradictory unreadable OCR values must not become usable answer evidence',async(f)=>{
    f.hooks.vision.interpret=async()=>JSON.stringify({observations:[{field:'calibration',status:'unreadable',value:'G8-29'}]});let n=0;
    f.hooks.generation.respond=async()=>++n===1?tool('capture','capture_screen',{question:'What is the calibration value?'}):{text:'I cannot read the value.',toolCalls:[]};
    await f.agent.submitText('Moo, read my screen and tell me the calibration value.');await f.agent.drain();
    const evidence=f.observed.generations[1]!.messages.find((m:any)=>m.role==='tool').content;
    const parsed=JSON.parse(evidence);assert.equal(parsed.result.observations[0].value,null);assert.ok(parsed.result.validationErrors.length);assert.ok(!evidence.includes('G8-29'));
  });
  run('a search must not return the current unanswered question as note evidence',async(f,brain)=>{
    await note(brain,{id:'schedule',title:'Workshop timing',text:'The optics workshop starts at 09:20.'});let n=0;
    f.hooks.generation.respond=async()=>++n===1?tool('lookup','search_notes',{query:'zephyrium'}):{text:'No supporting note found.',toolCalls:[]};
    await f.agent.submitText('Moo, use only my notes. Search for zephyrium.');await f.agent.drain();
    const result=(await snapshot(brain,f)).tools[0] as any;
    const {sessionId,conversationId}=f.agent.getState();
    assert.ok(!result.result.result.some((r:any)=>[sessionId,conversationId].includes(r.id)));
  });
  run('the pipette source reaches J6 despite common-word distractors',async(f,brain)=>{
    const corpus=JSON.parse(await readFile(new URL('../experiments/agent-closeout/cases.json',import.meta.url),'utf8'));
    for(const item of corpus.relatedNotes)await note(brain,item);
    f.hooks.decisions.route=async()=>({route:'dictate',confidence:1});
    // Replay the actual e09 title/summary to isolate candidate retrieval from generation.
    f.hooks.generation.summarize=async()=>({title:'Measurement discrepancy noted',summary:'The user reports that 12\u202fmL was measured instead of the intended 120\u202fmL, and notes that the result may still be affected by an uncalibrated pipette.'});
    f.hooks.decisions.tag=async()=>({purpose:'Reference',purposeConfidence:.95,topics:{Measurement:.92},doubt:.83,faithful:.85,understandable:.88});
    await f.agent.submitText(corpus.enrichment.find((c:any)=>c.id==='e09').text);await f.agent.drain();
    assert.equal(f.observed.connections.length,1);
    assert.ok(f.observed.connections[0].candidates.some((r:any)=>r.id==='b15'));
  });
}
