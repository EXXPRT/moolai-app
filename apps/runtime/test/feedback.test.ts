import test from "node:test";
import assert from "node:assert/strict";
import { clearAcknowledgedDraft, actionMessage, connectionAfterRefresh, processingMessage, readableNotice } from "../../desktop/src/feedback.js";

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
