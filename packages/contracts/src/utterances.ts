/** Short-utterance tests, here so the desktop can share the Agent's idea of what is only a sound and what is a bare call. */
// "Uh huh" with a space or comma is read as "uh" then "huh". Listing those spellings as one word as well matched no more,
// but doubled the time to reject a looped "Uh huh. Uh huh. …" ending in a word for every pair (180 ms at 22 pairs).
const SOUND = String.raw`(?:hey\s+)?moo+|m+|mm+-?hm+|mhm+|hm+|uh+|um+|ah+|oh+|er+|erm+|huh|uh-?huh|eh|phew|whew|ahem`;
const BREAK = String.raw`[\s.,!?…]`;
const sounds = new RegExp(`^(?:${SOUND})(?:${BREAK}+(?:${SOUND}))*${BREAK}*$`, "i");
const CALL = String.raw`^(?:(?:um+|uh+|oh+|ah+|hm+|er+)${BREAK}+)?(?:(?:hey|hi|hello|ok(?:ay)?)[\s,]+)?moo+(?:${BREAK}+moo+)*`;
const bareCall = new RegExp(`${CALL}${BREAK}*$`, "i");
const callBeforeWords = new RegExp(`${CALL}${BREAK}+`, "i");

/** "Moo", "mm", "uh", "phew" and the like, alone or together: what clicks, breaths and echo turn into while Moo is speaking. */
export function fillerOnly(text: string) {
  return sounds.test(text.trim());
}
/** Only a call to Moo: "Moo.", "Hey, Moo.", "Okay Moo.", "Um, Moo?". */
export function wakeOnly(text: string) {
  return bareCall.test(text.trim());
}
/** A call to Moo, then words that are not only sounds: "Moo. Explain…", "Okay Moo, explain…". */
export function wakePrefixed(text: string) {
  const words = text.trim().replace(callBeforeWords, "");
  return words !== text.trim() && !!words && !fillerOnly(words);
}
