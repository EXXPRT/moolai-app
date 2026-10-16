// Prints organizer requests that the real TypeScript ThoughtConsolidator builds for long workloads, with the
// estimate it packed them against. backend/tests/test_organizer_request_fit.py measures them with the real backend.
import {MemoryBrain} from '../../packages/brain/src/index.js';
import type {Segment,SourceSpan,ThoughtInput,ThoughtResult} from '../../packages/contracts/src/index.js';
import {ThoughtConsolidator} from '../../packages/agent/src/thoughts.js';
import {organizerStateBytes} from '../../packages/agent/src/organizer-budget.js';

const now=()=> '2026-10-16T12:00:00Z';
const seg=(id:string,text:string,speaker:Segment['speaker']='user'):Segment=>({id,turnId:id,revision:1,text,speaker,final:true,createdAt:now()});
const spans=(input:ThoughtInput):SourceSpan[]=>input.segments.map(s=>({segmentId:s.id,revision:s.revision,start:0,end:s.text.length}));
const workloads:Record<string,{segments:Segment[];context:string;manualSummary?:string}>={
  denseLog:{context:'',segments:['arrival','inspection','packing','dispatch'].map((phase,n)=>seg(phase,Array.from({length:60},(_,row)=>
    `${phase} row ${row+1}: Renée recorded crate ${n*60+row+1}; the label reads “記録室 🐚”. Inspection is proposed, not completed.\r\n`).join(''),n===1?'assistant':'user'))},
  sameTopic:{context:JSON.stringify([{conversationId:'c',requests:[],outcomes:[{tool:'search_notes',status:'success',result:'Three notes matched "Krebs".'}]}]),
    segments:Array.from({length:40},(_,i)=>seg(`s${i}`,`Point ${i}: the “Krebs” cycle — ATP ${i*2} µmol, NADH ${i*3}; it is not yet confirmed. `.repeat(6)))},
  answers:{context:'',segments:Array.from({length:16},(_,i)=>seg(`q${i}`,i%2?`**Answer ${i}.**\n\n- Glycolysis yields 2 ATP.\n- The "Krebs" cycle yields 2 ATP.\n\n| Stage | ATP |\n| --- | --- |\n| ETC | ~34 |\n`.repeat(8):`Moo, compare stage ${i} with the previous one.`,i%2?'assistant':'user'))},
  spaceless:{context:'',segments:Array.from({length:12},(_,i)=>seg(`z${i}`,'微积分基本定理说明导数与积分互为逆运算；'.repeat(60)+'🐚'))},
  manualSummary:{context:'',manualSummary:'My own long summary of the enzyme discussion. '.repeat(220),
    segments:Array.from({length:30},(_,i)=>seg(`m${i}`,`Enzyme note ${i}: activity peaks near 37 degrees and drops sharply above 45 degrees. `.repeat(4)))},
};
const captured:{name:string;input:ThoughtInput;stateBytes:number}[]=[];
for(const [name,w] of Object.entries(workloads)) {
  const brain=new MemoryBrain();await brain.createRecord({id:'study',kind:'session',createdAt:now()});
  const engine=new ThoughtConsolidator({brain,now,emit:()=>{},notice:()=>{},enrich:async()=>{},context:async()=>w.context,
    generation:{summarize:async()=>({title:'',summary:''}),respond:async()=>({text:'',toolCalls:[]}),
      consolidate:async(input):Promise<ThoughtResult>=>{
        captured.push({name,input:structuredClone(input),stateBytes:organizerStateBytes(input)});
        return {groups:[{title:'Continuing topic',summary:'A faithful bounded summary of the discussion so far.',spans:spans(input),
          continuesActive:!!input.activeNote,ongoing:!input.finalize,topicSuggestions:[]}],remainder:[]};
      }}});
  const [first,...rest]=w.segments;
  await brain.upsertSegment('study',first!);await engine.append('study',[first!]);await engine.process('study');
  if(w.manualSummary) {
    const note=(await brain.listRecords()).find(r=>r.kind==='dictation')!;
    await brain.updateRecord(note.id,note.revision,{summary:w.manualSummary,manualFields:['summary']});
  }
  for(const s of rest){await brain.upsertSegment('study',s);await engine.append('study',[s]);}
  for(let i=0;i<20;i++) await engine.process('study',i===19);
  await brain.close();
}
process.stdout.write(JSON.stringify(captured));
