import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, realpath, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { LocalFilesPort, LocalFileSearch, LocalFileRead } from "../../contracts/src/index.js";

type Folder = { id: string; name: string; path: string };
type RunResult = { output: Buffer; truncated: boolean };
class ExcludedFile extends Error {}
const SEARCH_MS = 5_000;
const OUTPUT_BYTES = 256 * 1_024;
const FILE_BYTES = 4 * 1_024 * 1_024;
const READ_CHARS = 16_000;
const EXCLUSIONS = [
  ".env", ".env.*", "*.env", "*.env.*", "credentials", "credentials.*", "*credentials*.json",
  "secrets", "secrets.*", "*secrets*.json", "*.pem", "*.key", "*.p12", "*.pfx", "*.kdbx",
  "id_rsa*", "id_ed25519*", "id_ecdsa*", "private-key*", "*.sqlite*", "*.db", "*.log",
];

/** Read-only filesystem adapter. The core sees a port, never a shell or absolute paths. */
export class LocalFiles implements LocalFilesPort {
  private mutation = Promise.resolve();

  constructor(private readonly configPath: string, private readonly rgExecutable = "rg") {}

  async roots(): Promise<Folder[]> {
    let data: string;
    try { data = await readFile(this.configPath, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const saved: unknown = JSON.parse(data);
    if (!saved || typeof saved !== "object" || !("roots" in saved) || !Array.isArray(saved.roots)) {
      throw new Error("Local folder configuration is invalid.");
    }
    return saved.roots.map((value: unknown) => {
      if (!value || typeof value !== "object" || !("id" in value) || !("name" in value) || !("path" in value)
        || typeof value.id !== "string" || typeof value.name !== "string" || typeof value.path !== "string" || !isAbsolute(value.path)) {
        throw new Error("Local folder configuration is invalid.");
      }
      return { id: value.id, name: value.name, path: value.path };
    });
  }

  async grant(path: string): Promise<Folder> {
    return this.update(async () => {
      if (!isAbsolute(path)) throw new Error("Folder selection requires an absolute path.");
      const canonical = await realpath(path);
      if (!(await stat(canonical)).isDirectory()) throw new Error("Select a folder, not a file.");
      const roots = await this.roots();
      const existing = roots.find(root => root.path === canonical);
      if (existing) return existing;
      const root = { id: randomUUID(), name: basename(canonical) || canonical, path: canonical };
      await this.save([...roots, root]);
      return root;
    });
  }

  async revoke(id: string): Promise<void> {
    await this.update(async () => this.save((await this.roots()).filter(root => root.id !== id)));
  }

  async search(input: { query: string; mode?: "text" | "filename"; regex?: boolean; rootId?: string }, signal?: AbortSignal): Promise<LocalFileSearch> {
    if (typeof input.query !== "string" || !input.query.trim() || input.query.length > 500) {
      throw new Error("Rejected local search: supply a nonempty query of at most 500 characters.");
    }
    if (input.mode !== undefined && input.mode !== "text" && input.mode !== "filename") throw new Error("Rejected local search mode.");
    if (input.regex !== undefined && typeof input.regex !== "boolean") throw new Error("Rejected local search: regex must be true or false.");
    const deadline = Date.now() + SEARCH_MS;
    const roots = await this.roots();
    const selected = input.rootId ? roots.filter(root => root.id === input.rootId) : roots;
    if (input.rootId && !selected.length) throw new Error("Local folder access has been revoked or was never granted.");
    if (!selected.length) throw new Error("Local files unavailable: no folders have been selected.");
    const matches: LocalFileSearch["matches"] = [];
    let truncated = false;
    for (const root of selected) {
      await this.checkRoot(root.id);
      if (input.mode === "filename") {
        const listing = await this.list(root, deadline, signal);
        const found = await this.run(["--null-data", "--no-config", ...(input.regex ? [] : ["--fixed-strings"]), "--regexp", input.query], root.path, deadline, signal, listing.output);
        truncated ||= listing.truncated || found.truncated;
        for (const path of found.output.toString("utf8").split("\0").filter(Boolean)) {
          const item = await this.searchFile(root, path, deadline, signal);
          if (!item) continue;
          matches.push({ rootId: root.id, path: item.path, line: 1, excerpt: item.path, fingerprint: item.fingerprint });
          if (matches.length > 50) return { matches: matches.slice(0, 50), truncated: true };
        }
      } else {
        const result = await this.run(["--json", "--no-config", "--no-require-git", "--sort", "path", "--max-count", "51", ...this.globs(), ...(input.regex ? [] : ["--fixed-strings"]), "--regexp", input.query, "."], root.path, deadline, signal);
        truncated ||= result.truncated;
        const cache = new Map<string, Awaited<ReturnType<LocalFiles["searchFile"]>>>();
        for (const raw of result.output.toString("utf8").split("\n")) {
          if (!raw) continue;
          let event: { type?: string; data?: { path?: { text?: string }; lines?: { text?: string }; line_number?: number } };
          try { event = JSON.parse(raw); } catch { truncated = true; continue; }
          if (event.type !== "match" || !event.data?.path?.text || !event.data.lines?.text || !event.data.line_number) continue;
          const path = event.data.path.text;
          if (!cache.has(path)) cache.set(path, await this.searchFile(root, path, deadline, signal));
          const item = cache.get(path);
          if (!item) continue;
          const line = event.data.line_number;
          const text = item.text.split(/\r?\n/)[line - 1];
          if (text !== event.data.lines.text.replace(/\r?\n$/, "")) { truncated = true; continue; }
          matches.push({ rootId: root.id, path: item.path, line, excerpt: text.slice(0, 500), fingerprint: item.fingerprint });
          if (text.length > 500) truncated = true;
          if (matches.length > 50) return { matches: matches.slice(0, 50), truncated: true };
        }
      }
    }
    return { matches, truncated };
  }

  async read(input: { rootId: string; path: string; startLine?: number; lineCount?: number }, signal?: AbortSignal): Promise<LocalFileRead> {
    const deadline = Date.now() + SEARCH_MS;
    const startLine = input.startLine ?? 1;
    const lineCount = input.lineCount ?? 100;
    if (!Number.isSafeInteger(startLine) || startLine < 1 || !Number.isSafeInteger(lineCount) || lineCount < 1 || lineCount > 200) {
      throw new Error("Rejected local read: startLine must be positive and lineCount must be between 1 and 200.");
    }
    const root = await this.checkRoot(input.rootId);
    const path = this.relativePath(input.path);
    // An explicit read must obey the same ignores as discovery; passing the filename
    // directly to ripgrep would bypass its ignore rules.
    const listing = await this.list(root, deadline, signal);
    const visible = listing.output.toString("utf8").split("\0").some(value => value.replace(/^\.\//, "") === path);
    if (!visible) throw new Error(listing.truncated ? "Local read could not verify the file within the bounded listing; narrow the selected folder." : "Local file is ignored, hidden, excluded or unavailable.");
    const item = await this.checkedFile(root, path, deadline, signal);
    const lines = item.text.split(/\r?\n/);
    const passage = lines.slice(startLine - 1, startLine - 1 + lineCount).join("\n");
    return { rootId: root.id, path: item.path, startLine, text: passage.slice(0, READ_CHARS), fingerprint: item.fingerprint, truncated: startLine - 1 + lineCount < lines.length || passage.length > READ_CHARS };
  }

  private globs(): string[] { return EXCLUSIONS.flatMap(pattern => ["--glob", `!${pattern}`]); }

  private list(root: Folder, deadline: number, signal?: AbortSignal): Promise<RunResult> {
    return this.run(["--files", "--null", "--no-config", "--no-require-git", "--sort", "path", ...this.globs(), "."], root.path, deadline, signal);
  }

  private relativePath(path: string): string {
    if (typeof path !== "string" || !path || isAbsolute(path) || path.includes("\0") || path.split(/[\\/]/).some(part => part === ".." || (part.startsWith(".") && part !== "."))) {
      throw new ExcludedFile("Rejected local path: use a visible relative file inside the selected folder.");
    }
    const normalized = path.replace(/^\.\//, "");
    const name = basename(normalized).toLowerCase();
    if (/^(?:credentials|secrets)(?:\.|$)|credentials.*\.json$|secrets.*\.json$|^id_(?:rsa|ed25519|ecdsa)|^private-key|\.(?:env(?:\..*)?|pem|key|p12|pfx|kdbx|sqlite\w*|db|log)$/.test(name)) {
      throw new ExcludedFile("Local credential, log or database files are excluded.");
    }
    return normalized;
  }

  private async checkRoot(id: string): Promise<Folder> {
    const root = (await this.roots()).find(item => item.id === id);
    if (!root) throw new Error("Local folder access has been revoked or was never granted.");
    if (await realpath(root.path) !== root.path) throw new Error("Selected folder has moved or changed; select it again.");
    return root;
  }

  private async searchFile(root: Folder, path: string, deadline: number, signal?: AbortSignal) {
    try { return await this.checkedFile(root, path, deadline, signal); }
    catch (error) {
      // Expected exclusions are not search failures. Changes, permissions,
      // cancellation and revoked grants remain explicit failures, not no-matches.
      if (error instanceof ExcludedFile) return undefined;
      if ((error as NodeJS.ErrnoException).code) throw new Error(`Local file became unavailable during search: ${path.replace(/^\.\//, "")}`);
      throw error;
    }
  }

  private async checkedFile(root: Folder, path: string, deadline: number, signal?: AbortSignal) {
    this.checkDeadline(deadline, signal);
    await this.checkRoot(root.id);
    const normalized = this.relativePath(path);
    const fullPath = resolve(root.path, normalized);
    const canonical = await realpath(fullPath);
    const within = relative(root.path, canonical);
    if (!within || within === ".." || within.startsWith(`..${sep}`) || isAbsolute(within)) throw new Error("Rejected local path: symlink or traversal escapes the selected folder.");
    // ripgrep does not follow symlinks; keep reads consistent even if a file was
    // replaced with a link after listing it, including links to ignored secrets.
    if (canonical !== fullPath) throw new ExcludedFile("Symlink local files are excluded.");
    // O_NOFOLLOW also protects a final-component symlink swapped after realpath.
    const file = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const before = await file.stat();
      if (!before.isFile()) throw new ExcludedFile("Local file is not a regular text file.");
      if (before.size > FILE_BYTES) throw new Error("Local file exceeds the 4 MiB read limit.");
      const data = await file.readFile({ signal: this.boundSignal(deadline, signal) });
      const after = await file.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || data.length > FILE_BYTES) throw new Error("Local file changed while being read; request it again.");
      if (data.includes(0)) throw new ExcludedFile("Binary local files are excluded.");
      let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(data); } catch { throw new ExcludedFile("Non-UTF-8 local files are excluded."); }
      await this.checkRoot(root.id);
      if (await realpath(fullPath) !== canonical) throw new Error("Local file path changed while being read; request it again.");
      this.checkDeadline(deadline, signal);
      return { path: normalized, text, fingerprint: createHash("sha256").update(data).digest("hex") };
    } finally { await file.close(); }
  }

  private checkDeadline(deadline: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) throw new Error("Local file operation exceeded its five-second limit.");
  }

  private boundSignal(deadline: number, signal?: AbortSignal) {
    this.checkDeadline(deadline, signal);
    const timeout = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }

  private run(args: string[], cwd: string, deadline: number, signal?: AbortSignal, input?: Buffer): Promise<RunResult> {
    this.checkDeadline(deadline, signal);
    return new Promise((resolveRun, reject) => {
      const child = spawn(this.rgExecutable, args, { cwd, shell: false, stdio: [input ? "pipe" : "ignore", "pipe", "pipe"], env: { ...process.env, RIPGREP_CONFIG_PATH: "" } });
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      let stderr = "";
      let stopped: Error | undefined;
      const stop = (error: Error) => { stopped = error; child.kill("SIGKILL"); };
      const timer = setTimeout(() => stop(new Error("Local file operation exceeded its five-second limit.")), Math.max(1, deadline - Date.now()));
      const aborted = () => stop(new Error("Local file operation cancelled."));
      signal?.addEventListener("abort", aborted, { once: true });
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", aborted); };
      child.stdout?.on("data", (chunk: Buffer) => {
        const remaining = OUTPUT_BYTES - bytes;
        if (remaining > 0) { chunks.push(chunk.subarray(0, remaining)); bytes += Math.min(chunk.length, remaining); }
        if (chunk.length > remaining) { truncated = true; child.kill("SIGKILL"); }
      });
      child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString("utf8")).slice(0, 2_000); });
      child.once("error", (error: NodeJS.ErrnoException) => {
        cleanup();
        reject(new Error(error.code === "ENOENT" ? "Local search unavailable: ripgrep was not found. Install rg or configure MOOLAI_RG_PATH." : `Local search could not start (${error.code ?? "unknown error"}).`));
      });
      child.once("close", code => {
        cleanup();
        if (stopped) return reject(stopped);
        if (!truncated && code !== 0 && code !== 1) return reject(new Error(`Local search failed: ${stderr.trim() || `ripgrep exited with ${code}`}`));
        let output = Buffer.concat(chunks);
        if (truncated) {
          const separator = args.includes("--json") ? 10 : 0;
          output = output.subarray(0, output.lastIndexOf(separator) + 1);
        }
        resolveRun({ output, truncated });
      });
      child.stdin?.on("error", () => { /* rg may stop reading after invalid arguments. */ });
      if (input) child.stdin?.end(input);
      if (signal?.aborted) aborted();
    });
  }

  private async save(roots: Folder[]) {
    await mkdir(dirname(this.configPath), { recursive: true, mode: 0o700 });
    const temporary = `${this.configPath}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, roots }), { mode: 0o600 });
    await rename(temporary, this.configPath);
  }

  private async update<T>(action: () => Promise<T>): Promise<T> {
    const next = this.mutation.then(action);
    this.mutation = next.then(() => undefined, () => undefined);
    return next;
  }
}
