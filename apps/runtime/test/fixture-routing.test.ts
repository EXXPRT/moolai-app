import test from "node:test";
import assert from "node:assert/strict";
import type { RouteInput } from "../../../packages/contracts/src/index.js";
import { FixtureProviders } from "../src/providers.js";

const fixture = new FixtureProviders();
const idle = { recentContext: "", activeConversation: false };

test("offline fixtures demonstrate natural starts, help offers and plain dictation", async () => {
  for (const [text, route] of [
    ["Can you tell me how this happened?", "start_agent"],
    ["What's even going on?", "offer_help"],
    ["The goalpost is 5m wide.", "dictate"],
    ["Yes.", "unclear"],
    ["Yes, please.", "unclear"],
    ["That's all.", "no_action"],
  ]) {
    assert.equal((await fixture.route({ ...idle, text: text! })).route, route);
  }
});

test("offline fixtures keep active content and quoted or negated endings in conversation", async () => {
  for (const text of [
    "The goalpost is 5m wide.",
    'The title is "That\'s all."',
    "Don't finish the conversation.",
    "That's all, but first explain the last point.",
  ]) {
    assert.equal(
      (await fixture.route({ ...idle, activeConversation: true, text })).route,
      "continue_agent",
    );
  }
  for (const text of ["That's all.", "Moo, finish conversation.", "We're done."]) {
    const result = await fixture.route({ ...idle, activeConversation: true, text });
    assert.equal(result.route, "end_agent");
    assert.equal(result.substantiveContentProbability, 0);
  }
});

test("offline help replies require an actual pending offer", async () => {
  for (const kind of ["help", "general_help"] as const) {
    const pendingOffer: RouteInput["pendingOffer"] = { kind, recordId: "source-note" };
    assert.deepEqual(await fixture.route({ ...idle, pendingOffer, text: "Yes, please." }), {
      route: "start_agent", confidence: 1, helpAccepted: true,
    });
    assert.deepEqual(await fixture.route({ ...idle, pendingOffer, text: "No, just save it." }), {
      route: "no_action", confidence: 1,
    });
  }
  assert.equal((await fixture.route({ ...idle, text: "Yes." })).route, "unclear");
  assert.equal((await fixture.route({ ...idle, pendingOffer: { kind: "end_work" }, text: "Maybe." })).route, "unclear");
});
