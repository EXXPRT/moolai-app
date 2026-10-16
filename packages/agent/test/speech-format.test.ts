import test from 'node:test';
import assert from 'node:assert/strict';
import { plainSpeech, spokenAnswer, narratePoints } from '../src/response-output.js';
import { speechSections } from '../src/speech-markdown.js';

test('playback explains clear process arrows, including formatted step labels', () => {
  assert.equal(plainSpeech('**Review** → **revise** → save.'), 'Review, then revise, then save.');
  assert.equal(plainSpeech('1. Prepare → 2. Measure → 3. Review'), 'Prepare, then 2. Measure, then 3. Review');
  assert.equal(plainSpeech('The result remains uncertain; review → revise is only proposed.'),
    'The result remains uncertain; review, then revise is only proposed.');
});

test('calendar dates and date ranges have natural spoken forms without guessing locale', () => {
  assert.equal(plainSpeech('The latest discussion was on 2026-10-09.'),
    'The latest discussion was on the ninth of October, twenty twenty-six.');
  assert.equal(plainSpeech('From 2026-10-02 → 2026-10-09, no additional result was found.'),
    'From the second of October, twenty twenty-six to the ninth of October, twenty twenty-six, no additional result was found.');
  assert.equal(plainSpeech('2024-02-29–2024-03-01'),
    'the twenty-ninth of February, twenty twenty-four to the first of March, twenty twenty-four');
  assert.equal(plainSpeech('2001-01-01 and 1999-12-31'),
    'the first of January, two thousand and one and the thirty-first of December, nineteen ninety-nine');
  assert.equal(plainSpeech('02/03/26, 2026-02-29 and 2026-13-01 are unverified.'),
    '02/03/26, 2026-02-29 and 2026-13-01 are unverified.');
});

test('only recognised numeric unit rates expand slashes to per', () => {
  assert.equal(plainSpeech('Approximately 2.5 kg/day, not 5 kg/day. The rate is 1 m/s.'),
    'Approximately 2.5 kilograms per day, not 5 kilograms per day. The rate is 1 metre per second.');
  assert.equal(plainSpeech('The stated value is 3 mg/kg; 12 mL/min is still uncertain.'),
    'The stated value is 3 milligrams per kilogram; 12 millilitres per minute is still uncertain.');
  assert.equal(plainSpeech('input/output, help/review, and/or, kg/day, 1/2 and 3/4 remain as written.'),
    'input/output, help/review, and/or, kg/day, 1/2 and 3/4 remain as written.');
});

test('math, source identifiers, paths and timestamp strings are not reinterpreted', () => {
  const source = 'x → y; A → B; x → 0; f(x) → 1. >90% remains approximate; x >= 12 and y < 5. '
    + 'batch_2026-10-09, release-2026-10-09, /notes/2026-10-09.md, 2026-10-09.json, '
    + 'C:/notes/2026-10-09.md, 2026-10-09T12:30:00Z, values/3mg/kg and rate/1m/s.';
  assert.equal(plainSpeech(source), source);
});

test('inline code remains literal while adjacent prose gets spoken formatting', () => {
  assert.equal(plainSpeech('Use `review → revise`, `2026-10-09`, `3mg/kg` and `$&`. Review → revise.'),
    'Use review → revise, 2026-10-09, 3mg/kg and $&. Review, then revise.');
  assert.equal(plainSpeech('\uE000speech0\uE001 is literal; `2026-10-09` remains literal.'),
    '\uE000speech0\uE001 is literal; 2026-10-09 remains literal.');
});

test('structured narration, full narration and plain replies use the same speech-only formatter', () => {
  const text = '**Timing**\n\nThe recorded date is 2026-10-09.\n\n**Procedure**\n\nReview → revise → save; this has not been done.';
  const reply = {text, toolCalls: [], spokenOutline: {overview: 'Two parts.', points: [
    {label: 'Timing', explanation: 'The recorded date is 2026-10-09.', sourceSections: [1]},
    {label: 'Procedure', explanation: 'Review → revise → save; this has not been done.', sourceSections: [2]},
  ]}};
  const unchanged = JSON.stringify(reply);
  assert.equal(spokenAnswer(reply, 'Walk me through the points'),
    '1. Timing. The recorded date is the ninth of October, twenty twenty-six. 2. Procedure. Review, then revise, then save; this has not been done.');
  assert.match(spokenAnswer(reply, 'Read the whole answer in full'), /the ninth of October.*Review, then revise, then save; this has not been done/);
  assert.equal(spokenAnswer({text: '1 m/s is only an estimate.', toolCalls: []}), '1 metre per second is only an estimate.');
  assert.equal(narratePoints(reply.spokenOutline, 1), '2. Procedure. Review, then revise, then save; this has not been done.');
  assert.equal(JSON.stringify(reply), unchanged, 'The written answer and stored outline remain unmodified');
  assert.equal(speechSections(text)[0]!.explanation, 'The recorded date is 2026-10-09.', 'Structural analysis retains original facts');
});
