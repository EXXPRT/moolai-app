import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The web demo runs in a browser: nothing main.ts reaches, statically or through import(), may need Node, the
// desktop host's native, speech or SQLite modules, the runtime, or a package the renderer doesn't already use.
const repo = fileURLToPath(new URL("../../../", import.meta.url));
const ENTRY = resolve(repo, "apps/web/src/main.ts");
const FORBIDDEN = new Set([
  ...["index", "native", "native-input", "speech", "asr-ready"].map(name => `packages/agent-host/src/${name}.ts`),
  ...["index", "sqlite"].map(name => `packages/brain/src/${name}.ts`),
]);
const PACKAGES = new Set(["react", "react-dom", "react-dom/client", "react/jsx-runtime", "cytoscape", "react-markdown",
  "remark-gfm", "remark-parse", "unified"]);

/** Every module a source loads at run time. `import type` and `export type` are erased before bundling, so they don't count. */
function specifiers(source: string) {
  const found: string[] = [];
  // The clause before `from` holds only names, braces, commas, `*`, `as` and `type`, so other exports never match.
  for (const match of source.matchAll(/^[ \t]*(?:import|export)\s+(type\s+)?[\w$\s{},*]*?\s*from\s*["']([^"']+)["']/gm))
    if (!match[1]) found.push(match[2]!);
  for (const match of source.matchAll(/^[ \t]*import\s*["']([^"']+)["']/gm)) found.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*(?:["']([^"']+)["']\s*\))?/g))
    found.push(match[1] ?? "<an import() of a computed specifier>");
  return found;
}

/** A relative specifier as the bundler resolves it: `.js` names the TypeScript source beside it. */
function resolveRelative(from: string, specifier: string) {
  const target = resolve(dirname(from), specifier);
  const candidates = target.endsWith(".js") ? [`${target.slice(0, -3)}.ts`, `${target.slice(0, -3)}.tsx`, target] : [target];
  return candidates.find(candidate => existsSync(candidate));
}

const repoPath = (file: string) => relative(repo, file).split(sep).join("/");
const forbiddenModule = (path: string) => FORBIDDEN.has(path) || path.startsWith("apps/runtime/");
function refusedSpecifier(specifier: string) {
  if (specifier.startsWith("node:")) return "a Node built-in";
  if (!specifier.startsWith(".") && !PACKAGES.has(specifier)) return "a package the web demo doesn't allow";
  return undefined;
}

function walk(entry: string) {
  const reached = new Set<string>(), problems: string[] = [], queue = [entry];
  while (queue.length) {
    const file = queue.pop()!;
    if (reached.has(file)) continue;
    reached.add(file);
    const name = repoPath(file);
    if (forbiddenModule(name)) problems.push(`reaches ${name}`);
    for (const specifier of specifiers(readFileSync(file, "utf8"))) {
      const refused = refusedSpecifier(specifier);
      if (refused) problems.push(`${name} imports ${specifier}: ${refused}`);
      if (refused || !specifier.startsWith(".")) continue;
      const target = resolveRelative(file, specifier);
      if (!target) problems.push(`${name} imports ${specifier}, which does not resolve`);
      else if (!target.endsWith(".css")) queue.push(target);
    }
  }
  return { reached: new Set([...reached].map(repoPath)), problems };
}

test("everything the web demo loads runs in a browser", () => {
  const { reached, problems } = walk(ENTRY);
  assert.deepEqual(problems, []);
  // The walk follows dynamic imports too: the Agent and the renderer load only after main.ts's capability check.
  for (const module of ["apps/web/src/demo-ui.ts", "apps/web/src/host.ts", "packages/agent/src/index.ts",
    "packages/agent-host/src/providers.ts", "packages/agent-host/src/thought-schedule.ts", "packages/brain/src/memory.ts",
    "apps/web/src/voice/mic.ts", "apps/desktop/src/main.tsx", "apps/desktop/src/BrainGraph.tsx"])
    assert.ok(reached.has(module), `${module} is not reached`);
});

test("the scan counts value imports, re-exports and dynamic imports, and skips type-only imports", () => {
  const source = [
    'import "./style.css";',
    'import type { Agent } from "../agent/src/index.js";',
    'import type {\n  BrainPort,\n} from "../brain/src/index.js";',
    'import React, { useState, type FC } from "react";',
    'import {\n  a,\n  b,\n} from "./values.js";',
    'export { c } from "./c.js";',
    'export type { D } from "./d.js";',
    'export * from "./e.js";',
    'export const f = 1; const g = h(from, "./not-a-specifier.js");',
    'const Graph = lazy(() => import("./BrainGraph.js"));',
    'const loaded = await import(name);',
  ].join("\n");
  assert.deepEqual(specifiers(source).sort(), ["./BrainGraph.js", "./c.js", "./e.js", "./style.css", "./values.js",
    "<an import() of a computed specifier>", "react"].sort());
});

test("the walk refuses Node, unexpected packages and the desktop host's native and storage modules", () => {
  assert.equal(refusedSpecifier("node:fs"), "a Node built-in");
  for (const specifier of ["fs", "ws", "react-dom/server", "<an import() of a computed specifier>"])
    assert.equal(refusedSpecifier(specifier), "a package the web demo doesn't allow", specifier);
  for (const specifier of ["react", "react-dom/client", "cytoscape", "./bridge.js", "../../desktop/src/main.tsx"])
    assert.equal(refusedSpecifier(specifier), undefined, specifier);
  for (const path of ["packages/agent-host/src/native-input.ts", "packages/agent-host/src/speech.ts", "packages/agent-host/src/index.ts",
    "packages/brain/src/sqlite.ts", "packages/brain/src/index.ts", "apps/runtime/src/server.ts"])
    assert.ok(forbiddenModule(path), path);
  for (const path of ["packages/agent-host/src/providers.ts", "packages/brain/src/memory.ts", "apps/desktop/src/main.tsx"])
    assert.ok(!forbiddenModule(path), path);
});
