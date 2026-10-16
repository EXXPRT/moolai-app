import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { MemoryBrain, SQLiteBrain } from "../src/index.js";
import { newRecord } from "../../contracts/src/records.js";
import { formatMarkdown, parseMarkdown } from "../../contracts/src/markdown.js";
import type { BrainPort } from "../../contracts/src/index.js";
import { Agent } from "../../agent/src/index.js";
import { FixtureProviders } from "../../agent-host/src/providers.js";
const date = "2026-09-26T00:00:00.000Z";
for (const adapter of ["memory", "sqlite"])
  test(`${adapter}: authored edits, filtering, history, relationships and restart`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-workspace-"));
    let brain: BrainPort =
      adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    try {
      const initial = await brain.createRecord({
        id: "question",
        kind: "note",
        createdAt: date,
      });
      const current = (await brain.updateRecord(initial.id, initial.revision, {
        title: "Flight",
        body: "Swifts catch insects while flying.",
        purpose: "Question",
        topics: ["Birds"],
        manualFields: ["title", "body", "topics"],
        quality: "ready",
      }))!;
      assert.equal(current.sourceRevision, 1);
      assert.equal(
        await brain.updateRecord(initial.id, initial.revision, {
          body: "Stale replacement",
          manualFields: ["body"],
        }),
        null,
      );
      const generated = (await brain.updateRecord(
        current.id,
        current.revision,
        {
          body: "Invented replacement",
          title: "Changed",
          topics: ["Other"],
          summary: "A flight note.",
        },
      ))!;
      assert.equal(generated.body, current.body);
      assert.equal(generated.title, "Flight");
      assert.deepEqual(generated.topics, ["Birds"]);
      const archived = await brain.createRecord({
        id: "archived",
        kind: "note",
        createdAt: date,
      });
      await brain.updateRecord(archived.id, 0, {
        body: "Swifts swifts swifts",
        archived: true,
      });
      assert.deepEqual(
        (await brain.search("swifts", 1)).map((r) => r.id),
        ["question"],
      );
      assert.equal(
        (
          await brain.query({
            topic: "Birds",
            unresolved: true,
            since: "2026-09-26",
            until: "2026-09-26",
          })
        ).length,
        1,
      );
      const resolved = (await brain.updateRecord(
        generated.id,
        generated.revision,
        { resolution: "resolved" },
      ))!;
      assert.equal((await brain.query({ unresolved: true })).length, 0);
      const reply = await brain.createRecord({
        id: "reply",
        kind: "note",
        createdAt: date,
      });
      await brain.updateRecord(reply.id, 0, {
        body: "Correction: this bird is a swallow.",
        author: { id: "second-fixture-author", name: "Peer", kind: "user" },
        links: [{ targetId: "question", provenance: "correction" }],
      });
      assert.equal((await brain.related("question"))[0]?.id, "reply");
      await brain.putAttachment(
        "evidence",
        "image/png",
        new Uint8Array([1, 2, 3]),
      );
      await brain.updateRecord(resolved.id, resolved.revision, {
        attachmentIds: ["evidence"],
      });
      const history = await brain.history("question");
      assert.equal(history[0]?.record.body, "");
      assert.equal(history[1]?.record.body, current.body);
      if (adapter === "sqlite") {
        await brain.close();
        brain = new SQLiteBrain(dir);
        assert.equal((await brain.getRecord("question"))?.body, current.body);
        assert.deepEqual(
          await brain.history("question"),
          history,
        );
      }
    } finally {
      await brain.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
test("migration backs up version 1 before enabling history; does not invent earlier revisions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "brain-migration-"));
  try {
    const db = new DatabaseSync(join(dir, "brain.sqlite"));
    db.exec(
      "CREATE TABLE records (id TEXT PRIMARY KEY,data TEXT NOT NULL); PRAGMA user_version=1;",
    );
    const record = newRecord({ id: "legacy", kind: "note", createdAt: date });
    delete record.body;
    db.prepare("INSERT INTO records VALUES (?,?)").run(
      record.id,
      JSON.stringify(record),
    );
    db.close();
    const brain = new SQLiteBrain(dir);
    assert.ok((await readFile(join(dir, "brain.before-v2.sqlite"))).length > 0);
    assert.deepEqual(await brain.getRecord(record.id), record);
    assert.deepEqual(await brain.history(record.id), []);
    await brain.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test("Markdown authored content is editable, repeatable, and unknown metadata survives", () => {
  const record = {
    ...newRecord({ id: "portable", kind: "note", createdAt: date }),
    body: "# A note\n\nUse **two** examples.\n",
    summary: "Two examples.",
  };
  const markdown = formatMarkdown(
    record,
    "---\ncustom: keep\n---\nIndependent prose\n",
  );
  assert.deepEqual(parseMarkdown(markdown).record, record);
  assert.equal(formatMarkdown(record, markdown), markdown);
  const edited = markdown.replace(
    "\nUse **two** examples.",
    "\nUse **three** examples.",
  );
  assert.match(parseMarkdown(edited).record!.body!, /three/);
  assert.match(
    formatMarkdown(parseMarkdown(edited).record!, edited),
    /custom: keep/,
  );
  assert.throws(
    () => parseMarkdown(edited.replace("moolai:body:end", "damaged")),
    /Invalid authored/,
  );
  assert.throws(
    () =>
      parseMarkdown(
        edited.replace(
          "examples.\n\n<!-- moolai:body:end",
          "examples.<!-- moolai:body:end",
        ),
      ),
    /separators/,
  );
});
test("authored note changes reach Nano, retained sources remain intact, manual title and tags survive", async () => {
  const brain = new MemoryBrain();
  const providers = new FixtureProviders();
  let id = 0;
  const sources: string[] = [];
  const original = providers.summarize.bind(providers);
  providers.summarize = async (r) => {
    sources.push(r.body ?? "");
    return original(r);
  };
  const agent = new Agent({
    brain,
    decisions: providers,
    generation: providers,
    vision: providers,
    search: providers,
    capture: {
      async capture() {
        throw Error("No capture");
      },
    },
    speech: { async speak() {}, async stop() {} },
    id: () => `n${++id}`,
    now: () => date,
  });
  await agent.initialize();
  const note = await agent.createNote({
    title: "My title",
    body: "Swifts catch insects.",
    topics: ["Birds"],
  });
  await agent.drain();
  let current = (await brain.getRecord(note.id))!;
  assert.equal(current.title, "My title");
  assert.deepEqual(current.topics, ["Birds"]);
  await agent.editRecord(current.id, current.revision, {
    body: "Swifts catch insects in flight.",
  });
  await agent.drain();
  current = (await brain.getRecord(note.id))!;
  assert.equal(sources.at(-1), "Swifts catch insects in flight.");
  assert.equal(current.segments.length, 0);
  const quality = current.quality;
  await agent.editRecord(current.id, current.revision, { archived: true });
  await agent.drain();
  assert.equal((await brain.getRecord(note.id))?.quality, quality);
});

import { brainConformance } from "../../contracts/test/brain-conformance.js";
for (const adapter of ["memory", "sqlite"])
  test(`${adapter}: common adapter conformance`, async () => {
    const dir = await mkdtemp(join(tmpdir(), "brain-conformance-"));
    const brain =
      adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    try {
      await brainConformance(brain);
    } finally {
      await brain.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

test("rapid authored saves supersede an in-flight summary without overwriting current content", async () => {
  const brain = new MemoryBrain();
  const providers = new FixtureProviders();
  let id = 0;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (release = resolve));
  let calls = 0;
  const summarize = providers.summarize.bind(providers);
  providers.summarize = async (record) => {
    if (++calls === 1) await waiting;
    return summarize(record);
  };
  const agent = new Agent({
    brain,
    decisions: providers,
    generation: providers,
    vision: providers,
    search: providers,
    capture: {
      async capture() {
        throw Error("No capture");
      },
    },
    speech: { async speak() {}, async stop() {} },
    id: () => `rapid-${++id}`,
    now: () => date,
  });
  await agent.initialize();
  const note = await agent.createNote({
    title: "Measurement",
    body: "The width is five metres.",
  });
  let current = (await brain.getRecord(note.id))!;
  await agent.editRecord(note.id, current.revision, {
    body: "The width is six metres.",
    topics: ["Measurements"],
  });
  current = (await brain.getRecord(note.id))!;
  await agent.editRecord(note.id, current.revision, {
    body: "The width is seven metres.",
  });
  release();
  await agent.drain();
  current = (await brain.getRecord(note.id))!;
  assert.equal(current.body, "The width is seven metres.");
  assert.match(current.summary, /seven metres/);
  assert.doesNotMatch(current.summary, /five metres|six metres/);
  assert.deepEqual(current.topics, ["Measurements"]);
  assert.equal(calls, 2);
});

test("manual resolution and archive are accepted without unnecessary generation", async () => {
  const brain = new MemoryBrain();
  const p = new FixtureProviders();
  let calls = 0;
  const accepted: any[] = [];
  let id = 0;
  const original = p.summarize.bind(p);
  p.summarize = async (r) => {
    calls++;
    return original(r);
  };
  const agent = new Agent({
    brain,
    decisions: p,
    generation: p,
    vision: p,
    search: p,
    capture: {
      async capture() {
        throw Error("No capture");
      },
    },
    speech: { async speak() {}, async stop() {} },
    acceptance: {
      async accept(record) {
        accepted.push(record);
        return { revision: record.revision };
      },
    },
    id: () => `metadata-${++id}`,
    now: () => date,
  });
  await agent.initialize();
  const note = await agent.createNote({
    title: "A question",
    body: "Why does this happen?",
  });
  await agent.drain();
  let record = (await brain.getRecord(note.id))!;
  const before = calls;
  await agent.editRecord(record.id, record.revision, {
    resolution: "resolved",
    archived: true,
  });
  await agent.drain();
  assert.equal(calls, before);
  assert.equal(accepted.at(-1).resolution, "resolved");
  assert.equal(accepted.at(-1).archived, true);
});

test("portable authored framing accepts CRLF without stripping authored whitespace", () => {
  const record = {...newRecord({id: "windows", kind: "note", createdAt: date}), body: " First line\r\nSecond line \r\n", summary: "A note"};
  const markdown = formatMarkdown(record);
  assert.equal(parseMarkdown(markdown).record?.body, record.body);
  const converted = formatMarkdown({...record, body: " First line\nSecond line \n"}).replaceAll("\n", "\r\n");
  const parsed = parseMarkdown(converted).record!;
  assert.equal(parsed.body, record.body);
  assert.equal(parseMarkdown(formatMarkdown(parsed, converted)).record?.body, record.body);
});

test("generated note links survive spaces, parentheses, Unicode and literal percent signs", async () => {
  const {unified} = await import("unified");
  const {default: remarkParse} = await import("remark-parse");
  const paths = ["Moolai/Notes/Renamed target.md", "Moolai/Notes/Section (two).md", "Moolai/Notes/鸟.md", "Moolai/Notes/a%20b.md", "Moolai/Notes/Question #2?.md", "#record-a%20b"];
  for (const path of paths) {
    const record = {...newRecord({id: "links", kind: "note", createdAt: date}), links: [{targetId: "target", provenance: "manual" as const}]};
    const tree = unified().use(remarkParse).parse(formatMarkdown(record, "", () => path));
    const links: {url: string}[] = [];
    const visit = (node: any) => { if (node.type === "link") links.push(node); for (const child of node.children ?? []) visit(child); };
    visit(tree);
    assert.equal(links.length, 1, path);
    assert.equal(decodeURIComponent(links[0]!.url), path);
    assert.deepEqual(parseMarkdown(formatMarkdown(record, "", () => path)).record, record);
  }
});

for (const adapter of ["memory", "sqlite"] as const)
  test(`${adapter}: reviewed import history and pair dismissal regressions`, async () => {
    const {brainReviewConformance} = await import("../../contracts/test/brain-conformance.js");
    const dir = await mkdtemp(join(tmpdir(), "brain-review-"));
    const brain = adapter === "memory" ? new MemoryBrain() : new SQLiteBrain(dir);
    try { await brainReviewConformance(brain); }
    finally { await brain.close(); await rm(dir, {recursive: true, force: true}); }
  });
