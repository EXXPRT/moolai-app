// Contracts shared by the web demo's modules. Each module is built against these, so change one only
// together with every caller. The HTTP contract with the demo gateway is in docs/web-demo.md.
import type { AgentEvent, BrainPort, BrainRecord, LocalFolder, Segment } from "../../../packages/contracts/src/index.js";
import type { Agent } from "../../../packages/agent/src/index.js";
import type { BackendProviders, FixtureProviders } from "../../../packages/agent-host/src/providers.js";
import type { HostTextKey } from "../../desktop/src/snapshot.js";

export type Emit = (event: AgentEvent) => void;

/** The `window.moolai` surface the renderer uses (apps/desktop/src/main.tsx), as the web bridge provides it. */
export interface MoolaiApi {
  request<T = unknown>(method: "GET" | "POST", path: string, body?: unknown): Promise<T>;
  subscribe(callback: (event: AgentEvent) => void): () => void;
  chooseFolder(): Promise<LocalFolder | null>;
  openExternal?(url: string): Promise<void>;
  /** Web wording for the desktop's host-specific lines. */
  readonly text?: Partial<Record<HostTextKey, string>>;
}

/** `{"detail": code}` from the demo gateway. */
export type DemoErrorCode =
  | "invalid_session" | "session_expired" | "turnstile_failed" | "extract_not_allowed" | "image_not_allowed"
  | "not_found" | "body_too_large" | "unsupported_media_type" | "invalid_json" | "invalid_audio"
  | "session_limit" | "session_rate_limited" | "demo_budget_exhausted" | "demo_unavailable" | "voice_unavailable";

/** GET /api/demo/config */
export interface DemoConfig {
  live: boolean;
  voice: boolean;
  reason?: string;
  turnstileSiteKey: string;
  budget: "ok" | "low" | "exhausted";
}
/** POST /api/demo/session */
export interface DemoSession { token: string; expiresAt: string }

/** Why live calls stopped for this page. Each one stops voice once and shows a lasting banner. */
export type DemoLimit = "session_expired" | "session_limit" | "budget_exhausted" | "unavailable" | "voice_unavailable";
export interface Processing { status: "available" | "unavailable" | "checking"; checkedAt?: string }

/** The microphone status the renderer reads as `snapshot.native` (main.tsx:143, 209-225). */
export type VoicePhase = "off" | "connecting_asr" | "listening" | "finishing_transcription" | "error";
export interface VoiceStatus {
  enabled: boolean;
  requestedOn: boolean;
  listening: boolean;
  speaking: boolean;
  phase: VoicePhase;
  error: string | null;
}

// ---- Voice pipeline (apps/web/src/voice) ----

/** What the voice pipeline calls on the Agent; `Agent` satisfies it. */
export interface VoiceSink {
  speechStarted(options?: { paused?: boolean }): Promise<void>;
  recognitionRejected(): Promise<void>;
  ingest(segment: Segment): Promise<unknown>;
  settleTurn(turnId: string): Promise<unknown>;
  recognitionContext(): Promise<string>;
}
/** Sends one WAV (16 kHz mono PCM16) with its recognition prompt; resolves to the transcript text. */
export type Transcriber = (wav: Uint8Array, prompt: string, signal: AbortSignal) => Promise<string>;
/** Playback state the pipeline reads for half-duplex gating. `quietSince` is a `clock()` time, -Infinity before any audio. */
export interface SpeechGate { readonly audible: boolean; readonly quietSince: number }

export interface VoiceControllerOptions {
  sink: VoiceSink;
  transcribe: Transcriber;
  speech: SpeechGate;
  id(): string;
  now(): string;
  /** Milliseconds, monotonic. Defaults to performance.now. */
  clock?: () => number;
  onError(stage: "save" | "route" | "transcribe", error: unknown): void;
  /** Debug overlay and auto-off: called on onsets and whenever the outcome queue changes. */
  onActivity?(activity: { onset?: true; pending: number; rms?: number }): void;
  tailMs?: number;
  previewMinVoicedMs?: number;
  minVoicedMs?: number;
  transcribeTimeoutMs?: number;
}
export interface VoiceController {
  /** Mono samples in [-1, 1] at `sampleRate`; the controller downsamples to 16 kHz itself. */
  accept(samples: Float32Array, sampleRate: number): void;
  /** Mic stop: commit the open utterance and wait until every outcome is applied. */
  finish(timeoutMs?: number): Promise<void>;
  /** Page close: drop the open utterance and pending transcriptions. */
  discard(): Promise<void>;
  readonly utteranceOpen: boolean;
  readonly pending: number;
}
export interface MicHandle { readonly sampleRate: number; stop(): void }
/** Opens the microphone (or the localhost e2e feed) and delivers native-rate mono samples. */
export type OpenMic = (onSamples: (samples: Float32Array, sampleRate: number) => void) => Promise<MicHandle>;
/** Injected into the host by main.ts, so host.ts never imports the voice modules directly. */
export interface VoiceRuntime {
  open: OpenMic;
  createController(options: VoiceControllerOptions): VoiceController;
  transcribe: Transcriber;
}

// ---- Speech (apps/web/src/speech.ts) ----

/** Fetches one spoken part as audio (POST /api/v1/speech). */
export type Synthesize = (text: string, signal: AbortSignal) => Promise<Blob>;
/** The SpeechPort the Agent gets, plus what the host and the voice pipeline need. */
export interface WebSpeechPort extends SpeechGate {
  speak(text: string): Promise<void>;
  stop(): Promise<void>;
  resume(): Promise<void>;
  /** Pauses audible playback; true only when audio really was playing. */
  pause(): boolean;
  readonly heldPaused: boolean;
  /** The host merges this into its status; the speech port never emits `voice` events itself. */
  onAudibleChange(listener: (audible: boolean) => void): () => void;
  close(): void;
}

// ---- Seed (apps/web/src/seed.ts) ----

export interface SeedAttachment { id: string; mimeType: string; base64: string }
/** public/seed.json: records and attachments only. No history, state or operations, so loading makes no provider call. */
export interface SeedFile { version: 1; generatedAt: string; records: BrainRecord[]; attachments: SeedAttachment[] }

// ---- Host (apps/web/src/host.ts) ----

export type VoiceAction = "start" | "stop" | "flush";
export interface WebHostOptions {
  brain: BrainPort;
  providers: BackendProviders | FixtureProviders;
  emit: Emit;
  speech: WebSpeechPort;
  /** The sample worksheet that screen help reads instead of the visitor's screen. */
  worksheet(): Promise<{ mimeType: string; bytes: Uint8Array }>;
  onWorksheet?(): void;
  /** Absent in fixture mode: voice start then fails with a readable message. */
  voice?: VoiceRuntime;
  id?: () => string;
  now?: () => string;
  timeZone?: string;
  thoughtIntervalMs?: number;
  idleMicOffMs?: number;
}
export interface WebHost {
  readonly agent: Agent;
  voice(action: VoiceAction): Promise<void>;
  /** The merged microphone and playback status; the only source of `snapshot.native`. */
  nativeSnapshot(): VoiceStatus;
  /** A demo limit was hit: stop voice once. */
  onLimit(limit: DemoLimit): void;
  close(): Promise<void>;
}
