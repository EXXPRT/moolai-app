import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const directory = new URL('../experiments/fixtures/', import.meta.url);
export const digest = (value) => createHash('sha256').update(value).digest('hex');

/** Load the reviewed phrases and image bytes without network or device access. */
export async function loadWorkflowFixtures() {
  const raw = await readFile(new URL('full-workflow-cases.json', directory));
  const cases = JSON.parse(raw.toString());
  if (cases.version !== 1 || cases.syntheticOnly !== true || cases.confidenceThreshold !== 0.8)
    throw new Error('Unreviewed workflow fixture format or threshold');
  const reservedCents = Object.values(cases.budget.methods).reduce(
    (sum, item) => sum + item.maxCalls * Math.round(Number(item.reservationUsd) * 100), 0);
  if (reservedCents !== 250 || Number(cases.budget.runUsd) !== 2.5 || Number(cases.budget.cumulativeUsd) !== 15)
    throw new Error('Workflow reservation limits do not match the approved plan');
  const manifestRaw = await readFile(new URL('full-workflow-ocr/manifest.json', directory));
  const manifest = JSON.parse(manifestRaw.toString());
  if (!manifest.syntheticOnly || manifest.fixtures.length !== 3)
    throw new Error('Exactly three synthetic OCR fixtures are required');
  const images = [];
  for (const item of manifest.fixtures) {
    if (!/^[a-z0-9-]+\.png$/.test(item.image)) throw new Error('Invalid fixture image path');
    const bytes = await readFile(new URL(`full-workflow-ocr/${item.image}`, directory));
    if (bytes.length > 500_000 || bytes.length !== item.bytes || digest(bytes) !== item.sha256)
      throw new Error(`Changed OCR fixture: ${item.id}`);
    images.push({ ...item, bytes });
  }
  return { cases, casesSha256: digest(raw), manifestSha256: digest(manifestRaw), images };
}

function canonical(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().replace(/\.$/, '').toLocaleLowerCase('en')
    : value;
}

function same(expected, actual) {
  if (expected === null || typeof expected === 'boolean' || typeof expected === 'number')
    return actual === expected;
  if (typeof expected === 'string') return canonical(expected) === canonical(actual);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((v, i) => same(v, actual[i]));
  return actual && typeof actual === 'object' && !Array.isArray(actual) && Object.entries(expected).every(([key, value]) => same(value, actual[key]));
}

/** Strict field checks. Null unreadable values are not interchangeable with guessed strings. */
export function scoreOcr(expected, text) {
  let parsed;
  try {
    parsed = JSON.parse(text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('object required');
  } catch {
    return { checks: { jsonObject: false }, parsed: null };
  }
  const checks = { jsonObject: true };
  for (const [key, value] of Object.entries(expected)) {
    const actual = parsed[key];
    if (key === 'equation_ascii') {
      const normalize = (s) => String(s).normalize('NFKC').replace(/[\s*_{}\\]/g, '');
      checks[key] = normalize(value) === normalize(actual);
    } else if (key === 'edges') {
      const normalize = (edges) => edges.map((edge) => edge.map(canonical).join('>')).sort();
      checks[key] = Array.isArray(actual) && actual.every((edge) => Array.isArray(edge) && edge.length === 2)
        && same(normalize(value), normalize(actual));
    } else if (key === 'rows') {
      const sort = (rows) => [...rows].sort((a, b) => String(a.trial).localeCompare(String(b.trial)));
      checks[key] = Array.isArray(actual) && same(sort(value), sort(actual));
    } else checks[key] = Boolean(same(value, actual));
  }
  return { checks, parsed };
}

export function fixtureToolResult(call, validation, seed, preparedEvidence) {
  const base = { previewOnly: true, executed: false, allowed: validation.allowed };
  if (!validation.allowed) return { ...base, error: validation.reason ?? 'Tool blocked by controller' };
  if (call.name === 'search_notes') return { ...base, fixture: 'synthetic saved-note search', results: [seed] };
  if (call.name === 'read_note') return { ...base, fixture: 'synthetic saved-note read', record: seed };
  if (call.name === 'search_web') return { ...base, fixture: 'synthetic web search', results: [
    { url: 'https://example.org/synthetic-shade-reference', title: 'Synthetic shade reference', content: 'Fixture only: light exposure can affect plant growth; no research was performed.' },
  ] };
  if (call.name === 'extract_web') return { ...base, fixture: 'synthetic extraction', results: [] };
  if (call.name === 'capture_screen') return { ...base, fixture: 'prepared synthetic screenshot evidence; no fresh capture', text: preparedEvidence ?? 'Prepared synthetic fixture; OCR not requested in this path.' };
  if (call.name === 'create_note') return { ...base, saved: false, proposed: { title: call.arguments.title, text: call.arguments.text } };
  return { ...base, error: 'No reviewed fixture for this tool' };
}
