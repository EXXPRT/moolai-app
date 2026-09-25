import {scoreAsr,words} from '../../scripts/evaluation-metrics.mjs';

// A separate, declared semantic check. The original strict WER is never rewritten.
// In particular, Moo/Move, end/and and negations remain different words.
export function canonicalWords(text){
  const aliases={five:'5',forty:'40',twenty:'20',metres:'meters',centimetres:'centimeters'};
  return words(text).map(w=>aliases[w]??w);
}
export function assess(testCase,observation){
  const strict=scoreAsr(testCase,observation);
  if(strict.status!=='completed')return {strict,criticalPass:false,semanticCriticalPass:false};
  if(!testCase.reference)return {strict,criticalPass:strict.accuracy.silenceInsertions===0,semanticCriticalPass:strict.accuracy.silenceInsertions===0};
  const tokens=canonicalWords(observation.transcript),text=' '+tokens.join(' ')+' ';
  const semanticPhrases=testCase.criticalPhrases.map(phrase=>({phrase,preserved:text.includes(' '+canonicalWords(phrase).join(' ')+' ')}));
  const final=canonicalWords(testCase.finalWord??'').at(-1);
  return {strict,semanticPhrases,criticalPass:strict.criticalPhrases.every(p=>p.preserved)&&strict.finalWordPreserved,
    semanticCriticalPass:semanticPhrases.every(p=>p.preserved)&&tokens.at(-1)===final};
}
