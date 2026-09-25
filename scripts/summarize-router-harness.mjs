/** Read-only aggregation of frozen observations. Never repairs or regrades answers. */
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const sum = values => values.reduce((a, b) => a + b, 0);
const money = values => Math.round(sum(values.map(Number)) * 1e6) / 1e6;
const median = values => {
  if (!values.length) return null;
  const ordered = [...values].sort((a, b) => a - b), middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const unique = (rows, key, label) => {
  if (new Set(rows.map(key)).size !== rows.length) throw new Error(`Duplicate ${label}`);
};
const rates = { super: [.3, .9], lightning: [.06, .24], glm: [1.4, 4.4], jev: [.042, 0] };
function usage(calls) {
  return Object.entries(rates).map(([model, [inputPrice, outputPrice]]) => {
    const rows = calls.filter(c => c.modelProfile === model);
    const input = sum(rows.map(c => c.usage?.prompt_tokens ?? c.usage?.input_tokens ?? 0));
    const output = sum(rows.map(c => c.usage?.completion_tokens ?? c.usage?.output_tokens ?? 0));
    const reasoning = sum(rows.map(c => c.usage?.completion_tokens_details?.reasoning_tokens ?? c.usage?.reasoning_tokens ?? 0));
    return { model, calls: rows.length, reportedInputTokens: input, reportedOutputTokens: output,
      reportedReasoningTokens: reasoning, reservationUsd: money(rows.map(c => c.reservedUsd)),
      missingUsage: rows.filter(c => !c.usage || !(Number.isFinite(c.usage.prompt_tokens) || Number.isFinite(c.usage.input_tokens))).length,
      listPriceEstimateUsd: (input * inputPrice + output * outputPrice) / 1e6 };
  });
}

export function summarizeRouterHarness(report, ledger) {
  if (!report.complete || report.mode !== 'live') throw new Error('A completed live report is required');
  unique(report.calls, c => c.callId, 'call IDs');
  unique(report.runs, r => `${r.phase}:${r.profile}:${r.model}:${r.caseId}`, 'runs');
  unique(report.j1, r => r.id, 'J1 cases');
  unique(report.complexity, r => r.id, 'complexity cases');
  const entries = ledger.calls.filter(c => c.validation === report.experiment);
  unique(entries, c => c.callId, 'ledger IDs');
  const reserved = report.calls.filter(c => Number(c.reservedUsd) > 0);
  if (entries.length !== reserved.length || reserved.some(c => !entries.some(e => e.callId === c.callId
    && Number(e.reservedUsd) === Number(c.reservedUsd)))) throw new Error('Run and ledger reservations disagree');
  const profiles = [
    ['native-super', 'harness', 'native', 'super'], ['nanobot-super', 'harness', 'nanobot', 'super'],
    ['native-lightning', 'fixed', 'native', 'lightning'], ['native-glm', 'fixed', 'native', 'glm'],
    ['routed-native', 'routed', 'native', null],
  ].map(([id, phase, profile, model]) => {
    const rows = report.runs.filter(r => r.phase === phase && r.profile === profile && (!model || r.model === model));
    const calls = report.calls.filter(c => c.phase === phase && c.profile === profile && (!model || c.modelProfile === model));
    const routing = phase === 'routed' ? report.calls.filter(c => c.phase === 'complexity' && rows.some(r => r.caseId === c.caseId)) : [];
    const failures = {};
    for (const row of rows) for (const check of row.score?.failedChecks ?? []) failures[check] = (failures[check] ?? 0) + 1;
    return { id, cases: rows.length, expectedCases: 8, missingCaseIds: Array.from({ length: 8 }, (_, i) => `c0${i + 1}`).filter(id => !rows.some(r => r.caseId === id)),
      returnedAnswers: rows.filter(r => r.status === 'completed' && r.output?.trim()).length,
      strictPassed: rows.filter(r => r.score?.status === 'passed').length,
      strictFailed: rows.filter(r => r.score?.status === 'failed').length,
      incompleteObservations: rows.filter(r => !r.score || r.score.status === 'incomplete').length,
      noCompletedAnswer: rows.filter(r => r.status !== 'completed' || !r.output?.trim()).map(r => r.caseId),
      failedChecks: failures, generationCalls: calls.length, routingCalls: routing.length,
      reservationUsd: money([...calls, ...routing].map(c => c.reservedUsd)),
      providerMs: sum([...calls, ...routing].map(c => c.elapsedMs)),
      medianProviderPathMs: median(rows.map(r => (r.providerMs ?? 0) + sum(routing.filter(c => c.caseId === r.caseId).map(c => c.elapsedMs)))),
      simulatedToolCallbacks: sum(rows.map(r => r.execution?.tools?.length ?? 0)),
      sourceAndRestartRetained: rows.every(r => r.execution?.sourceRetained && r.restartRetained),
      casesByStrictScore: rows.map(r => ({ caseId: r.caseId, model: r.model, status: r.score?.status ?? 'incomplete', failedChecks: r.score?.failedChecks ?? [], providerCalls: r.providerCalls })),
    };
  });
  const labels = report.complexity.filter(r => r.measured === false), measured = report.complexity.filter(r => r.measured === true);
  const selected = {};
  for (const row of measured) { const key = row.selection?.model ?? row.selection?.action ?? 'missing'; selected[key] = (selected[key] ?? 0) + 1; }
  const start = report.j1.filter(r => r.expectedAction === 'start'), stop = report.j1.filter(r => r.expectedAction === 'end');
  const newReservation = money(entries.map(c => c.reservedUsd)), cumulative = money(ledger.calls.map(c => c.reservedUsd));
  if (newReservation > Number(report.budget.maximumReservationUsd) || cumulative > Number(report.budget.cumulativeCeilingUsd)) throw new Error('Budget exceeded');
  return { experiment: report.experiment, startedAt: report.startedAt, finishedAt: report.finishedAt,
    interpretation: 'Frozen strict scores, observed actions and measured costs only; no semantic answer regrading.',
    profiles, incompatibleHarnesses: report.compatibility.filter(c => c.status !== 'qualified'),
    j1: { cases: report.j1.length, labelMatches: report.j1.filter(r => r.labelMatches === true).length,
      actionMatches: report.j1.filter(r => r.actionMatches === true).length,
      intendedStarts: start.length, successfulIntendedStarts: start.filter(r => r.actionMatches).length,
      intendedStops: stop.length, successfulIntendedStops: stop.filter(r => r.actionMatches).length,
      incorrectStarts: report.j1.filter(r => r.incorrectStart).map(r => r.id), incorrectStops: report.j1.filter(r => r.incorrectStop).map(r => r.id),
      sourceAndRestartRetained: report.j1.every(r => r.sourceRetained && r.restartRetained),
      captures: sum(report.j1.map(r => r.captures ?? 0)), notesOnlyHonored: report.j1.every(r => r.notesOnlyHonored),
      medianProviderMs: median(report.calls.filter(c => c.phase === 'j1').map(c => c.elapsedMs)) },
    complexity: { classificationCases: labels.length, labelMatches: labels.filter(r => r.labelMatches === true).length,
      routedCases: measured.length, selections: selected, lowConfidenceFallbacks: measured.filter(r => r.selection?.uncertain).map(r => r.id),
      routingRestartRetained: report.routingRestartRetained },
    usage: usage(report.calls),
    provider: { calls: report.calls.length, succeeded: report.calls.filter(c => c.status === 'succeeded').length,
      failures: report.calls.filter(c => c.status !== 'succeeded').map(c => ({ callId: c.callId, status: c.status, error: c.error,
        finishReasons: c.rawResponse?.choices?.map(r => r.finish_reason) ?? [], reservedUsd: c.reservedUsd })),
      maximumSteps: Math.max(0, ...report.calls.map(c => c.step)), allCallsUnique: true },
    budget: { newReservedUsd: newReservation, cumulativeReservedUsd: cumulative, previousReservedUsd: money(ledger.calls.filter(c => c.validation !== report.experiment).map(c => c.reservedUsd)),
      calls: entries.length, cumulativeCalls: ledger.calls.length, previousCalls: ledger.calls.length - entries.length,
      runCapUsd: Number(report.budget.maximumReservationUsd), cumulativeCapUsd: Number(report.budget.cumulativeCeilingUsd),
      remainingHeadroomUsd: money([Number(report.budget.cumulativeCeilingUsd), -cumulative]), reservationsAreInvoices: false },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [reportPath, ledgerPath] = process.argv.slice(2);
  if (!reportPath || !ledgerPath) throw new Error('Usage: node scripts/summarize-router-harness.mjs report.json ledger.json');
  console.log(JSON.stringify(summarizeRouterHarness(JSON.parse(await readFile(reportPath)), JSON.parse(await readFile(ledgerPath))), null, 2));
}
