// Run with Electron. Exercises the production renderer, preload and local runtime.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const net = require("node:net");
const assert = require("node:assert/strict");

const root = path.resolve(__dirname, "..");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "moolai-desktop-"));
const evidenceDir = path.join(root, ".data/validation");
process.env.MOOLAI_DATA_DIR = dataDir;
process.env.MOOLAI_MODE = "fixture";
// This fixture test must never open a microphone or capture the real desktop.
process.env.MOOLAI_NATIVE_PATH = path.join(dataDir, "native-disabled-for-desktop-test");
delete process.env.MOOLAI_DESKTOP_DEV_URL;
const delay = (ms) => new Promise((done) => setTimeout(done, ms));
let finished = false;
async function finish(code) {
  if (finished) return;
  finished = true;
  clearTimeout(deadline);
  try {
    const { pid } = JSON.parse(
      fs.readFileSync(path.join(dataDir, "runtime.json"), "utf8"),
    );
    process.kill(pid, "SIGTERM");
    for (
      let n = 0;
      n < 30 && fs.existsSync(path.join(dataDir, "runtime.json"));
      n++
    )
      await delay(100);
  } catch {
    /* The fixture runtime may not have started. */
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
  app.exit(code);
}
const deadline = setTimeout(() => {
  console.error("Desktop smoke timed out");
  void finish(1);
}, 40_000);

// Reserve an unused loopback port before Electron's ready event.
const listener = net.createServer();
listener.listen(0, "127.0.0.1", () => {
  process.env.MOOLAI_PORT = String(listener.address().port);
  listener.close();
});
require(path.join(root, "apps/desktop/electron.cjs"));
app.whenReady().then(async () => {
  try {
    while (!process.env.MOOLAI_PORT) await delay(10);
    const window = BrowserWindow.getAllWindows()[0];
    if (window.webContents.isLoading())
      await new Promise((done) =>
        window.webContents.once("did-finish-load", done),
      );
    const run = (code) => window.webContents.executeJavaScript(code);
    const request = (method, route, body) =>
      run(
        `window.moolai.request(${JSON.stringify(method)},${JSON.stringify(route)},${JSON.stringify(body ?? {})})`,
      );
    assert.equal(window.webContents.getURL(), "moolai://app/index.html");
    assert.equal(await run("typeof window.require"), "undefined");
    assert.equal(
      await run(
        "fetch('moolai://app/..%2f..%2fpackage.json').then(r => r.status)",
      ),
      404,
    );
    await request("POST", "/api/session", { action: "start" });
    await request("POST", "/api/input", {
      text: "I have an idea: build a better system for connecting thoughtful notes.",
    });
    await request("POST", "/api/input", {
      text: "Moo, help me organize my ideas. Use only my notes.",
    });
    await request("POST", "/api/input", {
      text: "Keep the first idea separate.",
    });
    await request("POST", "/api/input", {
      text: "And connect it to related notes.",
    });
    const state = await request("GET", "/api/state");
    const conversation = state.records.find(
      (record) => record.id === state.state.conversationId,
    );
    assert.equal(
      conversation.segments.filter((segment) => segment.speaker === "user")
        .length,
      3,
    );
    const dictation = state.records.find(
      (record) => record.kind === "dictation",
    );
    assert.ok(dictation?.summary && dictation.purpose);
    let visible = "";
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (
        visible.includes("Fixture mode") &&
        visible.includes("Talking with Moo") &&
        visible.includes("Saved locally") &&
        visible.includes("And connect it to related notes.")
      )
        break;
      await delay(100);
    }
    assert.ok(
      visible.includes("Fixture mode") &&
        visible.includes("Talking with Moo") &&
        visible.includes("Saved locally") &&
        visible.includes("And connect it to related notes."),
    );
    fs.mkdirSync(evidenceDir, { recursive: true });
    fs.writeFileSync(
      path.join(evidenceDir, "desktop.png"),
      (await window.webContents.capturePage()).toPNG(),
    );
    await request("POST", "/api/input", { text: "That's all." });
    let afterEnd = await request("GET", "/api/state");
    for (let n = 0; n < 30 && afterEnd.state.conversationId; n++) {
      await delay(100);
      afterEnd = await request("GET", "/api/state");
    }
    assert.equal(afterEnd.state.conversationId, undefined, "Natural ending closes the conversation");
    await request("POST", "/api/input", { text: "What's even going on?" });
    const help = await request("GET", "/api/state");
    assert.equal(help.state.pendingOffer?.kind, "general_help");
    assert.equal(help.state.conversationId, undefined, "General help waits for the user's answer");
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (visible.includes("Moo will wait for your answer.")) break;
      await delay(100);
    }
    assert.ok(visible.includes("Moo will wait for your answer."));
    assert.ok(!visible.includes("Accepting captures"), "General help must not promise a screenshot");
    await request("POST", "/api/input", { text: "No, just save it." });
    const declined = await request("GET", "/api/state");
    assert.equal(declined.state.pendingOffer, undefined);
    assert.equal(declined.state.conversationId, undefined);
    assert.ok(declined.records.some(record => record.segments.some(segment => segment.text === "What's even going on?")));
    await request("POST", "/api/input", { text: "What's even going on?" });
    await request("POST", "/api/input", { text: "Yes, please." });
    const accepted = await request("GET", "/api/state");
    assert.ok(accepted.state.conversationId);
    assert.equal(accepted.state.pendingOffer, undefined);
    assert.ok(accepted.records.every(record => record.attachmentIds.length === 0));
    assert.equal(accepted.state.lastError, undefined);
    await request("POST", "/api/input", { text: "That's all." });
    await request("POST", "/api/session", { action: "stop" });
    for (let n = 0; n < 30; n++) {
      visible = await run("document.body.innerText");
      if (visible.includes("Start session") && visible.includes("Session off"))
        break;
      await delay(100);
    }
    assert.ok(
      visible.includes("Start session") && visible.includes("Session off"),
    );
    const evidence = {
      checkedAt: new Date().toISOString(),
      passed: true,
      fixture: true,
      scenario:
        "production custom protocol, narrow preload/API, saved enriched dictation, three-turn Moo, natural close, general-help decline/accept, session start/stop",
      nodeCount: state.records.length,
      conversationUserTurns: 3,
      rejectedFileTraversal: true,
      rendererNodeDisabled: true,
      nativeCaptureDisabled: true,
      generalHelpWaitedForReply: true,
      generalHelpCapturedNoScreenshot: true,
      electron: process.versions.electron,
    };
    fs.writeFileSync(
      path.join(root, ".data/validation/desktop-smoke.json"),
      JSON.stringify(evidence, null, 2) + "\n",
    );
    console.log("PASS desktop smoke; screenshot .data/validation/desktop.png");
    await finish(0);
  } catch (error) {
    console.error(error);
    await finish(1);
  }
});
