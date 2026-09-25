import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const source = new URL('../experiments/fixtures/agent-harness-cases.json', import.meta.url);
export const digest = value => createHash('sha256').update(value).digest('hex');

/** Read-only corpus loading. Paid runners freeze the returned hash before dispatch. */
export async function loadHarnessFixtures() {
  const bytes = await readFile(source);
  const cases = JSON.parse(bytes.toString());
  if (cases.version !== 1 || cases.experiment !== 'agent_harness_v1' || cases.syntheticOnly !== true
    || cases.confidenceThreshold !== 0.8 || cases.agentCases.length !== 8
    || cases.agentCases.map(c => c.id).join(',') !== 'h01,h02,h03,h04,h05,h06,h07,h08'
    || cases.agentRepeats.join(',') !== 'h01,h03')
    throw new Error('Unexpected harness corpus or threshold');
  const budget = cases.budget;
  const cents = Object.values(budget.models).reduce((sum, item) => sum + item.maxCalls * Math.round(Number(item.reservationUsd) * 100), 0);
  if (cents !== 992 || Number(budget.runUsd) !== 10 || Number(budget.cumulativeUsd) !== 25.87
    || budget.totalCalls !== 496 || budget.measuredCalls !== 480 || budget.compatibilityCalls !== 16
    || budget.maxGenerationCallsPerCase !== 6)
    throw new Error('Harness budget differs from the approved bounds');
  return { cases, casesSha256: digest(bytes) };
}

const stopwords = new Set('a an and are as at be both by can do does explain find for from had have how i in is it latest look me my no note notes of on only or our please proposed record saved search setup should show tell that the their them these this to use was were what which with would'.split(' '));
export function queryTokens(query) {
  return String(query).toLowerCase().match(/[a-z0-9]+/g)?.filter(token => token.length > 1 && !stopwords.has(token)) ?? [];
}

function noteView(note, excerptChars) {
  const original = note.text;
  const excerpt = excerptChars === undefined ? original : original.slice(0, excerptChars);
  return {
    id: note.id, revision: note.revision ?? 1, title: note.title,
    summary: excerpt, original: excerpt,
    truncated: excerpt.length < original.length,
    fullTextChars: original.length,
  };
}

/**
 * Simulated Brain tools only. Omit searchExcerptChars for the existing H0 view;
 * revised policies request 600. Reading a note always returns its full current text.
 * This helper never executes source instructions or accesses real records/network.
 */
export function harnessToolResult(call, validation, caseFixture, options = {}) {
  const excerptChars = options.searchExcerptChars;
  if (excerptChars !== undefined && (!Number.isInteger(excerptChars) || excerptChars < 1 || excerptChars > 2000))
    throw new Error('searchExcerptChars must be an integer from 1 to 2000');
  const base = { fixture: true, previewOnly: true, executed: false, allowed: validation.allowed };
  if (!validation.allowed) return { ...base, error: validation.reason ?? 'Tool blocked by controller' };
  const notes = caseFixture.providerInput.notes;
  if (call.name === 'search_notes') {
    const query = typeof call.arguments?.query === 'string' ? call.arguments.query.trim() : '';
    if (!query) return { ...base, allowed: false, error: 'search_notes requires a non-empty query; the search did not execute.' };
    if ((caseFixture.toolFixture.failureQueries ?? []).some(value => value.toLowerCase() === query.toLowerCase()))
      throw new Error('Fixture retrieval service unavailable; search was not completed.');
    const tokens = queryTokens(query);
    const scored = notes.map(note => {
      const searchable = new Set(`${note.title} ${note.text}`.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      return { note, score: tokens.filter(token => searchable.has(token)).length };
    }).filter(item => item.score > 0).sort((a, b) => b.score - a.score || a.note.id.localeCompare(b.note.id));
    return { ...base, query, results: scored.slice(0, 5).map(item => noteView(item.note, excerptChars)) };
  }
  if (call.name === 'read_note') {
    const note = notes.find(item => item.id === call.arguments?.id);
    return note ? { ...base, record: noteView(note) } : { ...base, record: null, error: 'No fixture record has this ID.' };
  }
  return { ...base, allowed: false, error: 'Only synthetic Brain reading and search are available in this experiment.' };
}

/** Reviewer metadata deliberately remains outside the provider-visible input. */
export function reviewPreparation(caseFixture) {
  return {
    caseId: caseFixture.id,
    scenario: caseFixture.scenario,
    request: caseFixture.providerInput.latestRequest,
    expected: structuredClone(caseFixture.expected),
    currentNotes: structuredClone(caseFixture.providerInput.notes),
    review: {
      primaryOutcome: null,
      explanation: null,
      supportedClaims: [],
      unsupportedClaims: [],
      constraintsHonored: null,
      citationsSupported: null,
      toolProposalsVersusObservedActions: null,
    },
  };
}
