import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const number = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 100) / 100;
const countBy = (rows, key) => Object.fromEntries([...new Set(rows.map(key))].sort().map(value => [value, rows.filter(row => key(row) === value).length]));
const split = rows => ({ base: rows.filter(row => !(row.repeat > 0)), repeats: rows.filter(row => row.repeat > 0) });
const profiles = (rows, fn) => Object.fromEntries([...new Set(rows.map(row => row.profile))].sort().map(profile => [profile, fn(rows.filter(row => row.profile === profile))]));
const truthCounts = values => ({ true: values.filter(value => value === true).length, false: values.filter(value => value === false).length, missing: values.filter(value => typeof value !== 'boolean').length });
const outcome = (passed, total) => ({ passed, total, percent: total ? round(passed / total * 100) : null });

export function distribution(values) {
  const sorted = values.filter(number).sort((a, b) => a - b);
  const percentile = p => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p;
    const low = Math.floor(position), high = Math.ceil(position);
    return round(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
  };
  return { samples: sorted.length, min: sorted.length ? sorted[0] : null, median: percentile(0.5), p95: percentile(0.95),
    max: sorted.length ? sorted.at(-1) : null, sum: round(sorted.reduce((sum, value) => sum + value, 0)) };
}

function numericLeaves(object, prefix = '') {
  if (!object || typeof object !== 'object' || Array.isArray(object)) return [];
  return Object.entries(object).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return number(value) ? [[path, value]] : value && typeof value === 'object' ? numericLeaves(value, path) : [];
  });
}

function providerStats(calls) {
  const usage = new Map();
  let reportedUsageCalls = 0;
  for (const call of calls) {
    const fields = numericLeaves(call.rawResponse?.usage ?? call.evidence?.usage);
    if (fields.length) reportedUsageCalls++;
    for (const [key, value] of fields) {
      const current = usage.get(key) ?? { sum: 0, reportedCalls: 0 };
      current.sum += value; current.reportedCalls++; usage.set(key, current);
    }
  }
  const knownReservation = calls.filter(call => call.reservedUsd !== null && call.reservedUsd !== undefined && Number.isFinite(Number(call.reservedUsd)));
  return { calls: calls.length, statuses: countBy(calls, call => call.status ?? 'missing'), models: [...new Set(calls.map(call => call.model).filter(Boolean))].sort(),
    latencyMs: distribution(calls.map(call => call.elapsedMs)),
    reservations: { usd: (knownReservation.reduce((sum, call) => sum + Math.round(Number(call.reservedUsd) * 100), 0) / 100).toFixed(2),
      reportedCalls: knownReservation.length, missingCalls: calls.length - knownReservation.length, meaning: 'Conservative reservations, not invoice charges' },
    usage: { reportedCalls: reportedUsageCalls, missingCalls: calls.length - reportedUsageCalls,
      fields: Object.fromEntries([...usage.entries()].sort(([a], [b]) => a.localeCompare(b))) } };
}

function checksSummary(checks) {
  const entries = Object.entries(checks ?? {});
  return { ...outcome(entries.filter(([, value]) => value === true).length, entries.length),
    failedChecks: entries.filter(([, value]) => value !== true).map(([key]) => key).sort() };
}

function ocrStats(rows, calls) {
  const scored = rows.filter(row => row.scoring?.raw?.checks && row.scoring?.validated?.checks);
  const aggregate = mode => {
    const all = scored.flatMap(row => Object.entries(row.scoring[mode].checks));
    const category = suffix => { const entries = all.filter(([key]) => key.endsWith(suffix)); return outcome(entries.filter(([, value]) => value === true).length, entries.length); };
    return { checks: outcome(all.filter(([, value]) => value === true).length, all.length), values: category('.value'), readability: category('.status'),
      allChecksPassedImages: scored.filter(row => Object.values(row.scoring[mode].checks).every(value => value === true)).length };
  };
  return { images: rows.length, statuses: countBy(rows, row => row.status ?? 'missing'), scoredImages: scored.length, unscoredImages: rows.length - scored.length,
    reusedResponses: rows.filter(row => row.reusedFrom).length,
    actualVisionCalls: calls.filter(call => call.phase === 'vision' && rows.some(row => row.id === call.caseId && row.profile === call.profile && (row.repeat ?? 0) === (call.repeat ?? 0))).length,
    raw: aggregate('raw'), validated: aggregate('validated'),
    validationIssues: countBy(scored.flatMap(row => row.scoring.issues ?? []), issue => issue.code),
    cases: rows.map(row => ({ id: row.id, repeat: row.repeat ?? 0, status: row.status, reusedFrom: row.reusedFrom ?? null,
      raw: row.scoring?.raw?.checks ? checksSummary(row.scoring.raw.checks) : null,
      validated: row.scoring?.validated?.checks ? checksSummary(row.scoring.validated.checks) : null,
      issues: row.scoring?.issues ?? [] })) };
}

function controllerStats(rows, calls) {
  const toolProposals = rows.flatMap(row => (row.responses ?? []).flatMap(response => response.output?.toolCalls ?? []));
  const previewEvents = rows.flatMap(row => row.toolEvents ?? []);
  const sourceAtGeneration = rows.flatMap(row => (row.responses ?? []).map(response => response.sourceSavedBeforeGeneration));
  const caseLatency = rows.map(row => {
    const actual = calls.filter(call => call.phase === 'agent' && call.caseId === row.id && call.profile === row.profile && (call.repeat ?? 0) === (row.repeat ?? 0));
    return actual.length && actual.every(call => number(call.elapsedMs)) ? actual.reduce((sum, call) => sum + call.elapsedMs, 0) : null;
  });
  return { cases: rows.length, statuses: countBy(rows, row => row.status ?? 'missing'),
    sourceRetained: truthCounts(rows.map(row => row.sourceRetained)), restartRetained: truthCounts(rows.map(row => row.restartRetained)),
    restartEvidenceRetained: truthCounts(rows.map(row => row.restartEvidenceRetained)), sourceSavedBeforeGeneration: truthCounts(sourceAtGeneration),
    generationCalls: distribution(rows.map(row => row.generationCalls)), casesAboveTwoGenerations: rows.filter(row => row.generationCalls > 2).length,
    providerLatencyPerDialogueMs: distribution(caseLatency),
    liveToolProposals: { total: toolProposals.length, byTool: countBy(toolProposals, call => call.name ?? 'missing') },
    controlProposals: rows.flatMap(row => (row.responses ?? []).filter(response => response.output?.controlProposal)).length,
    injectedToolEvents: rows.reduce((sum, row) => sum + (row.injectedEvents?.prior?.length ?? 0) + (row.injectedEvents?.current?.length ?? 0), 0),
    previewEvents: { total: previewEvents.length, byTool: countBy(previewEvents, event => event.call?.name ?? 'missing'),
      allowed: truthCounts(previewEvents.map(event => event.validation?.allowed)), executed: truthCounts(previewEvents.map(event => event.executed)),
      simulated: truthCounts(previewEvents.map(event => event.simulated)), errors: previewEvents.filter(event => event.error || event.result?.error).length },
    finalAnswerPresent: rows.filter(row => typeof row.finalAnswer === 'string' && row.finalAnswer.trim()).length,
    controllerErrors: rows.filter(row => row.after?.lastError).map(row => ({ id: row.id, repeat: row.repeat ?? 0, error: row.after.lastError })) };
}

export function classifyProbability(value) {
  if (!number(value) || value < 0 || value > 1) return 'missing';
  return value >= 0.8 ? 'true' : value <= 0.2 ? 'false' : 'uncertain';
}

function j7Stats(rows) {
  const metrics = ['faithful', 'understandable', 'relevant', 'doubt'];
  const cases = rows.map(row => {
    const output = row.output ?? {};
    const confidence = output.purposeConfidence;
    const accepted = number(confidence) && confidence >= 0.8 && confidence <= 1 && ['Question', 'Reference', 'Idea', 'Action'].includes(output.purpose);
    const classifications = Object.fromEntries(metrics.map(metric => [metric, { expected: typeof row.expected?.[metric] === 'boolean' ? row.expected[metric] : null,
      probability: number(output[metric]) ? output[metric] : null, classification: classifyProbability(output[metric]),
      correct: typeof row.expected?.[metric] === 'boolean' ? classifyProbability(output[metric]) === String(row.expected[metric]) : null }]));
    const ready = classifications.faithful.classification === 'true' && classifications.understandable.classification === 'true';
    const missingQuality = ['faithful', 'understandable'].some(metric => classifications[metric].classification === 'missing');
    return { id: row.id, status: row.status, purpose: { expected: row.expected?.purpose ?? null, label: output.purpose ?? null,
      confidence: number(confidence) ? confidence : null, labelMatches: row.expected?.purpose ? output.purpose === row.expected.purpose : null,
      accepted, acceptedLabel: accepted ? output.purpose : null, acceptedCorrect: accepted && output.purpose === row.expected?.purpose },
      ...classifications,
      productionQuality: { expectedReady: row.expected?.faithful === true && row.expected?.understandable === true,
        assessment: missingQuality ? 'pending' : ready ? 'ready' : 'needs_review' } };
  });
  return { records: rows.length, statuses: countBy(rows, row => row.status ?? 'missing'),
    purpose: { rawLabelMatches: cases.filter(row => row.purpose.labelMatches === true).length,
      accepted: cases.filter(row => row.purpose.accepted).length, acceptedCorrect: cases.filter(row => row.purpose.acceptedCorrect).length,
      acceptedIncorrect: cases.filter(row => row.purpose.accepted && !row.purpose.acceptedCorrect).length,
      notAccepted: cases.filter(row => !row.purpose.accepted).length },
    metrics: Object.fromEntries(metrics.map(metric => {
      const evaluated = cases.filter(row => row[metric].expected !== null);
      return [metric, { applicable: evaluated.length, notApplicable: cases.length - evaluated.length,
        classifications: countBy(evaluated, row => row[metric].classification),
        correct: evaluated.filter(row => row[metric].correct).length,
        confidentlyIncorrect: evaluated.filter(row => ['true', 'false'].includes(row[metric].classification) && !row[metric].correct).length,
        uncertain: evaluated.filter(row => row[metric].classification === 'uncertain').length,
        missing: evaluated.filter(row => row[metric].classification === 'missing').length }];
    })),
    productionQuality: { assessments: countBy(cases, row => row.productionQuality.assessment),
      falseReady: cases.filter(row => row.productionQuality.assessment === 'ready' && !row.productionQuality.expectedReady).length,
      expectedReadyButNotReady: cases.filter(row => row.productionQuality.expectedReady && row.productionQuality.assessment !== 'ready').length },
    cases };
}

/** Summarizes recorded observations only. Answer-claim review is intentionally separate. */
export function summarizeReliability(report) {
  if (report.complete !== true) throw new Error('Refusing to summarize an incomplete reliability report');
  const calls = report.calls ?? [];
  const phases = [...new Set(calls.map(call => call.phase))].sort();
  return { version: 1, experiment: report.experiment, mode: report.mode, complete: true, sourceFinishedAt: report.finishedAt ?? null,
    rules: { probabilityTrue: '>=0.8', probabilityFalse: '<=0.2', probabilityOtherwise: 'uncertain',
      missingOrInvalidProbability: 'missing', purposeAccepted: 'valid label and confidence >=0.8',
      productionReady: 'faithful >=0.8 and understandable >=0.8; unavailable assessment is pending',
      repeats: 'Consistency observations, separated from independent base cases', agentClaims: 'Not graded; independent review required',
      latency: 'Provider-only milliseconds; linear-interpolated median and p95', copiedVision: 'C reuses B; only calls array contributes actual provider calls' },
    run: { microphoneUsed: report.microphoneUsed, realScreensCaptured: report.realScreensCaptured, realTasksExecuted: report.realTasksExecuted,
      productionDefaultsChanged: report.productionDefaultsChanged, forbiddenCapabilities: report.forbiddenCapabilities, retries: report.retries,
      newReservationUsd: report.newReservationUsd, cumulativeReservationUsd: report.cumulativeReservationUsd },
    provider: { total: providerStats(calls), byPhase: Object.fromEntries(phases.map(phase => {
      const selected = calls.filter(call => call.phase === phase);
      return [phase, { total: providerStats(selected), profiles: profiles(selected, group => ({ total: providerStats(group),
        ...Object.fromEntries(Object.entries(split(group)).map(([key, subset]) => [key, providerStats(subset)])) })) }];
    })) },
    controller: profiles(report.agentCases ?? [], rows => Object.fromEntries(Object.entries(split(rows)).map(([key, subset]) => [key, controllerStats(subset, calls)]))),
    ocr: profiles(report.images ?? [], rows => Object.fromEntries(Object.entries(split(rows)).map(([key, subset]) => [key, ocrStats(subset, calls)]))),
    j7: j7Stats(report.tags ?? []),
    followThrough: { cases: (report.followThrough ?? []).map(row => ({ imageId: row.imageId, profile: row.profile, status: row.status,
      answerPresent: typeof row.output?.text === 'string' && !!row.output.text.trim() })), claimsGraded: false } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/summarize-agent-reliability.mjs <completed-report.json>');
    const raw = await readFile(process.argv[2]);
    const result = summarizeReliability(JSON.parse(raw.toString()));
    process.stdout.write(JSON.stringify({ ...result, sourceReportSha256: createHash('sha256').update(raw).digest('hex') }, null, 2) + '\n');
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
