import assert from "node:assert/strict";
import {formatMarkdown,parseMarkdown} from "../src/markdown.js";
import type { BrainPort } from "../src/index.js";
/** Run unchanged against each durable implementation; no database or host imports. */
export async function brainConformance(brain: BrainPort) {
  const createdAt = "2026-09-26T02:00:00.000Z";
  let r = await brain.createRecord({
    id: "contract-thought",
    kind: "dictation",
    createdAt,
  });
  r = await brain.upsertSegment(r.id, {
    id: "s",
    turnId: "t",
    revision: 1,
    speaker: "user",
    text: "The goalpost is five metres wide.",
    final: true,
    createdAt,
  });
  const before = r;
  r = (await brain.updateRecord(r.id, r.revision, {
    body: "The reference dimension is five metres.",
    topics: ["Dimensions"],
    manualFields: ["body", "topics"],
  }))!;
  assert.equal(
    await brain.updateRecord(r.id, before.revision, {
      body: "Wrong stale edit",
      manualFields: ["body"],
    }),
    null,
  );
  r = (await brain.updateRecord(r.id, r.revision, {
    summary: "A dimension reference.",
    topics: ["Wrong"],
    body: "Wrong generated replacement",
  }))!;
  assert.equal(r.body, "The reference dimension is five metres.");
  assert.deepEqual(r.topics, ["Dimensions"]);
  assert.equal(
    (await brain.search("dimension", 1, { topic: "Dimensions" }))[0]?.id,
    r.id,
  );
  assert.equal((await brain.query({ topic: "Unrelated", limit: 1 })).length, 0);
  await brain.putAttachment(
    "contract-image",
    "image/png",
    new Uint8Array([8, 4, 2]),
  );
  assert.deepEqual(
    (await brain.getAttachment("contract-image"))?.bytes,
    new Uint8Array([8, 4, 2]),
  );
  await assert.rejects(
    brain.putAttachment("contract-image", "image/png", new Uint8Array([0])),
    /conflict|immutable|Immutable/,
  );
  await brain.putOperation({
    id: "contract-enrich",
    kind: "enrich",
    recordId: r.id,
    sourceRevision: r.sourceRevision,
    status: "pending",
    attempts: 0,
  });
  assert.equal(
    (await brain.listOperations()).find((o) => o.id === "contract-enrich")
      ?.status,
    "pending",
  );
  await brain.setState("contract:context", {
    request: "Why five metres?",
    constraint: "notes only",
  });
  assert.equal(
    (await brain.getState<{ constraint: string }>("contract:context"))
      ?.constraint,
    "notes only",
  );
  const history = await brain.history(r.id);
  assert.ok(
    history.some(
      (h) => h.record.segments[0]?.text === "The goalpost is five metres wide.",
    ),
  );
  assert.ok(
    history.some(
      (h) => h.record.body === "The reference dimension is five metres.",
    ),
  );
  const reply = await brain.createRecord({
    id: "contract-reply",
    kind: "note",
    createdAt,
  });
  await brain.updateRecord(reply.id, reply.revision, {
    body: "A related reply",
    links: [{ targetId: r.id, provenance: "reply" }],
  });
  assert.ok((await brain.related(r.id)).some((n) => n.id === reply.id));
  r=(await brain.updateRecord(r.id,r.revision,{sources:[{recordId:"source-document",spans:[{segmentId:"s",revision:1,start:0,end:31}]}],sourceContext:"Attributed tool evidence",connectionStatus:"connected",links:[{targetId:reply.id,provenance:"suggested",decision:"accepted",confidence:.9,sourceRevision:r.sourceRevision,targetRevision:1}]}))!;
  assert.deepEqual(parseMarkdown(formatMarkdown(r)).record,r,"New provenance survives portable Markdown");
  const source=await brain.createRecord({id:"source-document",kind:"conversation",createdAt});
  await brain.updateRecord(source.id,source.revision,{sourceOnly:true,body:"Hidden goalpost transcript"});
  assert.ok(!(await brain.search("goalpost",10)).some(x=>x.id===source.id),"Source documents are not independent evidence");
  await brain.putOperation({id:"contract-consolidate",kind:"consolidate",recordId:source.id,sourceRevision:1,status:"pending",attempts:0});
  assert.ok((await brain.listOperations()).some(o=>o.kind==="consolidate"));
  await brain.updateRecord(r.id, r.revision, { archived: true });
  assert.equal((await brain.search("goalpost", 5)).length, 0);
  assert.ok(await brain.getRecord(r.id));
}

/** Data-repair regressions shared by Memory, SQLite and the private vault adapter. */
export async function brainReviewConformance(brain: BrainPort) {
  const createdAt = "2026-10-07T00:00:00.000Z";
  const imported = await brain.createRecord({id: "review-import-template", kind: "note", createdAt});
  await brain.importRecord({...imported, id: "review-import", revision: 9}, []);
  assert.deepEqual((await brain.history("review-import")).map(h => h.record.revision), [9],
    "An imported current snapshot is inspectable before any new edit; older history is not invented");
  await brain.updateRecord("review-import", 9, {body: "New authored correction", manualFields: ["body"]});
  assert.deepEqual((await brain.history("review-import")).map(h => h.record.revision), [9, 10]);
  const target = {...imported, id: "review-invalid-history", revision: 9};
  await assert.rejects(brain.importRecord(target, [{record: imported, reason: "import", at: createdAt}]),
    /history/, "A different note's history must not enter this record");
  assert.equal(await brain.getRecord(target.id), undefined, "Invalid history is rejected before creating the note");
  const entry = {record: target, reason: "import" as const, at: createdAt};
  await assert.rejects(brain.importRecord(target, [entry, entry]), /history/);
  await assert.rejects(brain.importRecord(target, [{...entry, record: {...target, revision: 10}}]), /history/);
  await assert.rejects(brain.importRecord(target, [{...entry, record: {...target, body: "Conflicting same-revision source"}}]),
    /history/, "Same-revision history cannot replace the actual imported source after the next edit");
  assert.equal(await brain.getRecord(target.id), undefined);
  const current = {...imported, id: "review-reordered-history", revision: 9, acceptedRevision: 9,
    segments: [{id: "imported-segment", turnId: "imported-turn", revision: 1, speaker: "user" as const,
      text: "Preserve the original imported observation.", final: true, createdAt}]};
  await assert.rejects(brain.importRecord(current, [{record: {...current,
    segments: [{...current.segments[0]!, text: "An altered historical observation."}],
  }, reason: "import", at: createdAt}]), /history/);
  assert.equal(await brain.getRecord(current.id), undefined);
  const reordered = Object.fromEntries(Object.entries({...current, acceptedRevision: 0,
    segments: current.segments.map(segment => Object.fromEntries(Object.entries(segment).reverse())),
  }).reverse()) as typeof current;
  await brain.importRecord(current, [{record: reordered, reason: "import", at: createdAt}]);
  await brain.updateRecord(current.id, current.revision, {body: "A subsequent user correction", manualFields: ["body"]});
  const preserved = await brain.history(current.id);
  assert.deepEqual(preserved.map(item => item.record.revision), [9, 10]);
  assert.equal(preserved[0]!.record.acceptedRevision, 0, "An existing valid historical snapshot is retained");
  assert.equal(preserved[0]!.record.segments[0]!.text, current.segments[0]!.text,
    "Object key order and later backend acknowledgements do not change historical source");
  const latest = {...imported, id: "review-incomplete-import-history", revision: 9, body: "Imported current content"};
  const older = {...latest, revision: 6, body: "Known older content"};
  await brain.importRecord(latest, [{record: older, reason: "manual", at: createdAt}]);
  assert.deepEqual((await brain.history(latest.id)).map(item => item.record.revision), [6, 9],
    "Partial supplied history includes the current snapshot without inventing missing revisions");
  await brain.updateRecord(latest.id, 9, {body: "Next edit", manualFields: ["body"]});
  assert.deepEqual((await brain.history(latest.id)).map(item => [item.record.revision, item.record.body]),
    [[6, "Known older content"], [9, "Imported current content"], [10, "Next edit"]]);
  let first = await brain.createRecord({id: "review-first", kind: "note", createdAt});
  let second = await brain.createRecord({id: "review-second", kind: "note", createdAt});
  first = (await brain.updateRecord(first.id, first.revision, {links: [{targetId: second.id, provenance: "suggested", decision: "dismissed"}]}))!;
  second = (await brain.updateRecord(second.id, second.revision, {links: [{targetId: first.id, provenance: "suggested", decision: "accepted"}]}))!;
  assert.deepEqual(await brain.related(first.id), []);
  assert.deepEqual(await brain.related(second.id), []);
  await brain.updateRecord(second.id, second.revision, {links: [...second.links, {targetId: first.id, provenance: "source"}]});
  assert.equal((await brain.related(first.id))[0]?.id, second.id, "Association dismissal does not delete source provenance");
}
