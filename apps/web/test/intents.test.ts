import test from "node:test";
import assert from "node:assert/strict";
import { intentsFromTrace } from "../src/intents.js";

// Entries as Agent.trace() writes them: {at, action, requestTurnId, ...detail} (packages/agent/src/index.ts).
const at = "2026-10-29T09:00:00.000Z";
const routed = (turnId: string, route: string, confidence: number, extra: Record<string, unknown> = {}) =>
  ({ at, action: "route", requestTurnId: undefined, turnId, route, confidence, ...extra });

test("each route J1 can return has its label, and a sure decision carries its route and confidence", () => {
  const labels: Record<string, string> = {
    start_agent: "Request for Moo",
    continue_agent: "Reply to Moo",
    end_agent: "Ending the conversation",
    offer_help: "Doubt: Moo offers help",
    check_status: "Status check",
    suppress_note: "Don't keep that note",
    dictate: "Saved as a thought",
    no_action: "No action",
    unclear: "Unclear: Moo asks",
  };
  const intents = intentsFromTrace(Object.keys(labels).map(route => routed(`turn-${route}`, route, 0.95)));
  assert.deepEqual(intents, Object.fromEntries(Object.entries(labels).map(([route, label]) =>
    [`turn-${route}`, { label, route, confidence: 0.95 }])));
});

test("a decision below 0.8 is marked unsure; at 0.8 or without a confidence it is not", () => {
  const intents = intentsFromTrace([
    routed("low", "start_agent", 0.79),
    routed("edge", "start_agent", 0.8),
    { at, action: "route", turnId: "unscored", route: "dictate" },
    routed("not-a-number", "dictate", Number.NaN),
  ]);
  assert.deepEqual(intents.low, { label: "Request for Moo · unsure", route: "start_agent", confidence: 0.79 });
  assert.deepEqual(intents.edge, { label: "Request for Moo", route: "start_agent", confidence: 0.8 });
  assert.deepEqual(intents.unscored, { label: "Saved as a thought", route: "dictate" });
  assert.deepEqual(intents["not-a-number"], { label: "Saved as a thought", route: "dictate" });
});

test("a dictated turn with a doubt of 0.8 or more shows Moo's offer; a weaker doubt stays a saved thought", () => {
  const intents = intentsFromTrace([
    routed("doubt", "dictate", 1, { doubt: 0.8 }),
    routed("unsure-doubt", "dictate", 0.6, { doubt: 0.96 }),
    routed("weak", "dictate", 1, { doubt: 0.79 }),
    routed("request", "start_agent", 1, { doubt: 0.96 }),
  ]);
  assert.deepEqual(intents.doubt, { label: "Doubt: Moo offers help", route: "dictate", confidence: 1 });
  assert.deepEqual(intents["unsure-doubt"], { label: "Doubt: Moo offers help · unsure", route: "dictate", confidence: 0.6 });
  assert.equal(intents.weak?.label, "Saved as a thought");
  assert.equal(intents.request?.label, "Request for Moo");
});

test("the last decision for a turn wins, including an ignored sound and a bare call Moo answered", () => {
  const intents = intentsFromTrace([
    routed("corrected", "unclear", 0.4),
    { at, action: "filler_ignored", requestTurnId: "earlier", turnId: "filler", text: "mm" },
    routed("corrected", "dictate", 0.9),
    { at, action: "wake_acknowledged", turnId: "call" },
    routed("routed-call", "dictate", 0.7),
    { at, action: "wake_acknowledged", turnId: "routed-call", route: "dictate" },
  ]);
  assert.deepEqual(intents, {
    corrected: { label: "Saved as a thought", route: "dictate", confidence: 0.9 },
    filler: { label: "Ignored sound" },
    call: { label: "Moo heard its name" },
    "routed-call": { label: "Moo heard its name", route: "dictate" },
  });
});

test("other trace actions, malformed entries and unknown routes make no chip", () => {
  for (const trace of [undefined, null, "route", {}, { turnId: "t", action: "route", route: "dictate" }])
    assert.deepEqual(intentsFromTrace(trace), {}, JSON.stringify(trace));
  const intents = intentsFromTrace([
    null, 7, "route", [],
    { at, action: "speech_onset", requestTurnId: "kept" },
    { at, action: "response_started", requestTurnId: "kept" },
    { at, action: "recognition_rejected", turnId: "rejected" },
    { at, action: "route", route: "dictate", confidence: 1 },
    { at, action: "route", turnId: 42, route: "dictate", confidence: 1 },
    routed("future", "summon_cow", 1),
    routed("inherited", "toString", 1),
    routed("kept", "continue_agent", 1),
    { at, action: "response_cancelled", turnId: "kept" },
  ]);
  assert.deepEqual(intents, { kept: { label: "Reply to Moo", route: "continue_agent", confidence: 1 } });
});

test("a turn id is an own key, never a prototype", () => {
  const intents = intentsFromTrace([routed("__proto__", "dictate", 1)]);
  assert.ok(Object.hasOwn(intents, "__proto__"));
  assert.equal(Object.getPrototypeOf(intents), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify(intents)).__proto__, { label: "Saved as a thought", route: "dictate", confidence: 1 });
});
