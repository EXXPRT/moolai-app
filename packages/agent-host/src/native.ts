import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import type { Segment } from "../../contracts/src/index.js";

/** Narrow native protocol; diagnostics go to stderr and never become transcript events. */
export class NativeBridge {
  private process?: ChildProcessWithoutNullStreams;
  private next = 0;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(
    private executable: string,
    private onEvent: (event: {
      event: string;
      segment?: Segment;
      turnId?: string;
      [key: string]: unknown;
    }) => void,
    private timeouts: { request?: number; speech?: number; drain?: number; flush?: number } = {},
  ) {}
  private fail(child: ChildProcessWithoutNullStreams, message: string) {
    if (this.process !== child) return;
    this.process = undefined;
    // A broken input pipe does not imply the companion has exited. Retire it
    // before allowing another owner to start microphone or playback work.
    if (child.exitCode === null && child.signalCode === null) child.kill();
    for (const request of this.pending.values()) {
      clearTimeout(request.timer);
      request.reject(new Error(message));
    }
    this.pending.clear();
    this.onEvent({
      event: "status",
      listening: false,
      speaking: false,
      requestedOn: false,
      phase: message === "Native companion closed" ? "off" : "error",
      ...(message === "Native companion closed" ? {} : { error: message }),
    });
  }
  private start() {
    if (this.process) return;
    const child = spawn(this.executable, [], {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });
    this.process = child;
    createInterface({ input: child.stdout }).on("line", (line) => {
      if (this.process !== child) return;
      try {
        const data = JSON.parse(line);
        if (!data || typeof data !== "object" || Array.isArray(data))
          throw new Error("Invalid native response");
        if (typeof data.id === "number") {
          const request = this.pending.get(data.id);
          if (!request) return;
          clearTimeout(request.timer);
          this.pending.delete(data.id);
          if (data.error)
            request.reject(
              new Error(
                typeof data.error === "string"
                  ? data.error
                  : JSON.stringify(data.error),
              ),
            );
          else request.resolve(data.result);
        } else if (typeof data.event === "string") this.onEvent(data);
      } catch {
        this.onEvent({
          event: "error",
          message: "Invalid native protocol response",
        });
      }
    });
    child.stderr.on("data", (data) =>
      process.stderr.write(`[native] ${String(data)}`),
    );
    const failed = (message: string) => this.fail(child, message);
    child.stdin.on("error", (e) => failed(`Native input failed: ${e.message}`));
    child.on("error", (e) =>
      failed(
        `Native companion unavailable: ${e.message}. Run npm run build:native.`,
      ),
    );
    child.on("exit", (code) => failed(`Native companion exited (${code})`));
  }
  request<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.start();
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.pending.delete(id);
          reject(new Error(`Native ${method} timed out`));
        },
        (method === "speak" || method === "endSpeechAudio")
          ? (this.timeouts.speech ?? 180000)
          : method === "flushListening"
            ? (this.timeouts.flush ?? 60000)
          : method === "stopListening"
            ? (this.timeouts.drain ?? 40000)
            : (this.timeouts.request ?? 20000),
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.process!.stdin.write(
          JSON.stringify({ id, method, params }) + "\n",
        );
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  close() {
    const child = this.process;
    if (!child) return;
    this.fail(child, "Native companion closed");
  }
}
