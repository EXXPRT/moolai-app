/** Produce blinded review packets from recorded evidence, never from model-name heuristics. */
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';

const args = process.argv.slice(2);
const option = key => args[args.indexOf(key) + 1];
if (!args.includes('--input') || !args.includes('--output')) throw new Error('--input REPORT --output PACKET required');
const input = option('--input');
const report = JSON.parse(await readFile(input, 'utf8'));
const corpus = JSON.parse(await readFile(new URL('../experiments/fixtures/agent-harness-cases.json', import.meta.url), 'utf8'));
const cohort = args.includes('--cohort') ? option('--cohort') : 'all';
if (!['all', 'a', 'b'].includes(cohort)) throw new Error('Unknown review cohort');
const runId = path.basename(path.dirname(input));
const opaque = value => 'r-' + createHash('sha256').update(value).digest('hex').slice(0, 18);
const records = report.agentCases.filter(row => row.status !== 'started' &&
  (cohort === 'all' || (['h01', 'h02', 'h03', 'h04'].includes(row.id) && row.repeat === 0) === (cohort === 'a')));
const packets = records.map(row => {
  const item = corpus.agentCases.find(c => c.id === row.id);
  const last = report.calls.filter(call => call.phase === 'agent' && call.caseId === row.id &&
    call.profile === row.profile && call.modelProfile === row.modelProfile && call.repeat === row.repeat).at(-1);
  return {
    reviewId: opaque(`${runId}:${row.id}:${row.profile}:${row.modelProfile}:${row.repeat}:blind`),
    caseId: row.id, request: item.providerInput.latestRequest, expected: item.expected,
    currentNotes: item.providerInput.notes, answer: row.finalAnswer ?? '', status: row.status,
    // The final dispatch includes the preceding tool history and the actual current excerpts.
    // Remove system prompts and all model/harness names, timings and billing metadata.
    lastModelContext: (last?.input?.messages ?? []).filter(message => message.role !== 'system'),
    toolEvents: row.toolEvents ?? [],
  };
});
packets.sort((a, b) => a.reviewId.localeCompare(b.reviewId));
await writeFile(option('--output'), JSON.stringify({ scoringPolicy: corpus.scoringPolicy, instructions:
  'Score final answers, not tool proposals. The frozen primary semantic rule requires a complete supported answer or an accurate source limitation. In h01, valid retrieval without an answer is not primary success; the legacy expected.outcome name does not override scoringPolicy. Check claims against current notes AND evidence available in lastModelContext. Citation support is separate from mere presence. Do not infer missing storage from failed or unmatched searches. No model or harness labels are supplied.', cases: packets }, null, 2) + '\n');
console.log(JSON.stringify({ cohort, cases: packets.length, output: option('--output') }));
