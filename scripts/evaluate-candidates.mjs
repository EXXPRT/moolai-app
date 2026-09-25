/** Offline scoring and corpus preview. This command cannot run models or access a microphone. */
import { readFile, writeFile, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compareClosedTasks, proposedTier, scoreAsr } from './evaluation-metrics.mjs';

export async function loadEvaluationCorpus(name) {
  if (!['closed-task-cases', 'asr-cases'].includes(name)) throw new Error('Unknown evaluation corpus');
  const raw = await readFile(new URL(`../experiments/evaluation/${name}.json`, import.meta.url));
  return { corpus: JSON.parse(raw), sha256: createHash('sha256').update(raw).digest('hex') };
}
export function compareAsr(cases, profiles) {
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c=>c.id)).size!==cases.length
    || !Array.isArray(profiles) || !profiles.length || new Set(profiles.map(p=>p.id)).size!==profiles.length) throw new Error('Unique cases and profiles required');
  return profiles.map(profile => {
    if (!Array.isArray(profile.runs) || new Set(profile.runs.map(r=>r.caseId)).size!==profile.runs.length
      || profile.runs.some(r=>!cases.some(c=>c.id===r.caseId))) throw new Error('Duplicate or unexpected ASR observation');
    const rows=cases.map(c=>({caseId:c.id,...scoreAsr(c,profile.runs.find(r=>r.caseId===c.id))}));
    const complete=rows.filter(r=>r.status==='completed');
    const sum=key=>complete.reduce((n,r)=>n+r.accuracy[key],0);
    const speechErrors=complete.filter(r=>r.accuracy.referenceWords>0).reduce((n,r)=>n+r.accuracy.errors,0);
    return {profile:profile.id,cases:rows,observed:complete.length,expected:cases.length,
      eligibleForComparison:complete.length===cases.length,
      pooledWer:sum('referenceWords')?speechErrors/sum('referenceWords'):null,
      errors:sum('errors'),speechErrors,referenceWords:sum('referenceWords'),silenceInsertions:sum('silenceInsertions'),
      criticalPhrases:{preserved:complete.flatMap(r=>r.criticalPhrases).filter(r=>r.preserved).length,
        observed:complete.flatMap(r=>r.criticalPhrases).length},
      routing:{correct:complete.filter(r=>r.routeCorrect===true).length,observed:complete.filter(r=>r.routeCorrect!==null).length},
      microphoneAcceptance:'not_tested'};
  });
}
export async function main(args) {
  if (!args.length) {
    const agent=await loadEvaluationCorpus('closed-task-cases'),asr=await loadEvaluationCorpus('asr-cases');
    return {mode:'preview',paidCalls:0,microphoneUsed:false,
      agent:{sha256:agent.sha256,cases:agent.corpus.cases.map(c=>({id:c.id,request:c.request,factFields:c.factFields,proposedTier:proposedTier(c.requestFeatures)}))},
      asr:{sha256:asr.sha256,model:asr.corpus.modelCandidate,cases:asr.corpus.cases},
      note:'Tier features are authored fixtures, not an evaluated language router. Oracle answers are excluded from this preview; free-form prose is not graded.'};
  }
  const opts={};
  for(let i=0;i<args.length;i+=2) {
    if(!['--agent','--asr','--output'].includes(args[i])||!args[i+1]||args[i+1].startsWith('--')||opts[args[i]]) throw new Error('Invalid scoring options');
    opts[args[i]]=args[i+1];
  }
  if(Number(Boolean(opts['--agent']))+Number(Boolean(opts['--asr']))!==1) throw new Error('Choose --agent or --asr observations.json');
  const mode=opts['--agent']?'agent':'asr',input=resolve(opts[`--${mode}`]);
  if(opts['--output']&&resolve(opts['--output'])===input) throw new Error('Cannot overwrite input evidence');
  if((await stat(input)).size>8_000_000) throw new Error('Observation file is too large');
  const raw=await readFile(input),data=JSON.parse(raw);
  const {corpus,sha256}=await loadEvaluationCorpus(mode==='agent'?'closed-task-cases':'asr-cases');
  if(data.corpusSha256!==sha256) throw new Error('Corpus hash differs; do not compare unlike fixtures');
  const result={mode:`${mode}-scoring`,paidCalls:0,corpusSha256:sha256,
    observationsSha256:createHash('sha256').update(raw).digest('hex'),
    profiles:mode==='agent'?compareClosedTasks(corpus.cases,data.profiles):compareAsr(corpus.cases,data.profiles),
    note:'This is a deterministic measurement, not a general quality ranking. Missing runs remain incomplete; ties stay ties.'};
  if(opts['--output']) await writeFile(opts['--output'],JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  return result;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {console.log(JSON.stringify(await main(process.argv.slice(2)),null,2));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
