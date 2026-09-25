import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROFILES = ['H0', 'H1', 'H2', 'H3'];
const MODELS = ['super', 'ultra'];
const IDS = Array.from({ length: 8 }, (_, i) => `h${String(i + 1).padStart(2, '0')}`);
const REPEATS = ['h01', 'h03'];
const OUTCOMES = ['complete_supported', 'safe_unresolved', 'incorrect_or_unsupported', 'provider_or_harness_failure'];
const numeric = value => typeof value === 'number' && Number.isFinite(value);
const round = value => Math.round(value * 100) / 100;
const keyOf = row => `${row.id ?? row.caseId}:${row.profile}:${row.modelProfile}:${row.repeat ?? 0}`;
const counts = values => Object.fromEntries([...new Set(values)].sort().map(value => [value, values.filter(v => v === value).length]));
const booleans = values => ({ true: values.filter(v => v === true).length, false: values.filter(v => v === false).length, missing: values.filter(v => typeof v !== 'boolean').length });

export function distribution(values) {
  const sorted = values.filter(numeric).sort((a, b) => a - b);
  const percentile = p => {
    if (!sorted.length) return null;
    const position = (sorted.length - 1) * p, low = Math.floor(position), high = Math.ceil(position);
    return round(sorted[low] + (sorted[high] - sorted[low]) * (position - low));
  };
  return { samples: sorted.length, min: sorted[0] ?? null, median: percentile(0.5), p95: percentile(0.95), max: sorted.at(-1) ?? null,
    sum: sorted.length ? round(sorted.reduce((sum, value) => sum + value, 0)) : null };
}

function numericLeaves(value, prefix = '') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, entry]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return numeric(entry) ? [[path, entry]] : numericLeaves(entry, path);
  });
}
function providerStats(calls) {
  const fields = new Map(); let usageCalls = 0;
  for (const call of calls) {
    const leaves = numericLeaves(call.rawResponse?.usage ?? call.evidence?.usage);
    if (leaves.length) usageCalls++;
    for (const [field, value] of leaves) {
      const item = fields.get(field) ?? { sum: 0, reportedCalls: 0 };
      item.sum += value; item.reportedCalls++; fields.set(field, item);
    }
  }
  const reservation = calls.filter(call => call.reservedUsd !== null && call.reservedUsd !== undefined && Number.isFinite(Number(call.reservedUsd)));
  return { calls: calls.length, statuses: counts(calls.map(call => call.status ?? 'missing')),
    models: [...new Set(calls.map(call => call.model).filter(Boolean))], elapsedMs: distribution(calls.map(call => call.elapsedMs)),
    usage: { reportedCalls: usageCalls, missingCalls: calls.length - usageCalls, fields: Object.fromEntries([...fields].sort(([a], [b]) => a.localeCompare(b))) },
    reservations: { recordedUsd: reservation.length ? (reservation.reduce((sum, c) => sum + Math.round(Number(c.reservedUsd) * 100), 0) / 100).toFixed(2) : null,
      reportedCalls: reservation.length, missingCalls: calls.length - reservation.length } };
}
function assertReview(review) {
  if (typeof review.reviewId !== 'string' || !review.reviewId) throw new Error('Review requires reviewId');
  for (const field of ['primaryOutcome', 'constraintsHonored', 'citationsSupported'])
    if (review[field] !== null && typeof review[field] !== 'boolean') throw new Error(`Invalid review ${field}: ${review.reviewId}`);
  for (const field of ['unsupportedClaims', 'supportedClaims'])
    if (!Array.isArray(review[field]) || review[field].some(value => typeof value !== 'string')) throw new Error(`Invalid review ${field}: ${review.reviewId}`);
  if (review.outcomeCategory !== undefined && review.outcomeCategory !== null && !OUTCOMES.includes(review.outcomeCategory)) throw new Error(`Invalid outcomeCategory: ${review.reviewId}`);
  if (typeof review.explanation !== 'string') throw new Error(`Review explanation required: ${review.reviewId}`);
}
function joinReviews(reviewFile, reviewMap) {
  if (!reviewFile && !reviewMap) return { byKey: new Map(), mappedIds: new Map(), reviewIds: [] };
  if (!Array.isArray(reviewMap)) throw new Error('Reviews require the runner review-map array');
  const mappedIds = new Map(), keys = new Set();
  for (const item of reviewMap) {
    if (!item?.reviewId || !IDS.includes(item.id) || !PROFILES.includes(item.profile) || !MODELS.includes(item.modelProfile)
      || ![0, 1].includes(item.repeat ?? 0) || (item.repeat === 1 && !REPEATS.includes(item.id))) throw new Error('Invalid review-map entry');
    const key = keyOf(item);
    if (mappedIds.has(item.reviewId) || keys.has(key)) throw new Error('Duplicate review-map identity');
    mappedIds.set(item.reviewId, key); keys.add(key);
  }
  if (reviewFile && !Array.isArray(reviewFile.reviews)) throw new Error('Expected {reviews:[...]}');
  const byKey = new Map(), seen = new Set();
  for (const review of reviewFile?.reviews ?? []) {
    assertReview(review);
    if (seen.has(review.reviewId)) throw new Error(`Duplicate review: ${review.reviewId}`);
    const key = mappedIds.get(review.reviewId);
    if (!key) throw new Error(`Unmapped review: ${review.reviewId}`);
    seen.add(review.reviewId); byKey.set(key, structuredClone(review));
  }
  return { byKey, mappedIds, reviewIds: [...seen] };
}
function toolStats(rows, calls) {
  const proposals = calls.flatMap(call => call.output?.toolCalls ?? []);
  const observed = rows.flatMap(row => row.toolEvents ?? []);
  const traceTools = rows.flatMap(row => row.trace?.trace ?? []).filter(event => event.kind === 'tool');
  const reused = traceTools.filter(event => event.reused === true);
  const allowed = observed.filter(event => event.validation?.allowed === true);
  const blocked = observed.filter(event => event.validation?.allowed === false);
  return { proposed: proposals.length, proposedByName: counts(proposals.map(call => call.name ?? 'missing')),
    allowedFreshSimulations: allowed.length, blocked: blocked.length, reusedReads: reused.length,
    observedSharedCallbacks: observed.length, unknownCallbackPermission: observed.length - allowed.length - blocked.length,
    proposalCallbackDifference: proposals.length - allowed.length - blocked.length - reused.length,
    simulationErrors: observed.filter(event => event.error || event.result?.error).length,
    actualExecutionFlags: booleans(observed.map(event => event.executed)), simulatedFlags: booleans(observed.map(event => event.simulated)),
    controlsProposed: calls.filter(call => call.output?.controlProposal).length };
}
function semanticStats(rows) {
  const reviewed = rows.filter(row => row.review !== null);
  return { outcomeCategories: counts(rows.map(row => row.review === null ? 'unreviewed' : row.review.outcomeCategory ?? 'unclassified')), evaluatedTrue: reviewed.filter(row => row.review.primaryOutcome === true).length,
    evaluatedFalse: reviewed.filter(row => row.review.primaryOutcome === false).length,
    reviewPending: reviewed.filter(row => row.review.primaryOutcome === null).length,
    unreviewed: rows.filter(row => row.review === null).length,
    claimsReviewedCases: reviewed.length,
    casesWithUnsupportedClaims: reviewed.filter(row => row.review.unsupportedClaims.length > 0).length,
    unsupportedClaimCount: reviewed.reduce((sum, row) => sum + row.review.unsupportedClaims.length, 0),
    constraintsHonored: booleans(reviewed.map(row => row.review.constraintsHonored)),
    citationsSupported: booleans(reviewed.map(row => row.review.citationsSupported)) };
}
function subsetStats(rows, calls) {
  const present = rows.filter(row => row.present);
  const dialogueLatency = present.map(row => {
    const selected = calls.filter(call => keyOf(call) === row.key);
    return selected.length && selected.every(call => numeric(call.elapsedMs)) ? selected.reduce((sum, call) => sum + call.elapsedMs, 0) : null;
  });
  return { expectedCases: rows.length, presentCases: present.length, missingCases: rows.filter(row => !row.present).map(row => row.id),
    controller: { statuses: counts(rows.map(row => row.controllerStatus)), completed: rows.filter(row => row.controllerStatus === 'completed').length,
      answerPresent: present.filter(row => row.answerPresent).length,
      generationCalls: distribution(present.map(row => row.generationCalls)), responseWallMs: distribution(present.map(row => row.responseWallMs)), wholeCaseWallMs: distribution(present.map(row => row.wallMs)), casesOverCallLimit: present.filter(row => row.generationCalls > 6).map(row => row.id),
      sourceRetained: booleans(present.map(row => row.sourceRetained)), restartRetained: booleans(present.map(row => row.restartRetained)),
      restartEvidenceRetained: booleans(present.map(row => row.restartEvidenceRetained)) },
    semantic: semanticStats(rows), provider: providerStats(calls), providerElapsedPerDialogueMs: distribution(dialogueLatency),
    tools: toolStats(present.map(row => row._source), calls) };
}

/** Mechanical observations and independent semantic reviews remain separate. No answer-text heuristics. */
export function summarizeHarness(report, { reviews, reviewMap } = {}) {
  if (report?.experiment !== 'agent_harness_v1' || !Array.isArray(report.agentCases) || !Array.isArray(report.calls)) throw new Error('Invalid harness report');
  const joins = joinReviews(reviews, reviewMap);
  const callIds = report.calls.map(call => call.callId).filter(id => typeof id === 'string');
  if (new Set(callIds).size !== callIds.length) throw new Error('Duplicate provider call ID');
  const sourceRows = new Map(), expectedKeys = new Set();
  for (const profile of PROFILES) for (const modelProfile of MODELS)
    for (const [repeat, ids] of [[0, IDS], [1, REPEATS]]) for (const id of ids) expectedKeys.add(keyOf({ id, profile, modelProfile, repeat }));
  const unexpected = [];
  for (const row of report.agentCases) {
    const key = keyOf(row);
    if (!expectedKeys.has(key)) { unexpected.push(key); continue; }
    if (sourceRows.has(key)) throw new Error(`Duplicate case result: ${key}`);
    sourceRows.set(key, row);
  }
  const keysByReview = new Map([...joins.mappedIds].map(([id, key]) => [key, id]));
  const rows = [...expectedKeys].map(key => {
    const [id, profile, modelProfile, repetition] = key.split(':');
    const row = sourceRows.get(key);
    const review = joins.byKey.get(key) ?? null;
    return { key, id, profile, modelProfile, repeat: Number(repetition), present: !!row,
      scenario: row?.scenario ?? null, request: row?.providerInput?.latestRequest ?? null,
      controllerStatus: row?.status ?? 'missing', controllerError: row?.state?.lastError ?? row?.error ?? null,
      generationCalls: row?.generationCalls ?? null, wallMs: row?.wallMs ?? null, responseWallMs: row?.responseWallMs ?? null, answer: typeof row?.finalAnswer === 'string' ? row.finalAnswer : '',
      answerPresent: typeof row?.finalAnswer === 'string' && !!row.finalAnswer.trim(),
      sourceRetained: row?.sourceRetained ?? null, restartRetained: row?.restartRetained ?? null,
      restartEvidenceRetained: row?.restartEvidenceRetained ?? null,
      reviewId: keysByReview.get(key) ?? null, review, _source: row };
  });
  const measured = report.calls.filter(call => call.phase === 'agent');
  const cellRows = [];
  for (const profile of PROFILES) for (const modelProfile of MODELS) {
    const selected = rows.filter(row => row.profile === profile && row.modelProfile === modelProfile);
    const calls = measured.filter(call => call.profile === profile && call.modelProfile === modelProfile);
    cellRows.push({ profile, modelProfile,
      compatibility: report.compatibility?.find(row => row.profile === profile && row.modelProfile === modelProfile) ?? null,
      primary: subsetStats(selected.filter(row => row.repeat === 0), calls.filter(call => (call.repeat ?? 0) === 0)),
      repeats: subsetStats(selected.filter(row => row.repeat === 1), calls.filter(call => call.repeat === 1)) });
  }
  const summarizedCases = rows.map(row => {
    const calls = measured.filter(call => keyOf(call) === row.key);
    const { _source, ...result } = row;
    return { ...result, provider: providerStats(calls), tools: toolStats(_source ? [_source] : [], calls) };
  });
  return { version: 1, experiment: report.experiment, mode: report.mode, sourceComplete: report.complete === true,
    sourceStartedAt: report.startedAt ?? null, sourceFinishedAt: report.finishedAt ?? null,
    coverage: { expectedCases: expectedKeys.size, presentCases: sourceRows.size,
      missing: rows.filter(row => !row.present).map(row => row.key), unexpected,
      complete: sourceRows.size === expectedKeys.size && unexpected.length === 0 },
    rules: { primary: 'Independent semantic review only: true=complete supported answer, false=reviewed not complete supported, null=pending. Unreviewed is distinct.',
      controller: 'completed describes harness completion and is not semantic success.',
      unsupportedClaims: 'Count only claims explicitly supplied by independent reviewers; never infer from answer keywords.',
      repeats: 'Two predefined consistency checks per cell, separate from eight primary cases.',
      tools: 'Allowed counts fresh shared simulations; reused reads come from trace. SDK-side rejected proposals may never enter the shared callback.',
      latency: 'Provider-call elapsed milliseconds are separate from responseWallMs (submitText through drain, including SDK/tool/persistence) and whole-case wallMs (setup/restart included). Median/p95 use linear interpolation.',
      reservations: 'Conservative reservations, not invoiced spend; preserve ledger-reconciled run amount separately from recorded per-call sums.',
      missing: 'Missing cases/usage/latency/reviews remain explicit; unavailable is not zero.' },
    run: { productionDefaultsChanged: report.productionDefaultsChanged ?? null, microphoneUsed: report.microphoneUsed ?? null,
      realTasksExecuted: report.realTasksExecuted ?? null, retries: report.retries ?? null, budgetBeforeUsd: report.budgetBeforeUsd ?? null,
      ledgerReconciledReservationUsd: report.reservedUsd ?? null, cumulativeReservationUsd: report.cumulativeReservationUsd ?? null, returnedReservationUsd: report.returnedReservationUsd ?? null, fatalError: report.fatalError ?? null, casesSha256: report.casesSha256 ?? null },
    provider: { all: providerStats(report.calls), measured: providerStats(measured), compatibility: providerStats(report.calls.filter(call => call.phase === 'compatibility')) },
    reviewCoverage: { provided: joins.reviewIds.length, mapped: joins.mappedIds.size,
      reviewsWithoutObservedCase: summarizedCases.filter(row => row.review && !row.present).map(row => row.reviewId) },
    cells: cellRows, cases: summarizedCases };
}

const md = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shown = value => value === null || value === undefined ? '—' : String(value);
function snippet(text, max = 360) { const clean = String(text).replace(/\s+/g, ' ').trim(); return md(clean.length > max ? clean.slice(0, max - 1) + '…' : clean); }
export function renderHarnessMarkdown(summary) {
  const lines = ['# Agent harness comparison — case review', '',
    `Source run complete: **${summary.sourceComplete}**. Recorded cases: **${summary.coverage.presentCases}/${summary.coverage.expectedCases}**.`, '',
    'Controller completion and semantic success are separate. Pending or absent reviews are not passes or failures. This table does not replace the full raw evidence.', '',
    '| Harness | Model | Primary supported | Primary not complete supported | Review pending / absent | Controller completed | Repeat supported | Calls (primary / repeat) |',
    '| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |'];
  for (const cell of summary.cells) {
    const a = cell.primary, b = cell.repeats;
    lines.push(`| ${cell.profile} | ${cell.modelProfile} | ${a.semantic.evaluatedTrue}/8 | ${a.semantic.evaluatedFalse}/8 | ${a.semantic.reviewPending} / ${a.semantic.unreviewed} | ${a.controller.completed}/8 | ${b.semantic.evaluatedTrue}/2 | ${a.provider.calls} / ${b.provider.calls} |`);
  }
  if (!summary.coverage.complete) lines.push('', `Coverage is incomplete. Missing: ${summary.coverage.missing.map(md).join(', ') || 'none'}. Unexpected: ${summary.coverage.unexpected.map(md).join(', ') || 'none'}.`);
  for (const [repeat, ids] of [[0, IDS], [1, REPEATS]]) for (const id of ids) {
    const rows = summary.cases.filter(row => row.id === id && row.repeat === repeat);
    const contextual = rows.find(row => row.request);
    lines.push('', `## ${id}${repeat ? ' — consistency repeat' : ''}`, '');
    if (contextual) lines.push(`Request: ${md(contextual.request)}`, '');
    lines.push('| Harness / model | Controller | Semantic review | Calls / provider ms | Tools proposed / fresh allowed / reused / blocked | Answer excerpt |', '| --- | --- | --- | ---: | ---: | --- |');
    for (const row of rows) {
      const primary = row.review === null ? 'Unreviewed' : row.review.primaryOutcome === null ? 'Pending' : row.review.primaryOutcome ? 'Complete supported' : 'Not complete supported';
      const semantic = row.review?.outcomeCategory ? `${primary}; ${row.review.outcomeCategory}` : primary;
      const t = row.tools;
      lines.push(`| ${row.profile} / ${row.modelProfile} | ${md(row.controllerStatus)} | ${semantic} | ${shown(row.generationCalls)} / ${shown(row.provider.elapsedMs.sum)} | ${t.proposed} / ${t.allowedFreshSimulations} / ${t.reusedReads} / ${t.blocked} | ${snippet(row.answer) || '—'} |`);
      if (row.review?.explanation || row.controllerError) lines.push(`| | | ${snippet(row.review?.explanation ?? row.controllerError, 260)} | | | |`);
    }
  }
  lines.push('', 'Primary success requires a complete supported final answer under the frozen semantic rubric; a valid unanswered tool proposal alone is not success. Unsupported-claim counts come only from supplied independent reviews. Token usage, full retention counts, provider timings, reservations and per-case review details are in the companion summary JSON.', '');
  return lines.join('\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), values = {};
    const allowed = new Set(['--input', '--output', '--markdown', '--reviews', '--review-map']);
    for (let i = 0; i < args.length; i += 2) {
      if (!allowed.has(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || values[args[i]]) throw new Error('Invalid or duplicate CLI option');
      values[args[i]] = args[i + 1];
    }
    if (!values['--input']) throw new Error('Usage: node scripts/summarize-agent-harness.mjs --input report.json [--output summary.json] [--markdown cases.md] [--reviews claim-review.json --review-map review-map.json]');
    const inputs = ['--input', '--reviews', '--review-map'].filter(key => values[key]).map(key => resolve(values[key]));
    const outputs = ['--output', '--markdown'].filter(key => values[key]).map(key => resolve(values[key]));
    if (new Set(outputs).size !== outputs.length || outputs.some(path => inputs.includes(path))) throw new Error('Output must not overwrite input evidence or another output');
    const raw = await readFile(values['--input']);
    const reviews = values['--reviews'] ? JSON.parse(await readFile(values['--reviews'], 'utf8')) : undefined;
    const reviewMap = values['--review-map'] ? JSON.parse(await readFile(values['--review-map'], 'utf8')) : undefined;
    const summary = { ...summarizeHarness(JSON.parse(raw.toString()), { reviews, reviewMap }), sourceReportSha256: createHash('sha256').update(raw).digest('hex') };
    const serialized = JSON.stringify(summary, null, 2) + '\n';
    if (values['--output']) await writeFile(values['--output'], serialized); else process.stdout.write(serialized);
    if (values['--markdown']) await writeFile(values['--markdown'], renderHarnessMarkdown(summary));
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}
