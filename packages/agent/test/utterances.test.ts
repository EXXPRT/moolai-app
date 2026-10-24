import test from 'node:test';
import assert from 'node:assert/strict';
import {fillerOnly,wakeOnly,wakePrefixed} from '../../contracts/src/utterances.js';

test('a bare call is "Moo" after at most a hesitation and an opener; a filler is sounds alone; a request may start with a call', () => {
  for (const text of ['Moo.','Moo?','Hey Moo.','Hey, Moo.','Okay Moo.','OK Moo','Hi Moo.','Hello Moo.','Um, Moo.','Mooo.','Moo. Moo?'])
    assert.equal(wakeOnly(text), true, text);
  for (const text of ['Moo, stop.','Moo, are you there?','Mu.','Okay.','Moodle.','Moo. Phew.'])
    assert.equal(wakeOnly(text), false, text);
  for (const text of ['Moo.','Hey Moo.','Mm-hm.','Mm hmm.','Uh huh.','Uh-huh.','Uh, huh.','Hm.','Phew.','Whew.','Ahem.','Moo. Phew.','Oh, um.'])
    assert.equal(fillerOnly(text), true, text);
  for (const text of ['Yes.','No.','Okay.','Stop.','Wait.','Mu.','Okay Moo.','Hey, Moo.','Uh huh, yes.'])
    assert.equal(fillerOnly(text), false, text);
  for (const text of ['Moo. I explain how the conveyor belt works in detail.','Okay Moo, explain osmosis.','Hey, Moo, what is ATP?'])
    assert.equal(wakePrefixed(text), true, text);
  for (const text of ['Moo.','Hey, Moo.','Moo, um.','Moo. Phew.','Explain osmosis.','Moodle is open.'])
    assert.equal(wakePrefixed(text), false, text);
});

test('a looped "uh huh" that ends in a word is told from a filler at once', () => {
  const started = performance.now();
  assert.equal(fillerOnly('Uh huh. '.repeat(24) + 'Thank you.'), false);
  assert.ok(performance.now() - started < 100, 'Each pair must not double the work');
});
