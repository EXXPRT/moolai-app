/** Deterministic measurements only. No provider calls, model grading or production routing. */
import { isDeepStrictEqual } from 'node:util';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const sameSet = (a, b) => a.length === b.length && new Set(a).size === a.length && [...a].sort().every((v, i) => v === [...b].sort()[i]);

// Preserve negations, decimals and word distinctions (Moo/Move, end/and).
export function words(text) {
  if (typeof text !== 'string') throw new TypeError('Transcript must be text');
  return text.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").match(/[\p{L}\p{N}]+(?:['.][\p{L}\p{N}]+)*/gu) ?? [];
}
export function wordErrors(reference, hypothesis) {
  const a = words(reference), b = words(hypothesis);
  let previous = Array.from({ length: b.length + 1 }, (_, insertions) => ({ errors: insertions, substitutions: 0, deletions: 0, insertions }));
  for (let i = 1; i <= a.length; i++) {
    const current = [{ errors: i, substitutions: 0, deletions: i, insertions: 0 }];
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) current[j] = { ...previous[j - 1] };
      else {
        const candidates = [
          { ...previous[j - 1], errors: previous[j - 1].errors + 1, substitutions: previous[j - 1].substitutions + 1 },
          { ...previous[j], errors: previous[j].errors + 1, deletions: previous[j].deletions + 1 },
          { ...current[j - 1], errors: current[j - 1].errors + 1, insertions: current[j - 1].insertions + 1 },
        ];
        current[j] = candidates.reduce((best, next) => next.errors < best.errors ? next : best);
      }
    }
    previous = current;
  }
  const result = previous[b.length];
  return { ...result, referenceWords: a.length, hypothesisWords: b.length,
    wer: a.length ? result.errors / a.length : null, silenceInsertions: a.length ? 0 : b.length };
}
export function scoreAsr(testCase, observation) {
  if (typeof testCase.reference !== 'string' || !Array.isArray(testCase.criticalPhrases)) throw new Error('Invalid ASR case');
  if (!observation || observation.status !== 'completed') return { status: 'incomplete', accuracy: null, criticalPhrases: null, finalWordPreserved: null, realTimeFactor: null };
  const transcript = observation.transcript;
  const tokens = words(transcript), normalized = ` ${tokens.join(' ')} `;
  return { status: 'completed', accuracy: wordErrors(testCase.reference, transcript),
    criticalPhrases: testCase.criticalPhrases.map(phrase => ({ phrase, preserved: normalized.includes(` ${words(phrase).join(' ')} `) })),
    finalWordPreserved: testCase.finalWord ? tokens.at(-1) === words(testCase.finalWord).at(-1) : null,
    realTimeFactor: finite(observation.inferenceMs) && observation.inferenceMs >= 0 && finite(observation.audioMs) && observation.audioMs > 0
      ? observation.inferenceMs / observation.audioMs : null,
    routeCorrect: typeof observation.observedRoute === 'string' && typeof testCase.expectedRoute === 'string'
      ? observation.observedRoute === testCase.expectedRoute : null,
  };
}

/** Responses for these closed tasks are JSON facts, not free-form prose judgments. */
export function scoreClosedTask(testCase, observed) {
  const expected = testCase.expected;
  if (!plain(expected) || !Array.isArray(testCase.sources) || !Array.isArray(testCase.allowedTools)) throw new Error('Invalid closed task');
  const checks = {};
  const check = (name, value) => { checks[name] = value; };
  check('completed', observed?.status === 'completed');
  let output;
  try { output = typeof observed?.output === 'string' ? JSON.parse(observed.output) : observed?.output; } catch { /* Recorded below; never repair invalid output. */ }
  check('structuredOutput', plain(output) && sameSet(Object.keys(output), ['status', 'facts', 'sources', 'acknowledgedFailures', 'scope'])
    && plain(output.facts) && Array.isArray(output.sources) && output.sources.every(s => plain(s) && sameSet(Object.keys(s), ['id', 'revision'])
      && typeof s.id === 'string' && Number.isInteger(s.revision) && s.revision >= 1)
    && Array.isArray(output.acknowledgedFailures) && output.acknowledgedFailures.every(s => typeof s === 'string'));
  if (checks.structuredOutput) {
    check('facts', isDeepStrictEqual(output.facts, expected.facts));
    check('answerStatus', output.status === expected.status);
    check('claimScope', output.scope === expected.scope);
    const keys = output.sources.map(s => `${s.id}:${s.revision}`);
    check('currentCitations', output.sources.every(s => testCase.sources.some(n => n.id === s.id && n.revision === s.revision))
      && sameSet(keys, expected.sourceIds.map(id => { const s = testCase.sources.find(n => n.id === id); return `${s.id}:${s.revision}`; })));
    check('failureDisclosure', sameSet(output.acknowledgedFailures, expected.failureIds));
  }
  const execution = observed?.execution;
  check('executionObserved', plain(execution) && Array.isArray(execution.tools) && execution.tools.every(t => plain(t) && typeof t.name === 'string')
    && Number.isInteger(execution.generationCalls) && execution.generationCalls >= 1
    && finite(execution.maximumWireBytes) && execution.maximumWireBytes >= 0
    && Number.isInteger(execution.retries) && execution.retries >= 0
    && typeof execution.sourceRetained === 'boolean' && typeof execution.cancelled === 'boolean');
  if (checks.executionObserved) {
    check('toolAllowlist', execution.tools.every(t => testCase.allowedTools.includes(t.name)));
    check('callBound', execution.generationCalls <= testCase.maxCalls);
    check('wireBound', execution.maximumWireBytes <= testCase.maxWireBytes);
    check('zeroRetries', execution.retries === 0);
    check('sourceRetained', execution.sourceRetained);
    check('notCancelled', !execution.cancelled);
    check('requiredRead', !testCase.requiredRead || execution.tools.some(t => t.name === 'read_note'
      && t.id === testCase.requiredRead.id && t.revision === testCase.requiredRead.revision && t.complete === true && t.status === 'success'));
  }
  return { status: !observed || !checks.executionObserved ? 'incomplete' : Object.values(checks).every(Boolean) ? 'passed' : 'failed',
    checks, failedChecks: Object.entries(checks).filter(([, ok]) => !ok).map(([name]) => name),
    proseQuality: 'not_scored', scope: 'closed_facts_and_observed_execution' };
}

/** Experimental policy over explicit request features. Not a natural-language classifier or a J gate. */
export function proposedTier(features) {
  if (!plain(features) || typeof features.ambiguous !== 'boolean' || !['lookup', 'summary', 'synthesis', 'reasoning', 'plan'].includes(features.task)
    || !Number.isInteger(features.sourceCount) || features.sourceCount < 0 || typeof features.conflictingEvidence !== 'boolean'
    || typeof features.dependentSteps !== 'boolean') throw new Error('Request features must be explicit; unknown is not low complexity');
  if (features.ambiguous) return 'clarify';
  if (features.conflictingEvidence || features.dependentSteps || ['reasoning', 'plan'].includes(features.task)) return 'high';
  if (features.sourceCount > 1 || features.task === 'synthesis') return 'medium';
  return 'low';
}

export function compareClosedTasks(cases, profiles) {
  if (!Array.isArray(cases) || !cases.length || new Set(cases.map(c => c.id)).size !== cases.length) throw new Error('Unique cases required');
  if (!Array.isArray(profiles) || !profiles.length || new Set(profiles.map(p => p.id)).size !== profiles.length) throw new Error('Unique profiles required');
  return profiles.map(profile => {
    if (!Array.isArray(profile.runs) || new Set(profile.runs.map(r => r.caseId)).size !== profile.runs.length
      || profile.runs.some(r => !cases.some(c => c.id === r.caseId))) throw new Error('Duplicate or unexpected observations');
    const rows = cases.map(c => ({ caseId: c.id, ...scoreClosedTask(c, profile.runs.find(r => r.caseId === c.id)) }));
    return { profile: profile.id, cases: rows, passed: rows.filter(r => r.status === 'passed').length,
      failed: rows.filter(r => r.status === 'failed').length, incomplete: rows.filter(r => r.status === 'incomplete').length,
      total: cases.length, eligibleForComparison: rows.every(r => r.status !== 'incomplete'), proseQuality: 'not_scored' };
  });
}
