import type {BrainPort, BrainRecord, GenerationProvider, Summary, ThoughtInput, ThoughtPlan, ThoughtResult} from '../../contracts/src/index.js';
import {newRecord} from '../../contracts/src/records.js';
import {validateThoughts} from './thoughts.js';

interface Stages { plan?: ThoughtPlan; summaries: Summary[]; dispatch?: string; error?: string }
/** Durable successful stages can be reused on explicit retry. Never dispatches during recovery. */
export async function plannedThoughts(brain: BrainPort, generation: GenerationProvider, input: ThoughtInput,
  operation: string, previous?: BrainRecord): Promise<ThoughtResult> {
  if (!generation.planThoughts) throw Error('Topic planning provider unavailable; source retained.');
  const key = `thought-stages:${operation}`;
  const state = await brain.getState<Stages>(key) ?? {summaries: []};
  const save = () => brain.setState(key,state);
  try {
    if (!state.plan) {
      state.dispatch = 'plan'; await save();
      const plan = await generation.planThoughts(input);
      validatePlan(input,plan);
      state.plan = plan; state.dispatch = undefined; await save();
    }
    validatePlan(input,state.plan);
    for (let i=state.summaries.length; i<state.plan.groups.length; i++) {
      const group = state.plan.groups[i]!;
      const extendsActive = i===0 && state.plan.extendsActive;
      if (extendsActive && (!previous || previous.sourceRevision !== input.activeNote?.sourceRevision))
        throw Error('Current source for the growing note is unavailable.');
      const record = newRecord({id:`planning:${operation}:${i}`,kind:'dictation',createdAt:input.segments[0]!.createdAt});
      // Writers see complete authoritative source, never a previous generated summary as fact.
      record.segments = [...(extendsActive ? previous!.segments : []), ...group.spans.map((span,n) => {
        const segment = input.segments.find(s => s.id===span.segmentId)!;
        return {...segment,id:`${segment.id}:planning:${n}`,text:segment.text.slice(span.start,span.end)};
      })];
      if (extendsActive) {
        record.body = previous!.body;
        if (previous!.manualFields.includes('title')) {record.title=previous!.title;record.manualFields=['title'];}
      }
      record.sourceContext=input.context;
      state.dispatch=`summary:${i}`; await save();
      const summary=await generation.summarize(record);
      if (!summary.title?.trim() || !summary.summary?.trim() || summary.summary.length>1000 || (summary.topicSuggestions?.length ?? 0)>3)
        throw Error('Planned summary is incomplete or exceeds its publication bound; source retained.');
      state.summaries.push(summary);state.dispatch=undefined;await save();
    }
    const result = {groups:state.plan.groups.map((g,i)=>({...g,...state.summaries[i]!,
      continuesActive:i===0 && state.plan!.extendsActive,ongoing:i===state.plan!.groups.length-1 && state.plan!.ongoing})),remainder:state.plan.remainder};
    validateThoughts(input,result);state.error=undefined;await save();return result;
  } catch(error) {state.error=String(error);await save();throw error;}
}
export function validatePlan(input: ThoughtInput, plan: ThoughtPlan) {
  if (!plan || !Array.isArray(plan.groups) || !plan.groups.length || plan.groups.length>6 ||
      typeof plan.extendsActive!=='boolean' || typeof plan.ongoing!=='boolean') throw Error('Invalid topic plan.');
  validateThoughts(input,{groups:plan.groups.map((g,i)=>({...g,title:'Boundary',summary:'Boundary',
    continuesActive:i===0 && plan.extendsActive,ongoing:i===plan.groups.length-1 && plan.ongoing})),remainder:plan.remainder});
}
