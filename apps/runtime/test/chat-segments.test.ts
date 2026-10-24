import test from "node:test";
import assert from "node:assert/strict";
import type { Segment } from "../../../packages/contracts/src/index.js";
import { chatSegments } from "../../desktop/src/chat-segments.js";

const lines = (...said: [Segment["speaker"], string][]): Segment[] =>
  said.map(([speaker, text], i) => ({ id: `s${i}`, turnId: `t${i}`, revision: 1, speaker, text, final: true, createdAt: "2026-10-24T01:00:00Z" }));

// Ian, 23-24 Oct: a sound or bare call Moo ignores is never shown in the chat; the session record still keeps it.
test("with no conversation open, the chat hides the user's sounds and bare calls, and shows every other line", () => {
  const segments = lines(["user", "Um."], ["user", "Moo."], ["user", "Okay Moo."], ["user", "Uh huh."], ["user", "Moo, wait."],
    ["assistant", "Moo."], ["assistant", "I’m here and listening."], ["user", " "]);
  assert.deepEqual(chatSegments({ kind: "session", segments }).map(s => s.text), ["Moo, wait.", "Moo.", "I’m here and listening."]);
  assert.deepEqual(chatSegments({ kind: "conversation", segments }).map(s => s.text),
    ["Um.", "Moo.", "Okay Moo.", "Uh huh.", "Moo, wait.", "Moo.", "I’m here and listening."], "A conversation holds only lines Moo acted on, and shows them all");
  assert.deepEqual(chatSegments(undefined), []);
});
