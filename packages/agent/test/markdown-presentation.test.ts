import test from 'node:test';
import assert from 'node:assert/strict';
import {presentMarkdown} from '../../contracts/src/markdown-presentation.js';
import {nonAnswerReason} from '../src/answer-validation.js';
import {speechSections} from '../src/speech-markdown.js';
import {plainSpeech, spokenAnswer} from '../src/response-output.js';

test('legacy line breaks retain factual section bodies consistently for admission, rendering and narration',()=> {
  const source='## Measurement<br>The volume was 12 ml, not 21 ml.<br><br>## Limits<BR />The calibration remains uncertain.';
  const normalized=presentMarkdown(source);
  assert.equal(normalized,'## Measurement\nThe volume was 12 ml, not 21 ml.\n\n## Limits\nThe calibration remains uncertain.');
  const reply={text:source,spokenText:'The volume was 12 ml, with calibration still uncertain.',toolCalls:[]};
  assert.equal(nonAnswerReason(reply,'Explain the measurement and its limits.'),undefined);
  assert.deepEqual(speechSections(source).map(section=>section.label),['Measurement','Limits']);
  assert.match(plainSpeech(source),/12 ml, not 21 ml.*calibration remains uncertain/);
  assert.equal(spokenAnswer(reply),reply.spokenText);
  assert.equal(reply.text,source,'The provider response and retained source are not rewritten');
});

test('literal code, quoted HTML and escaped syntax stay exact',()=> {
  for(const source of ['Use `<br>` in this example.','```html\nHeading<br>Body\n```','    <br>\n',
    '> The source prints <br> literally.','The text says "<br>".','The text says “<br>”.','The tag \'<br>\' is literal.',String.raw`The escaped tag is \<br>.`])
    assert.equal(presentMarkdown(source),source,source);
  assert.equal(presentMarkdown('Use `<br>` literally.<br>Continue here.'),'Use `<br>` literally.\nContinue here.');
});

test('table-cell breaks preserve complete rows and other HTML remains disabled source',()=> {
  const table='| Field | Value |\n| --- | --- |\n| Volume<br>measured | 12 ml |';
  assert.equal(presentMarkdown(table),'| Field | Value |\n| --- | --- |\n| Volume measured | 12 ml |');
  assert.match(plainSpeech(table),/Volume measured.*12 ml/);
  assert.equal(presentMarkdown('A<br onclick="run()">B<script>run()</script>'),'A<br onclick="run()">B<script>run()</script>');
});

test('presentation normalization does not accept genuinely empty headings or protocol replies',()=> {
  assert.equal(nonAnswerReason({text:'## Results<br><br>## Limits',toolCalls:[]},'Compare the measurements.'),'heading_only');
  assert.equal(nonAnswerReason({text:'<function><name>read_note</name></function>',toolCalls:[]},'Explain the result.'),'protocol_only');
});
