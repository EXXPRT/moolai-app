import test from 'node:test';
import assert from 'node:assert/strict';
import { plainSpeech, speechOutline, spokenAnswer, narrationDecision } from '../src/response-output.js';
import { speechSections } from '../src/speech-markdown.js';
import { resolveNoteReferences } from '../src/references.js';
import type { SpokenOutline } from '../../contracts/src/index.js';

// Synthetic regression: preserve the document structure, never private discussion text.
const document = `### Workshop review

**Measurements**

- Temperature: observed, not predicted.
- Quantity: >90% of the initial sample, approximately 12 ml.

**Equipment**

| Device | Limitation |
| --- | --- |
| Meter | Requires calibration |
| Balance | Uncertainty remains |

**Preparation**

1. Separate observation from prediction.
2. Label every container before filling.
3. Record uncertainties.
4. Check the instruments.
5. Ask for a second review.

**Open questions**

- Does the temperature affect the reading?
- The direction of change is still unknown.

**Procedure**

1. Prepare → 2. Measure → 3. Review

**Next step**: Choose an instrument; this has not been done.`;

const outline: SpokenOutline = {overview: 'Five parts of the workshop review.', points: [
  {label: 'Measurements', explanation: 'We observed approximately 12 ml, more than 90% of the sample; these are observations, not predictions.', sourceSections: [1]},
  {label: 'Equipment', explanation: 'The meter requires calibration, and balance uncertainty remains.', sourceSections: [2]},
  {label: 'Preparation', explanation: 'Separate predictions from observations, label containers, retain uncertainty, check instruments and request review.', sourceSections: [3]},
  {label: 'Open questions', explanation: 'The temperature effect and direction of change remain unknown.', sourceSections: [4]},
  {label: 'Procedure', explanation: 'Prepare, measure and review; choosing an instrument is still the next step.', sourceSections: [5]},
]};

test('requested walkthroughs cover every concise explanation; diagnostics distinguish missing and invalid coverage', () => {
  const longText = document.replace('Requires calibration', 'Requires calibration. '.repeat(100));
  const complete = {text: longText, spokenOutline: outline, toolCalls: []};
  for (const point of outline.points) assert.ok(spokenAnswer(complete, 'Walk me through the points').includes(point.explanation));
  assert.doesNotMatch(spokenAnswer(complete, 'Walk me through the points'), /too long|could not prepare|full explanation is on screen/i);
  assert.equal(narrationDecision(complete, 'Walk me through the points').mode, 'outline');
  assert.equal(narrationDecision({text: longText, toolCalls: []}, 'Walk me through the points').reason, 'outline_missing');
  assert.equal(narrationDecision({...complete, spokenOutline: {...outline, points: outline.points.slice(1)}}, 'Walk me through the points').reason, 'section_coverage_invalid');
  assert.equal(narrationDecision({text: 'A short supported result.', toolCalls: []}).mode, 'prose');
  assert.equal(narrationDecision(complete, 'Read the whole answer in full').mode, 'full');
  assert.ok(!JSON.stringify(narrationDecision(complete)).includes('calibration'), 'Diagnostics retain counts and reason codes, not answer content');
});

test('mixed bold sections, table, numbered and nested bullets map to all five main sections', () => {
  const sections = speechSections(document);
  assert.deepEqual(sections.map(section => section.label), outline.points.map(point => point.label));
  assert.match(sections[0]!.explanation, />90%.*approximately 12 ml/);
  assert.match(sections[1]!.explanation, /Meter: Limitation: Requires calibration.*Balance.*Uncertainty remains/);
  assert.match(sections[2]!.explanation, /Separate observation.*second review/);
  assert.match(sections[4]!.explanation, /Prepare.*Review.*Next step.*not been done/);
  assert.deepEqual(speechOutline({text: document, spokenOutline: outline, toolCalls: []}), outline);
  assert.deepEqual(resolveNoteReferences({text: document, spokenOutline: outline, toolCalls: []}, []).spokenOutline, outline);
  const spoken = spokenAnswer({text: document, spokenOutline: outline, toolCalls: []}, 'Walk me through the points');
  for (const point of outline.points) assert.ok(spoken.includes(point.explanation));
  assert.doesNotMatch(spoken, /walk through|Shall I continue/);
});

test('a section owns nested headings and supporting lists instead of multiplying points', () => {
  const sections = speechSections('# Review\n## Tools\n### Read\n- Current notes\n  - Include corrections\n\n**Permissions**\n\nSelected folders only.\n### Search\n- Match the question\n## Limits\nUse only the notes.');
  assert.deepEqual(sections.map(section => section.label), ['Tools', 'Limits']);
  assert.match(sections[0]!.explanation, /Read.*Current notes.*Include corrections.*Permissions.*Selected folders.*Search.*Match the question/);
  assert.deepEqual(speechSections('**Workshop review**\n\n**Measurements**\n\nMeasure uncertainty.\n\n**Procedure**\n\nMeasure then review.').map(section => section.label), ['Measurements', 'Procedure']);
});

test('coverage references reject omitted, duplicate, out-of-order and fabricated sections even with equal point counts', () => {
  for (const refs of [[1, 2, 3, 4, 4], [1, 2, 3, 4, 6], [2, 1, 3, 4, 5]]) {
    const invalid = {...outline, points: outline.points.map((point, i) => ({...point, explanation: 'Invalid supplied explanation.', sourceSections: [refs[i]!]}))};
    const spoken = spokenAnswer({text: document, spokenOutline: invalid, toolCalls: []}, 'Walk me through the points');
    assert.doesNotMatch(spoken, /Invalid supplied explanation/);
    assert.match(spoken, /Temperature.*Meter.*Separate observation.*Open questions.*Next step/);
  }
  const sixIrrelevantPoints = {...outline, points: Array.from({length: 6}, (_, i) => ({label: `Unrelated ${i}`, explanation: 'Wrong point.'}))};
  assert.doesNotMatch(spokenAnswer({text: document, spokenOutline: sixIrrelevantPoints, toolCalls: []}), /Wrong point|walk through/);
  const collapsed = {overview: 'All five.', points: [{label: 'Everything', explanation: 'An incomplete explanation.', sourceSections: [1, 2, 3, 4, 5]}]};
  assert.doesNotMatch(spokenAnswer({text: document, spokenOutline: collapsed, toolCalls: []}), /An incomplete explanation/);
});

test('legacy title-matched outlines remain compatible; long unvalidated sections offer full narration explicitly', () => {
  const legacy = {...outline, points: outline.points.map(({sourceSections: _ignored, ...point}) => point)};
  assert.equal(speechOutline({text: document, spokenOutline: legacy, toolCalls: []})!.points[4]!.explanation, outline.points[4]!.explanation);
  const longDocument = document.replace('Requires calibration', 'Requires calibration. '.repeat(100));
  const partial = {...outline, points: outline.points.slice(2)};
  assert.equal(speechOutline({text: longDocument, spokenOutline: partial, toolCalls: []}), undefined);
  const reply = {text: longDocument, spokenOutline: partial, spokenText: 'Measurements remain uncertain; preparation and follow-up work are still pending.', toolCalls: []};
  assert.equal(spokenAnswer(reply), reply.spokenText, 'Optional outline coverage cannot veto the spoken summary');
  const spoken = spokenAnswer(reply, 'Walk me through the points');
  assert.match(spoken, /could not prepare a complete brief walkthrough.*read it in full/);
  assert.doesNotMatch(spoken, /Only preparation|Requires calibration/);
  assert.match(spokenAnswer({text: longDocument, toolCalls: []}, 'Read the whole answer in full'), /Requires calibration/);
});

test('Markdown speech preserves comparisons, identifiers, qualifications and readable link labels', () => {
  assert.equal(plainSpeech('>90% is approximate; x >= 12, y < 5 and batch_A remain unverified.'), '>90% is approximate; x >= 12, y < 5 and batch_A remain unverified.');
  assert.equal(plainSpeech('> -5 °C\n\n> .5 percent'), '> -5 °C > .5 percent');
  assert.equal(plainSpeech('**Not completed**. [Source](https://example.test). `batch_A`.'), 'Not completed. Source. batch_A.');
  assert.equal(plainSpeech('> A reported claim, not a verified result.'), 'A reported claim, not a verified result.');
  assert.equal(plainSpeech('not  \nconfirmed'), 'not confirmed');
  assert.equal(plainSpeech('The planned count is 12\\\nnot 21.'), 'The planned count is 12 not 21.');
});

test('six section walkthroughs speak five points and offer continuation only when requested', () => {
  const text = document + '\n\n**Follow-up**\nFurther measurement is pending.';
  const supplied = {...outline, points: [...outline.points, {label: 'Follow-up', explanation: 'Further measurement is pending.', sourceSections: [6]}]};
  assert.equal(speechOutline({text, spokenOutline: supplied, toolCalls: []})!.points.length, 6);
  const reply = {text, spokenOutline: supplied, spokenText: 'Measurements, equipment and procedure need review; further measurement remains pending.', toolCalls: []};
  assert.equal(spokenAnswer(reply), reply.spokenText);
  assert.match(spokenAnswer(reply, 'Walk me through the sections'), /approximately 12 ml.*next points/);
  assert.doesNotMatch(spokenAnswer(reply, 'Walk me through the sections'), /Further measurement is pending/);
});

test('a valid spoken paragraph remains usable when a table outline omits a row', () => {
  const reply = {text: 'These are identifiers, not encoded digits.\n\n| Code | Meaning |\n| --- | --- |\n| 1424 | Sign-in succeeded |\n| 1740 | Account locked |\n| 2036 | Service changed state |\n\nThe numbers do not imply a universal digit pattern.',
    spokenText: 'These event numbers identify particular event definitions; their individual digits do not form a universal code. Examples distinguish successful sign-in, a locked account and a changed service state.',
    spokenOutline: {overview: 'Event identifiers.', points: [
      {label: 'Sign-in', explanation: 'Sign-in succeeded.', sourceSections: [1]},
      {label: 'Account', explanation: 'The account was locked.', sourceSections: [2]},
    ]}, toolCalls: []};
  assert.equal(spokenAnswer(reply), reply.spokenText);
  assert.equal(narrationDecision(reply).mode, 'summary');
  assert.match(spokenAnswer({...reply, spokenText: undefined, narrationError: 'missing_spoken_summary'}), /spoken summary is unavailable/);
  assert.match(spokenAnswer({...reply, spokenText: 'x'.repeat(1201)}), /spoken summary is unavailable/);
  assert.equal(spokenAnswer({...reply, spokenText: ''}), 'The answer is on screen, but its spoken summary is unavailable. You can ask me to read it in full.');
});
