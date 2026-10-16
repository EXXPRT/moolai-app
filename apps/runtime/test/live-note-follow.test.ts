import test from "node:test";
import assert from "node:assert/strict";
import { initialLiveNoteFollow, liveNoteFollow, liveNotePreferenceEnabled } from "../../desktop/src/live-note-follow.js";

test("live-note following defaults on but never opens a historical first snapshot", () => {
  assert.equal(liveNotePreferenceEnabled(null), true);
  assert.equal(liveNotePreferenceEnabled("false"), false);
  let state = initialLiveNoteFollow();
  state = liveNoteFollow(state, { type: "observe", ready: false, key: "old:1" });
  assert.equal(state.initialized, false);
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "old:1" });
  assert.equal(state.target, undefined);
  assert.equal(state.selection, 0);
  assert.deepEqual(liveNoteFollow(state, { type: "observe", ready: true, key: "old:1" }), state);
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "old:2" });
  assert.equal(state.target, "old:2");
  assert.equal(state.selection, 1);
});

test("fresh provisional text follows after an initially empty session without creating a record", () => {
  let state = liveNoteFollow(initialLiveNoteFollow(), { type: "observe", ready: true });
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "session:preview:1" });
  assert.equal(state.target, "session:preview:1");
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "session:note:2" });
  assert.equal(state.target, "session:note:2");
  assert.equal(state.selection, 2);
});

test("manual navigation pauses across updates and topic changes until explicit resume", () => {
  let state = liveNoteFollow(initialLiveNoteFollow(), { type: "observe", ready: true });
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "first:1" });
  state = liveNoteFollow(state, { type: "pause" });
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "first:2" });
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "second:1" });
  assert.equal(state.target, "first:1");
  assert.equal(state.selection, 1);
  state = liveNoteFollow(state, { type: "resume", key: "second:1" });
  assert.equal(state.paused, false);
  assert.equal(state.target, "second:1");
  assert.equal(state.selection, 2);
});

test("disabling following does not stop observing source and re-enabling selects the latest preview", () => {
  let state = liveNoteFollow(initialLiveNoteFollow(), { type: "observe", ready: true });
  state = liveNoteFollow(state, { type: "enabled", value: false });
  state = liveNoteFollow(state, { type: "observe", ready: true, key: "new:4" });
  assert.equal(state.observed, "new:4");
  assert.equal(state.target, undefined);
  state = liveNoteFollow(state, { type: "enabled", value: true, key: "new:4" });
  assert.equal(state.target, "new:4");
  assert.equal(state.enabled, true);
});
