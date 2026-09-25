import test from "node:test";
import assert from "node:assert/strict";
import type { Segment } from "../../../packages/contracts/src/index.js";
import { NativeInput, retainAsrDiagnostic } from "../src/native-input.js";
import { SQLiteBrain } from "../../../packages/brain/src/index.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

test("rejected ASR output is durable and never routed as a command", async () => {
  const directory = await mkdtemp(join(tmpdir(), "moolai-asr-review-"));
  let brain = new SQLiteBrain(directory);
  const text = "Moo, finish conversation. ".repeat(30);
  let routed = 0;
  const errors: unknown[] = [];
  try {
    const input = new NativeInput({
      async ingest() { throw new Error("Diagnostic must not enter Agent ingest"); },
      async settleTurn() { routed++; },
      retainDiagnostic: (source, message) => retainAsrDiagnostic(brain, source, message),
    }, error => errors.push(error));
    input.retainDiagnostic(text, "ASR returned highly repetitive text");
    await input.saved();
    await input.settled();
    assert.deepEqual(errors, []);
    assert.equal(routed, 0);
    await brain.close();
    brain = new SQLiteBrain(directory);
    const records = await brain.listRecords();
    assert.equal(records.length, 1);
    assert.equal(records[0]!.segments[0]!.text, text);
    assert.equal(records[0]!.segments[0]!.final, false);
    assert.equal(records[0]!.quality, "pending");
    assert.equal(records[0]!.error, "ASR returned highly repetitive text");
  } finally {
    await brain.close();
    await rm(directory, { recursive: true, force: true });
  }
});
const source = (id: string): Segment => ({
  id,
  turnId: id,
  speaker: "user",
  text: id,
  final: true,
  revision: 1,
  createdAt: "2026-09-20T00:00:00Z",
});

test(
  "slow routing does not delay later ASR persistence, and completed turns stay ordered",
  { timeout: 5000 },
  async () => {
    const firstRouting = deferred();
    const finishRouting = deferred();
    const writes: string[] = [];
    const turns: string[] = [];
    const input = new NativeInput(
      {
        async ingest(segment) {
          writes.push(segment.id);
        },
        async settleTurn(id) {
          turns.push(id);
          assert.ok(
            writes.includes(id),
            "The source must be saved before routing its turn",
          );
          if (id === "first") {
            firstRouting.resolve();
            await finishRouting.promise;
          }
        },
      },
      (error) => {
        throw error;
      },
    );
    input.ingest(source("first"));
    input.settleTurn("first");
    await firstRouting.promise;
    input.ingest(source("second"));
    input.settleTurn("second");
    await input.saved();
    assert.deepEqual(writes, ["first", "second"]);
    assert.deepEqual(turns, ["first"]);
    finishRouting.resolve();
    await input.settled();
    assert.deepEqual(turns, ["first", "second"]);
  },
);

test(
  "turn routing and drains wait for preceding source writes",
  { timeout: 5000 },
  async () => {
    const writeStarted = deferred();
    const finishWrite = deferred();
    const actions: string[] = [];
    const input = new NativeInput(
      {
        async ingest(segment) {
          writeStarted.resolve();
          await finishWrite.promise;
          actions.push(`saved:${segment.id}`);
        },
        async settleTurn(id) {
          actions.push(`routed:${id}`);
        },
      },
      (error) => {
        throw error;
      },
    );
    input.ingest(source("final-words"));
    input.settleTurn("final-words");
    await writeStarted.promise;
    let writesDrained = false;
    let turnsDrained = false;
    const saved = input.saved().then(() => {
      writesDrained = true;
    });
    const settled = input.settled().then(() => {
      turnsDrained = true;
    });
    await Promise.resolve();
    assert.equal(writesDrained, false);
    assert.equal(turnsDrained, false);
    assert.deepEqual(actions, []);
    finishWrite.resolve();
    await Promise.all([saved, settled]);
    assert.deepEqual(actions, ["saved:final-words", "routed:final-words"]);
  },
);

test("one routing failure is reported without poisoning later source writes or turns", async () => {
  const writes: string[] = [];
  const turns: string[] = [];
  const errors: string[] = [];
  const input = new NativeInput(
    {
      async ingest(segment) {
        writes.push(segment.id);
      },
      async settleTurn(id) {
        if (id === "failed") throw new Error("Jev offline");
        turns.push(id);
      },
    },
    (error) => {
      errors.push(String(error));
    },
  );
  input.ingest(source("failed"));
  input.settleTurn("failed");
  input.ingest(source("next"));
  input.settleTurn("next");
  await input.saved();
  await input.settled();
  assert.deepEqual(writes, ["failed", "next"]);
  assert.deepEqual(turns, ["next"]);
  assert.deepEqual(errors, ["Error: Jev offline"]);
});
