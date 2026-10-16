import { createRequire } from "node:module";
import { resolve } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const require = createRequire(import.meta.url);
const {
  localContentPath,
  trustedFrame,
  allowedRequest,
} = require("../../desktop/local-content.cjs");
const directory = resolve("apps/desktop/dist");

test("desktop protocol serves assets only inside the built UI", () => {
  assert.equal(
    localContentPath("moolai://app/", directory),
    resolve(directory, "index.html"),
  );
  assert.equal(
    localContentPath("moolai://app/assets/main.js", directory),
    resolve(directory, "assets/main.js"),
  );
  for (const url of [
    "file:///etc/passwd",
    "moolai://other/index.html",
    "moolai://user@app/index.html",
    "moolai://app:123/index.html",
    "moolai://app/..%2f..%2fpackage.json",
    "moolai://app/%5c..%5cpackage.json",
    "moolai://app/%00",
    "moolai://app/%invalid",
  ])
    assert.equal(localContentPath(url, directory), null, url);
});

test("renderer can list and revoke folders but cannot grant arbitrary paths", () => {
  assert.equal(allowedRequest("GET", "/api/local-folders"), true);
  assert.equal(allowedRequest("POST", "/api/local-folders/revoke"), true);
  for (const path of [
    "/api/local-folders/grant", "/api/local-folders/grant?path=/",
    "/api/local-folders/revoke/../grant", "/api/local-folders%2fgrant",
  ]) assert.equal(allowedRequest("POST", path), false, path);
});

test("archived desktop features are denied by the renderer request allowlist", () => {
  for(const path of ["/api/notes","/api/brain/query","/api/snapshot/export","/api/snapshot/import"])
    assert.equal(allowedRequest("POST",path),false,path);
  for(const path of ["/api/history/note","/api/export/note"])
    assert.equal(allowedRequest("GET",path),false,path);
  assert.equal(allowedRequest("GET","/api/related/note"),true);
  assert.equal(allowedRequest("GET","/api/attachment/screen.png"),true);
});

test("folder picker grants only the native selection and cancellation grants nothing", async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const requests: { path: string; body?: unknown }[] = [];
  let selection = { canceled: true, filePaths: [] as string[] };
  let dialogOptions: { message: string; properties: string[] } | undefined;
  const contents = { mainFrame: { url: "moolai://app/index.html" } };
  const context = vm.createContext({
    require(name: string) {
      if (name === "electron") return {
        app: { whenReady: () => new Promise(() => {}), on() {} },
        ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler), on() {} },
        protocol: { registerSchemesAsPrivileged() {} },
        dialog: { showOpenDialog: async (_window: unknown, options: typeof dialogOptions) => {
          dialogOptions = options;
          return selection;
        } },
      };
      if (name === "node:fs/promises") return {
        readFile: async () => JSON.stringify({ port: 4317, token: "desktop-token", pid: 1 }),
      };
      if (name === "./local-content.cjs") return { localContentPath, trustedFrame, allowedRequest };
      if (name === "./voice-lifecycle.cjs") return require("../../desktop/voice-lifecycle.cjs");
      return require(name);
    },
    __dirname: resolve("apps/desktop"),
    process: { env: {}, kill() {} },
    URL, AbortSignal, setTimeout,
    fetch: async (url: string, options: RequestInit) => {
      const path = new URL(url).pathname;
      requests.push({ path, ...(options.body ? { body: JSON.parse(String(options.body)) } : {}) });
      return new Response(JSON.stringify({ id: "selected" }));
    },
    testWindow: { webContents: contents },
  });
  vm.runInContext(await readFile(resolve("apps/desktop/electron.cjs"), "utf8"), context);
  vm.runInContext("window = testWindow", context);
  const event = { sender: contents, senderFrame: contents.mainFrame };
  const choose = handlers.get("moolai:choose-folder")!;
  assert.equal(await choose(event), null);
  assert.equal(requests.length, 0);
  selection = { canceled: false, filePaths: ["/user/selected-notes"] };
  await choose(event, { path: "/renderer/injected-path" });
  assert.deepEqual(requests.find((request) => request.path.endsWith("/grant"))?.body, {
    path: "/user/selected-notes",
  });
  assert.match(dialogOptions!.message, /configured model provider/);
  assert.deepEqual([...dialogOptions!.properties], ["openDirectory"]);
  await assert.rejects(choose({ sender: {}, senderFrame: contents.mainFrame }), /Untrusted/);
});

test("desktop IPC accepts only its own top-level document", () => {
  const url = "moolai://app/index.html";
  const contents = { mainFrame: { url } };
  assert.equal(
    trustedFrame(
      { sender: contents, senderFrame: contents.mainFrame },
      contents,
      url,
    ),
    true,
  );
  assert.equal(
    trustedFrame({ sender: contents, senderFrame: { url } }, contents, url),
    false,
  );
  assert.equal(
    trustedFrame(
      { sender: {}, senderFrame: contents.mainFrame },
      contents,
      url,
    ),
    false,
  );
  assert.equal(
    trustedFrame(
      { sender: contents, senderFrame: contents.mainFrame },
      contents,
      "https://other/",
    ),
    false,
  );
  assert.equal(trustedFrame({}, undefined, url), false);
});

test('external link boundary accepts only HTTP(S) URLs without credentials or controls',()=>{
 const {externalURL}=require('../../desktop/local-content.cjs');
 assert.equal(externalURL('https://example.com/docs?q=topic'),'https://example.com/docs?q=topic');
 for(const value of ['file:///etc/passwd','javascript:alert(1)','obsidian://open','https://user:secret@example.com','https://example.com/\nattack','relative.md',null]) assert.equal(externalURL(value),null);
});

test('an alive but slow runtime never launches a second host',async()=>{
 let spawns=0;
 const file=resolve('apps/desktop/electron.cjs');const localRequire=createRequire(file);
 const module={exports:{} as {ensureRuntime:()=>Promise<void>}};
 const context=vm.createContext({module,__dirname:resolve('apps/desktop'),URL,AbortSignal,setTimeout,
 process:{env:{},kill(){}},fetch:async()=>{throw Error('health timed out');},
 require(name:string){
 if(name==='electron')return {app:{whenReady:()=>new Promise(()=>{}),on(){}},ipcMain:{handle(){},on(){}},protocol:{registerSchemesAsPrivileged(){}}};
 if(name==='node:fs/promises')return {readFile:async()=>JSON.stringify({port:4317,pid:4242,token:'fixture'})};
 if(name==='node:child_process')return {spawn(){spawns++;throw Error('must not spawn');}};
 if(name.startsWith('./'))return localRequire(name);
 return localRequire(name);
 }});
 vm.runInContext(await readFile(file,'utf8')+'\nmodule.exports={ensureRuntime};',context);
 await assert.rejects(module.exports.ensureRuntime(),/existing Agent runtime is not responding/);assert.equal(spawns,0);
});
