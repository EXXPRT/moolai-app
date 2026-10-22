import test from "node:test";
import assert from "node:assert/strict";
import { clearAcknowledgedDraft, actionMessage, connectionAfterRefresh, processingMessage, readableNotice, stopControl } from "../../desktop/src/feedback.js";

test("successful refresh clears a disconnected state without claiming failed processing succeeded", () => {
  assert.equal(connectionAfterRefresh(false), "disconnected");
  assert.equal(connectionAfterRefresh(true), "connected");
  assert.match(processingMessage(false, true)!, /saved locally/);
  assert.equal(processingMessage(true, true), undefined);
});
test("only acknowledged submissions receive a saved-text claim", () => {
  assert.ok(!processingMessage(false, false)!.includes("Your text is saved"));
  assert.match(actionMessage(new Error("fetch failed"), "/api/input"), /could not be confirmed as saved/);
  assert.match(actionMessage(new Error("Backend 502: secret diagnostic"), "/api/retry"), /original text/);
  assert.ok(!actionMessage(new Error("Backend 502"), "/api/retry").includes("502"));
});
test("reader notices replace operational details without changing ordinary conversation prompts", () => {
  assert.equal(readableNotice("TypeError: fetch failed"), undefined);
  assert.equal(readableNotice("Source saved; enrichment pending: Backend 502: incomplete output"), "Your text is saved. The summary could not finish; you can retry it.");
  assert.equal(readableNotice("Would you like Moo to answer that?"), "Would you like Moo to answer that?");
  // A line Moo cut short with its own next line, such as "I'm listening…" after a reply to the screen offer.
  assert.equal(readableNotice("Speech superseded"), undefined);
  assert.match(actionMessage("Record changed; reload before editing", "/api/record/example"), /Reopen/);
});

test("a delayed save acknowledgement cannot erase text typed while waiting", () => {
  assert.equal(clearAcknowledgedDraft("New thought", "Sent thought"), "New thought");
  assert.equal(clearAcknowledgedDraft("Sent thought", "Sent thought"), "");
});

test('voice errors distinguish local recognition availability from microphone permission',()=>{
  assert.match(actionMessage('Local speech recognition is unavailable','/api/voice'),/ASR service/);
  assert.match(actionMessage('Microphone permission is required','/api/voice'),/permission/);
});
test("Stop ends playback while Moo speaks and cancels only a response being prepared", () => {
  assert.deepEqual(stopControl(true, true), { label: "Stop speech", path: "/api/speech/stop" });
  assert.deepEqual(stopControl(true, false), { label: "Stop speech", path: "/api/speech/stop" });
  assert.deepEqual(stopControl(false, true), { label: "Stop response", path: "/api/response/cancel" });
  assert.equal(stopControl(false, false), undefined);
});
test("typed input that was saved but not acted on says it was saved", () => {
  assert.equal(actionMessage(new Error("Saved; Moo couldn't act on it: Backend 503"), "/api/input"),
    "Your message is saved, but Moo couldn't act on it. Send it again to retry.");
  assert.equal(actionMessage(new Error("Error: Saved; Moo couldn't act on it: revision conflict"), "/api/input"),
    "Your message is saved, but Moo couldn't act on it. Send it again to retry.", "The saved rule comes before the revision rule");
  assert.match(actionMessage(new Error("Invalid text"), "/api/input"), /could not be confirmed as saved/);
});
