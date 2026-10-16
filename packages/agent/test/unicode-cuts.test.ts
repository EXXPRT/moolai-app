import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {MemoryBrain,SQLiteBrain} from '../../brain/src/index.js';
import type {BrainPort,Segment} from '../../contracts/src/index.js';
import {newRecord,noteTitle} from '../../contracts/src/records.js';
import {thoughtPreview} from '../src/thought-preview.js';
import {Agent} from '../src/index.js';
import {FixtureProviders} from '../../agent-host/src/providers.js';

const now=()=> '2026-10-16T12:00:00Z';
const lone=(s:string)=>/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
const segment=(text:string):Segment=>({id:'s',turnId:'t',revision:1,speaker:'user',text,final:true,createdAt:now()});
// U+1D453 (mathematical italic f) starts at UTF-16 index 69, straddling the 70-unit title cut.
const integral='Integral notes '+'x'.repeat(54)+'\u{1D453}(\u{1D465}) dx is the antiderivative.';

test('fallback titles and spaceless previews never split a character',()=>{
  const record={...newRecord({id:'n',kind:'note',createdAt:now()}),body:integral};
  assert.ok(!lone(noteTitle(record)),'Fallback title');
  const cjk='微积分'.repeat(26)+'\u{20B9F}'+'定理';
  const preview=thoughtPreview([segment(cjk)]);
  assert.ok(!lone(preview.title),'Draft title');
  const long=thoughtPreview([segment('数'.repeat(259)+'\u{1F600}'+'学'.repeat(20))]);
  assert.ok(!lone(long.summary),'Summary excerpt');
});

for(const kind of ['memory','sqlite']) {
  test(`${kind}: an answer citing an untitled note with an astral character keeps organization healthy`,async()=>{
    const dir=await mkdtemp(join(tmpdir(),'moolai-unicode-'));
    const brain:BrainPort=kind==='memory'?new MemoryBrain():new SQLiteBrain(dir);
    const p=new FixtureProviders();let noteId='',n=0;
    p.respond=async()=>({text:'Your integral note defines the antiderivative.',references:[{recordId:noteId,title:'Integral note'}],toolCalls:[]});
    const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
      speech:{async speak(){},async stop(){}},id:()=>`u-${++n}`,now});
    try{
      await agent.initialize();await agent.startSession();
      noteId=(await agent.createNote({title:'',body:integral})).id;await agent.drain();
      await agent.submitText('Moo, what does my integral note say?');await agent.drain();
      const session=(await brain.listRecords()).find(r=>r.kind==='session')!;
      const answer=session.segments.filter(s=>s.speaker==='assistant').at(-1)!;
      assert.ok(answer.references?.length,'The answer cites the note');
      assert.ok(answer.references!.every(r=>!lone(r.title)),'Published reference titles are well formed');
      await agent.consolidateThoughts();await agent.drain();
      const buffer=await brain.getState<{status?:string;error?:string}>(`thought-buffer:${session.id}`);
      assert.notEqual(buffer?.status,'failed',String(buffer?.error));
    }finally{await agent.stopSession();await agent.drain();await brain.close();await rm(dir,{recursive:true,force:true});}
  });
}

test('recognition context never ends in a lone surrogate',async()=>{
  const brain=new MemoryBrain(),p=new FixtureProviders();let n=0;
  const agent=new Agent({brain,generation:p,decisions:p,search:p,vision:p,capture:{async capture(){throw Error('unused')}},
    speech:{async speak(){},async stop(){}},id:()=>`r-${++n}`,now});
  try{
    await agent.initialize();await agent.setSubject('a'.repeat(399)+'\u{1F600} chemistry');
    const context=await agent.recognitionContext();
    assert.ok(context.length<=400);assert.ok(!lone(context));
  }finally{await brain.close();}
});
