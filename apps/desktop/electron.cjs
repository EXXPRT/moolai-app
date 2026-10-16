const {
  app,
  BrowserWindow,
  ipcMain,
  protocol,
  net,
  session,
  dialog,
  shell,
} = require("electron");
const { readFile, mkdir, open } = require("node:fs/promises");
const { join, resolve } = require("node:path");
const { homedir } = require("node:os");
const { spawn } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const { localContentPath, trustedFrame, allowedRequest, externalURL } = require("./local-content.cjs");
const { installVoiceLifecycle } = require("./voice-lifecycle.cjs");

protocol.registerSchemesAsPrivileged([
  {
    scheme: "moolai",
    privileges: { standard: true, secure: true, supportFetchAPI: true },
  },
]);

const root = resolve(__dirname, "../..");
const dataDir =
  process.env.MOOLAI_DATA_DIR ||
  join(homedir(), "Library/Application Support/Moolai");
const indexURL = "moolai://app/index.html";
const devURL = process.env.MOOLAI_DESKTOP_DEV_URL;
if (devURL && new URL(devURL).origin !== "http://127.0.0.1:5173")
  throw Error("Development UI must use http://127.0.0.1:5173");
const documentURL = devURL ? new URL("/", devURL).href : indexURL;
let window;
let streamAbort;
let startPromise;
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

async function connection() {
  const info = JSON.parse(
    await readFile(join(dataDir, "runtime.json"), "utf8"),
  );
  if (
    !Number.isInteger(info.port) ||
    info.port < 1024 ||
    info.port > 65535 ||
    typeof info.token !== "string" ||
    !info.token
  ) {
    throw Error("Invalid local runtime connection file");
  }
  process.kill(info.pid, 0);
  return { base: `http://127.0.0.1:${info.port}`, token: info.token };
}

const voiceLifecycle = installVoiceLifecycle({ app, connection, fetch: (...args) => fetch(...args) });

async function available() {
  let info;
  try { info = await connection(); }
  catch (error) {
    if (["ENOENT", "ESRCH"].includes(error.code)) return false;
    throw error;
  }
  try {
    const response = await fetch(`${info.base}/api/state`, {
      headers: { Authorization: `Bearer ${info.token}` },
      signal: AbortSignal.timeout(1000),
    });
    if (!response.ok) throw Error(`Runtime health failed (${response.status})`);
    return true;
  } catch {
    throw Error("The existing Agent runtime is not responding. Reconnect or use the Moo restart command; a second runtime was not started.");
  }
}

async function ensureRuntime() {
  if (await available()) return;
  if (!startPromise)
    startPromise = (async () => {
      await mkdir(dataDir, { recursive: true });
      const log = await open(join(dataDir, "runtime.log"), "a", 0o600);
      const child = spawn(
        process.env.MOOLAI_NODE || "node",
        [
          "--env-file-if-exists=runtime.env",
          "--import",
          "tsx",
          "apps/runtime/src/main.ts",
        ],
        {
          cwd: root,
          env: process.env,
          detached: true,
          stdio: ["ignore", log.fd, log.fd],
        },
      );
      let failure;
      child.once("error", (error) => {
        failure = error;
      });
      child.unref();
      await log.close();
      for (let n = 0; n < 60; n += 1) {
        if (failure) throw failure;
        if (await available()) return;
        await sleep(250);
      }
      throw Error(
        `Agent runtime did not start. Check ${join(dataDir, "runtime.log")}`,
      );
    })().finally(() => {
      startPromise = undefined;
    });
  await startPromise;
}

function trusted(event) {
  return trustedFrame(event, window?.webContents, documentURL);
}

async function runtimeRequest(method, path, body) {
  await ensureRuntime();
  const { base, token } = await connection();
  const response = await fetch(base + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: method === "POST" ? JSON.stringify(path === "/api/voice" && body?.action === "start" ? {...body,ownerPid:process.pid} : body || {}) : undefined,
    signal: AbortSignal.timeout(180_000),
  });
  const value = await response.json();
  if (!response.ok)
    throw Error(value?.error || "Agent request failed");
  return value;
}

ipcMain.handle("moolai:request", async (event, { method, path, body }) => {
  if (!trusted(event)) throw Error("Untrusted desktop request");
  if (!allowedRequest(method, path)) throw Error("Unsupported Agent request");
  return runtimeRequest(method, path, body);
});

ipcMain.handle("moolai:open-external", async (event, value) => {
  if (!trusted(event)) throw Error("Untrusted desktop request");
  const url=externalURL(value);
  if (!url) throw Error("Only public HTTP or HTTPS links can be opened");
  await shell.openExternal(url);
});

ipcMain.handle("moolai:choose-folder", async (event) => {
  if (!trusted(event)) throw Error("Untrusted desktop request");
  const selection = await dialog.showOpenDialog(window, {
    title: "Choose a folder for Moo to read",
    message: "Moo can search text in this folder. Retrieved excerpts may be sent to your configured model provider. You can remove access at any time.",
    buttonLabel: "Allow read access",
    properties: ["openDirectory"],
  });
  // Recheck after the dialog: a closing or changed window cannot grant access.
  if (!trusted(event)) throw Error("Desktop changed while choosing a folder");
  if (selection.canceled || !selection.filePaths[0]) return null;
  return runtimeRequest("POST", "/api/local-folders/grant", {
    path: selection.filePaths[0],
  });
});

async function stream(signal) {
  while (!signal.aborted && window && !window.isDestroyed()) {
    try {
      await ensureRuntime();
      const { base, token } = await connection();
      const response = await fetch(`${base}/api/events`, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok || !response.body)
        throw Error("Agent event connection failed");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder
          .decode(value, { stream: true })
          .replace(/\r\n/g, "\n");
        let end;
        while ((end = buffer.indexOf("\n\n")) >= 0) {
          const frame = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          const data = frame
            .split("\n")
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trimStart())
            .join("\n");
          if (data && window && !window.isDestroyed())
            window.webContents.send("moolai:event", JSON.parse(data));
        }
      }
    } catch (error) {
      if (!signal.aborted && window && !window.isDestroyed())
        window.webContents.send("moolai:event", {
          type: "notice",
          message: error.message,
        });
    }
    if (!signal.aborted) await sleep(2000);
  }
}

ipcMain.on("moolai:subscribe", (event) => {
  if (!trusted(event)) return;
  streamAbort?.abort();
  streamAbort = new AbortController();
  void stream(streamAbort.signal);
});
ipcMain.on("moolai:unsubscribe", (event) => {
  if (!trusted(event)) return;
  streamAbort?.abort();
});

app.whenReady().then(async () => {
  // Microphone and screen permissions belong to the Swift companion.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.setPermissionCheckHandler(() => false);
  protocol.handle("moolai", (request) => {
    const file = localContentPath(request.url, join(__dirname, "dist"));
    if (!file || !["GET", "HEAD"].includes(request.method))
      return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).href, { method: request.method });
  });
  window = new BrowserWindow({
    width: 1240,
    height: 860,
    minWidth: 850,
    minHeight: 600,
    backgroundColor: "#f5f4ef",
    title: "Moolai",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => {
    if (url !== documentURL) event.preventDefault();
  });
  window.webContents.on("render-process-gone", () => { void voiceLifecycle.stop(); });
  window.on("closed", () => {
    streamAbort?.abort();
    window = null;
  });
  await window.loadURL(documentURL);
});
// Quit stops audio, preserving the conversation and the independently runnable runtime.
app.on("window-all-closed", () => app.quit());
