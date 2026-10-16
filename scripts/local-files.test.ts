import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalFiles } from "../packages/local-files/src/index.js";

async function fixture(t: TestContext) {
  const temporary = await mkdtemp(join(tmpdir(), "moolai-local-files-"));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const directory = join(temporary, "notes");
  await mkdir(directory);
  const config = join(temporary, "state", "folders.json");
  const files = new LocalFiles(config);
  return { temporary, directory, config, files };
}

test("LocalFiles: no initial grants; selection persists and revocation applies to existing adapters", async t => {
  const { directory, config, files } = await fixture(t);
  assert.deepEqual(await files.roots(), []);
  await assert.rejects(files.search({ query: "orchids" }), /no folders/);
  await writeFile(join(directory, "study.md"), "orchids");
  const root = await files.grant(directory);
  assert.equal((await files.grant(directory)).id, root.id);
  const reloaded = new LocalFiles(config);
  assert.deepEqual(await reloaded.roots(), [root]);
  assert.equal((await reloaded.read({ rootId: root.id, path: "study.md" })).text, "orchids");
  assert.equal((await stat(config)).mode & 0o777, 0o600);
  await files.revoke(root.id);
  await assert.rejects(reloaded.read({ rootId: root.id, path: "study.md" }), /revoked/);
  await assert.rejects(reloaded.search({ rootId: root.id, query: "orchids" }), /revoked/);
});

test("LocalFiles: literal text and filename searches return scoped passages with fingerprints", async t => {
  const { directory, files } = await fixture(t);
  await writeFile(join(directory, "equations [draft].md"), "Notes\na+b equals c\nalpha beta\n");
  await writeFile(join(directory, "other.md"), "aaab is a regex match\n");
  const root = await files.grant(directory);
  const literal = await files.search({ query: "a+b" });
  assert.equal(literal.matches.length, 1);
  assert.deepEqual(literal.matches.map(({ rootId, path, line, excerpt }) => ({ rootId, path, line, excerpt })), [
    { rootId: root.id, path: "equations [draft].md", line: 2, excerpt: "a+b equals c" },
  ]);
  assert.match(literal.matches[0]!.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await files.search({ query: "a+b", regex: true })).matches[0]!.path, "other.md");
  assert.equal((await files.search({ query: "[draft]", mode: "filename" })).matches[0]!.path, "equations [draft].md");
  assert.equal((await files.search({ query: "equations.*md$", mode: "filename", regex: true })).matches.length, 1);
  assert.deepEqual(await files.search({ query: "does not exist" }), { matches: [], truncated: false });
});

test("LocalFiles: regex errors and invalid inputs are failures, never empty successful searches", async t => {
  const { directory, files } = await fixture(t);
  await writeFile(join(directory, "a.md"), "alpha");
  await files.grant(directory);
  await assert.rejects(files.search({ query: "[", regex: true }), /failed:.*regex|failed:[\s\S]*regex/i);
  await assert.rejects(files.search({ query: "[", mode: "filename", regex: true }), /failed:[\s\S]*regex/i);
  await assert.rejects(files.search({ query: " " }), /nonempty/);
  await assert.rejects(files.search({ query: "x".repeat(501) }), /500/);
});

test("LocalFiles: honors ignore rules without a git repository and excludes secrets, hidden and binary files", async t => {
  const { directory, files } = await fixture(t);
  const content = "private keyword";
  await writeFile(join(directory, ".gitignore"), "ignored.md\nignored-directory/\n");
  await mkdir(join(directory, "ignored-directory"));
  await writeFile(join(directory, "ignored-directory", "inside.md"), content);
  for (const path of ["visible.md", "ignored.md", ".hidden.md", ".env", "credentials.json", "SECRETS.JSON", "runtime.env", "certificate.pem"]) {
    await writeFile(join(directory, path), content);
  }
  await writeFile(join(directory, "binary.md"), Buffer.from("private keyword\0binary"));
  const root = await files.grant(directory);
  const result = await files.search({ query: "private keyword" });
  assert.deepEqual(result.matches.map(item => item.path), ["visible.md"]);
  for (const path of ["ignored.md", "ignored-directory/inside.md", ".hidden.md", ".env", "credentials.json", "SECRETS.JSON", "runtime.env", "certificate.pem", "binary.md"]) {
    await assert.rejects(files.read({ rootId: root.id, path }), /ignored|excluded|visible relative/);
  }
  assert.deepEqual((await files.search({ query: ".", mode: "filename", regex: true })).matches.map(item => item.path), ["visible.md"]);
});

test("LocalFiles: rejects traversal, absolute paths and symlinks escaping a granted root", async t => {
  const { temporary, directory, files } = await fixture(t);
  const outside = join(temporary, "outside.md");
  await writeFile(outside, "private outside");
  await symlink(outside, join(directory, "linked.md"));
  await symlink(temporary, join(directory, "linked-directory"));
  const root = await files.grant(directory);
  for (const path of ["../outside.md", outside, "linked.md", "linked-directory/outside.md"]) {
    await assert.rejects(files.read({ rootId: root.id, path }), /relative|ignored|unavailable|escapes/);
  }
  assert.deepEqual((await files.search({ query: "private" })).matches, []);
});

test("LocalFiles: replacing a granted root with a symlink invalidates access", async t => {
  const { temporary, directory, files } = await fixture(t);
  const root = await files.grant(directory);
  await rename(directory, `${directory}-old`);
  await mkdir(join(temporary, "other"));
  await writeFile(join(temporary, "other", "a.md"), "private");
  await symlink(join(temporary, "other"), directory);
  await assert.rejects(files.read({ rootId: root.id, path: "a.md" }), /moved or changed/);
  await assert.rejects(files.search({ query: "private" }), /moved or changed/);
});

test("LocalFiles: result cap reports truncation and excludes other selected roots when scoped", async t => {
  const { temporary, directory, files } = await fixture(t);
  await writeFile(join(directory, "many.md"), Array.from({ length: 80 }, (_, i) => `match ${i}`).join("\n"));
  const root = await files.grant(directory);
  const other = join(temporary, "second");
  await mkdir(other);
  await writeFile(join(other, "other.md"), "match elsewhere");
  await files.grant(other);
  const result = await files.search({ query: "match", rootId: root.id });
  assert.equal(result.matches.length, 50);
  assert.equal(result.truncated, true);
  assert(result.matches.every(item => item.rootId === root.id));
});

test("LocalFiles: filename results and raw subprocess output remain bounded", async t => {
  const { directory, files } = await fixture(t);
  await Promise.all(Array.from({ length: 55 }, (_, i) => writeFile(join(directory, `note-${i}.md`), "small")));
  await files.grant(directory);
  const names = await files.search({ query: "note-", mode: "filename" });
  assert.equal(names.matches.length, 50);
  assert.equal(names.truncated, true);
  await writeFile(join(directory, "huge.md"), `needle ${"x".repeat(300_000)}`);
  const result = await files.search({ query: "needle" });
  assert.equal(result.truncated, true);
  assert(JSON.stringify(result).length < 30_000);
});

test("LocalFiles: bounded additional passages and fingerprint changes support current evidence", async t => {
  const { directory, files } = await fixture(t);
  await writeFile(join(directory, "a.md"), "first\nsecond\nthird\nfourth");
  const root = await files.grant(directory);
  const first = await files.read({ rootId: root.id, path: "a.md", startLine: 2, lineCount: 2 });
  assert.equal(first.text, "second\nthird");
  assert.equal(first.truncated, true);
  const tail = await files.read({ rootId: root.id, path: "a.md", startLine: 4, lineCount: 2 });
  assert.equal(tail.text, "fourth");
  assert.equal(tail.truncated, false);
  await writeFile(join(directory, "a.md"), "corrected\nsecond");
  const current = await files.read({ rootId: root.id, path: "a.md" });
  assert.notEqual(current.fingerprint, first.fingerprint);
  assert.equal(current.text, "corrected\nsecond");
  await assert.rejects(files.read({ rootId: root.id, path: "a.md", lineCount: 201 }), /200/);
  await assert.rejects(files.read({ rootId: root.id, path: "a.md", startLine: 0 }), /positive/);
  await writeFile(join(directory, "long.md"), "x".repeat(20_000));
  const bounded = await files.read({ rootId: root.id, path: "long.md" });
  assert.equal(bounded.text.length, 16_000);
  assert.equal(bounded.truncated, true);
});

test("LocalFiles: shell metacharacters remain literal search arguments", async t => {
  const { temporary, directory, files } = await fixture(t);
  const probe = join(temporary, "must-not-exist");
  const query = `$(touch '${probe}')`;
  await writeFile(join(directory, "a.md"), query);
  await files.grant(directory);
  assert.equal((await files.search({ query })).matches[0]!.excerpt, query);
  await assert.rejects(stat(probe), { code: "ENOENT" });
});

test("LocalFiles: unavailable ripgrep is explicit and cancellation does not produce a no-match result", async t => {
  const { temporary, directory, config, files } = await fixture(t);
  await files.grant(directory);
  const missing = new LocalFiles(config, join(temporary, "no-rg"));
  await assert.rejects(missing.search({ query: "text" }), /ripgrep was not found/);
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(files.search({ query: "text" }, abort.signal), /abort/i);
});

test("LocalFiles: revoking a folder while a search is running prevents returned evidence", async t => {
  const { temporary, directory, config, files } = await fixture(t);
  await writeFile(join(directory, "a.md"), "private");
  const root = await files.grant(directory);
  const delayed = join(temporary, "delayed-rg");
  const started = join(temporary, "started");
  const release = join(temporary, "release");
  const response = JSON.stringify({ type: "match", data: { path: { text: "./a.md" }, lines: { text: "private\n" }, line_number: 1 } });
  await writeFile(delayed, `#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(${JSON.stringify(started)}, 'ready');\nconst timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);console.log(${JSON.stringify(response)});}},10);\n`);
  await chmod(delayed, 0o700);
  const abort = new AbortController();
  const pending = new LocalFiles(config, delayed).search({ query: "private" }, abort.signal);
  void pending.catch(() => {}); // A fixture-start failure must not leave an unhandled rejection.
  try {
    const deadline = Date.now() + 4000;
    while (Date.now() < deadline) {
      try { await stat(started); break; } catch { await new Promise(resolve => setTimeout(resolve, 10)); }
    }
    await stat(started);
    await files.revoke(root.id);
    await writeFile(release, "ready");
    await assert.rejects(pending, /revoked/);
  } finally {
    abort.abort();
    await pending.catch(() => {});
  }
});

test("LocalFiles: hung executable is terminated at the five-second bound", async t => {
  const { temporary, directory, config, files } = await fixture(t);
  await files.grant(directory);
  const hung = join(temporary, "hung-rg");
  await writeFile(hung, `#!${process.execPath}\nsetInterval(() => {}, 1000);\n`);
  await chmod(hung, 0o700);
  const start = Date.now();
  await assert.rejects(new LocalFiles(config, hung).search({ query: "text" }), /five-second/);
  assert(Date.now() - start < 7_000);
});

test("LocalFiles: parallel grants preserve both folders and invalid configurations fail closed", async t => {
  const { temporary, directory, config, files } = await fixture(t);
  const second = join(temporary, "second");
  await mkdir(second);
  await Promise.all([files.grant(directory), files.grant(second)]);
  assert.equal((await files.roots()).length, 2);
  assert.equal(JSON.parse(await readFile(config, "utf8")).version, 1);
  await writeFile(config, JSON.stringify({ roots: [{ id: "bad", name: "bad", path: "relative" }] }));
  await assert.rejects(files.roots(), /invalid/);
});
