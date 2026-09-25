import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const directory = new URL('../experiments/fixtures/', import.meta.url);
export const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Load the independent experiment corpus and verify every prepared image byte. */
export async function loadReliabilityFixtures() {
  const raw = await readFile(new URL('agent-reliability-cases.json', directory));
  const cases = JSON.parse(raw.toString());
  if (cases.version !== 1 || !cases.syntheticOnly || cases.confidenceThreshold !== 0.8
    || cases.agentCases.length !== 8 || cases.j7Cases.length !== 12)
    throw new Error('Unexpected reliability corpus or threshold');
  const reservedCents = Object.values(cases.budget.methods).reduce(
    (sum, item) => sum + item.maxCalls * Math.round(Number(item.reservationUsd) * 100), 0);
  if (reservedCents !== 684 || Number(cases.budget.runUsd) !== 7 || Number(cases.budget.cumulativeUsd) !== 20)
    throw new Error('Reliability budget differs from the approved bounds');
  const manifestRaw = await readFile(new URL('agent-reliability-ocr/manifest.json', directory));
  const manifest = JSON.parse(manifestRaw.toString());
  if (manifest.version !== 1 || !manifest.syntheticOnly || manifest.fixtures.length !== 6)
    throw new Error('Six synthetic OCR fixtures are required');
  const images = [];
  for (const item of manifest.fixtures) {
    if (!/^\d{2}\.png$/.test(item.image)) throw new Error('Invalid image fixture path');
    const bytes = await readFile(new URL(`agent-reliability-ocr/${item.image}`, directory));
    if (bytes.length > 500_000 || bytes.length !== item.bytes || digest(bytes) !== item.sha256
      || bytes.subarray(1, 4).toString() !== 'PNG' || bytes.readUInt32BE(16) !== 1280 || bytes.readUInt32BE(20) !== 900)
      throw new Error(`Changed OCR fixture: ${item.id}`);
    images.push({ ...item, bytes });
  }
  return { cases, casesSha256: digest(raw), manifest, manifestSha256: digest(manifestRaw), images };
}

const stopwords = new Set('a an and are as at be both by can do does explain find for from had have how i in is it latest look me my no note notes of on only or our please proposed record saved search setup should show tell that the their them these this to use was were what which with would'.split(' '));
export function queryTokens(query) {
  return String(query).toLowerCase().match(/[a-z0-9]+/g)?.filter((token) => token.length > 1 && !stopwords.has(token)) ?? [];
}
function noteView(note) {
  const original = note.text ?? note.original ?? note.segments?.map((segment) => segment.text).join('\n') ?? '';
  return { id: note.id, revision: note.revision ?? 1, title: note.title, summary: note.summary ?? original, original };
}

/** Query-sensitive simulated tools. This function never reads or changes real Brain data. */
export function fixtureToolResult(call, validation, caseFixture) {
  const base = { fixture: true, previewOnly: true, executed: false, allowed: validation.allowed };
  if (!validation.allowed) return { ...base, error: validation.reason ?? 'Tool blocked by controller' };
  const notes = caseFixture.providerInput.notes;
  if (call.name === 'search_notes') {
    const query = typeof call.arguments?.query === 'string' ? call.arguments.query.trim() : '';
    if (!query) return { ...base, allowed: false, error: 'search_notes requires a non-empty query; the search did not execute.' };
    if ((caseFixture.toolFixture.failureQueries ?? []).some((value) => value.toLowerCase() === query.toLowerCase()))
      throw new Error('Fixture retrieval service unavailable; search was not completed.');
    const tokens = queryTokens(query);
    const scored = notes.map((note) => {
      const view = noteView(note);
      const searchable = new Set(`${view.title} ${view.original}`.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      return { view, score: tokens.filter((token) => searchable.has(token)).length };
    }).filter((item) => item.score > 0).sort((a, b) => b.score - a.score || a.view.id.localeCompare(b.view.id));
    return { ...base, query, results: scored.slice(0, 5).map((item) => item.view) };
  }
  if (call.name === 'read_note') {
    const found = notes.find((note) => note.id === call.arguments?.id);
    return found ? { ...base, record: noteView(found) } : { ...base, record: null, error: 'No fixture record has this ID.' };
  }
  return { ...base, allowed: false, error: 'Only synthetic Brain reading and search are available in this experiment.' };
}

function parse(raw) {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw;
  if (typeof raw !== 'string') return null;
  try {
    const result = JSON.parse(raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    return result && typeof result === 'object' && !Array.isArray(result) ? result : null;
  } catch { return null; }
}
function isJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJson);
  return value && typeof value === 'object' && Object.values(value).every(isJson);
}

/** Preserve raw evidence and separately expose usable observations; never invent a hidden value. */
export function normalizeOcr(raw, requestedFields = []) {
  const parsed = parse(raw);
  const issues = [];
  const issue = (code, field = null) => issues.push({ code, field });
  const result = { raw, parsed, observations: [], interpretations: [], issues, valid: false };
  if (!parsed) { issue('invalid_json_object'); return result; }
  for (const key of Object.keys(parsed)) if (!['observations', 'interpretations'].includes(key)) issue('unexpected_top_level_key', key);
  if (!Array.isArray(parsed.observations)) issue('observations_not_array');
  const seen = new Set();
  for (const item of Array.isArray(parsed.observations) ? parsed.observations : []) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || typeof item.field !== 'string' || !item.field.trim()) {
      issue('invalid_observation'); continue;
    }
    const field = item.field;
    for (const key of Object.keys(item)) if (!['field', 'value', 'status'].includes(key)) issue('unexpected_observation_key', field);
    if (seen.has(field)) {
      issue('duplicate_field', field);
      const previous = result.observations.find((entry) => entry.field === field);
      if (previous) { previous.status = 'unreadable'; previous.value = null; }
      continue;
    }
    seen.add(field);
    let status = item.status;
    let value = item.value;
    if (requestedFields.length && !requestedFields.includes(field)) issue('unexpected_field', field);
    if (!['readable', 'unreadable', 'absent'].includes(status)) { issue('invalid_status', field); status = 'unreadable'; value = null; }
    if (!Object.hasOwn(item, 'value') || !isJson(value)) { issue('invalid_value', field); status = 'unreadable'; value = null; }
    if (status === 'readable' && (value === null || value === '')) { issue('readable_without_value', field); status = 'unreadable'; value = null; }
    if (status !== 'readable' && value !== null) { issue('unusable_value_present', field); value = null; }
    result.observations.push({ field, value, status });
  }
  for (const field of requestedFields) if (!seen.has(field)) {
    issue('missing_field', field);
    result.observations.push({ field, value: null, status: 'unreadable' });
  }
  if (!Array.isArray(parsed.interpretations) || parsed.interpretations.some((value) => typeof value !== 'string')) issue('invalid_interpretations');
  else result.interpretations = [...parsed.interpretations];
  result.valid = issues.length === 0;
  return result;
}

function canonical(value) {
  if (typeof value === 'string') return value.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, entry]) => [key, canonical(entry)]));
  return value;
}
function equivalent(expected, actual, match) {
  let a = canonical(expected); let b = canonical(actual);
  if (match === 'unordered') {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    a = a.map((value) => JSON.stringify(value)).sort(); b = b.map((value) => JSON.stringify(value)).sort();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}
function fieldChecks(expected, actual) {
  const observations = Array.isArray(actual?.observations) ? actual.observations : [];
  const checks = { jsonObject: !!actual, observationSet: observations.length === expected.observations.length && new Set(observations.map((item) => item?.field)).size === expected.observations.length };
  for (const wanted of expected.observations) {
    const found = observations.filter((item) => item?.field === wanted.field);
    checks[`${wanted.field}.status`] = found.length === 1 && found[0].status === wanted.status;
    checks[`${wanted.field}.value`] = found.length === 1 && equivalent(wanted.value, found[0].value, wanted.match);
  }
  return checks;
}

/** Raw accuracy and consumer safety are separate scores; validation is not a model correction. */
export function scoreOcr(expected, raw) {
  const normalized = normalizeOcr(raw, expected.observations.map((item) => item.field));
  return {
    raw: { checks: fieldChecks(expected, normalized.parsed), parsed: normalized.parsed },
    validated: { checks: fieldChecks(expected, normalized.parsed ? normalized : null), observations: normalized.observations },
    issues: normalized.issues,
    normalized,
  };
}
