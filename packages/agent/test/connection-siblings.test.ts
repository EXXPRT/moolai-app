import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,BrainRecord,ThoughtInput} from '../../contracts/src/index.js';
import {connectionCandidates} from '../src/connections.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

const now=()=> '2026-10-16T12:00:00Z';
const sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
for(const kind of ['memory','sqlite']) {
  async function run(finalize:boolean) {
    const dir=await mkdtemp(join(tmpdir(),'moolai-j6-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let n=0,calls=0;
    // One organizer pass yields two related notes, as in production growing-note mode.
    p.consolidate=async(input:ThoughtInput)=>{
      const sp=(s:ThoughtInput['segments'][number])=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length});
      const [first,...rest]=input.segments;
      return {groups:[
        {title:'Hamstring flexion',summary:first!.text,spans:[sp(first!)],topicSuggestions:['Anatomy'],continuesActive:false,ongoing:false},
        {title:'Hamstring extension',summary:rest.map(s=>s.text).join(' '),spans:rest.map(sp),topicSuggestions:['Anatomy'],continuesActive:false,ongoing:!input.finalize},
      ],remainder:[]};
    };
    // The first linking call is slower, so its sibling's enrichment patches land while it is in flight.
    p.connect=async(_r,candidates)=>{await sleep(++calls===1?60:5);return Object.fromEntries(candidates.map(c=>[c.id,.95]));};
    const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
      speech:{async speak(){},async stop(){}},id:()=>`j6-${++n}`,now});
    try{
      await agent.initialize();await agent.startSession();
      await agent.submitText('The hamstring flexes the knee.');
      await agent.submitText('The hamstring also extends the hip.');
      await agent.drain();await agent.consolidateThoughts(finalize);await agent.drain();
      return (await brain.listRecords()).filter(r=>r.kind==='dictation' && !r.sourceOnly);
    }finally{await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}
  }
  test(`${kind}: J6 never selects a draft or growing note as a candidate`,async()=>{
    const brain=new MemoryBrain();
    const make=async(id:string,thoughtStatus?:BrainRecord['thoughtStatus'])=>{
      const r=await brain.createRecord({id,kind:'dictation',createdAt:now()});
      return (await brain.updateRecord(id,r.revision,{title:id,body:'Hamstring muscles flex the knee.',...(thoughtStatus?{thoughtStatus}:{})}))!;
    };
    const source=await make('source','settled');
    for(const [id,status] of [['draft','draft'],['growing','growing'],['settled','settled'],['plain',undefined]] as const) await make(id,status);
    const {candidates}=await connectionCandidates(brain,source);
    assert.deepEqual(candidates.map(c=>c.id).sort(),['plain','settled']);
    await brain.close();
  });
  for(const finalize of [false,true]) test(`${kind}: sibling notes from one ${finalize?'final':'background'} pass do not fail each other's links`,async()=>{
    const notes=await run(finalize);
    assert.equal(notes.length,2);
    assert.deepEqual(notes.filter(r=>r.connectionStatus==='failed').map(r=>r.title),[]);
    if(finalize) assert.ok(notes.some(r=>r.links.some(l=>l.provenance==='suggested' && l.decision==='accepted')),'Settled siblings link');
  });
}
