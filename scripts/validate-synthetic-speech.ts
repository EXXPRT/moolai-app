/**
 * Local speech validation. Run with:
 * node --import tsx scripts/validate-synthetic-speech.ts .data/validation/synthetic-speech.json
 *
 * Known Apple-generated speech enters the configured ASR socket directly. This
 * never starts microphone capture and does not validate acoustic echo handling.
 */
import assert from "node:assert/strict";
import { execFile as callbackExec } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { NativeBridge } from "../apps/runtime/src/native.js";
import { readAsrConfig } from "./asr-config.mjs";
import type { Segment } from "../packages/contracts/src/index.js";

const execFile = promisify(callbackExec);
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const phrases = [
  "Can you explain why plants need sunlight?",
  "Use only my notes. Keep the first idea separate.",
  "Include a simple example and remember the final word, telescope.",
];
const output = path.resolve(process.argv[2] ?? ".data/validation/synthetic-speech.json");
const started = performance.now();
const events: Array<Record<string, unknown>> = [];
const nativeEvents: Array<Record<string, unknown>> = [];
const segments: Segment[] = [];
const checks: { name: string; passed: boolean }[] = [];
const check = (name: string, passed: boolean) => checks.push({ name, passed });
const blocks: { index: number; phrase: string; text: string; audioSeconds: number; sentAtMs: number; finalAtMs?: number }[] = [];
const report: Record<string, unknown> = {
  checkedAt: new Date().toISOString(),
  mode: "local synthetic ASR and native Apple speech output; no microphone or hosted providers",
  phrases,
  checks,
  blocks,
  segments,
  events,
  nativeEvents,
  microphoneStarted: false,
  caveats: [
    "Generated speech is not evidence of AirPods or human speech recognition accuracy.",
    "Native TTS completion and listening=false are checked; acoustic echo and barge-in are not tested.",
    "These are ASR source events. The separate workflow report verifies Agent routing and persistence.",
  ],
};
let temporaryDirectory: string | undefined;
let socket: WebSocket | undefined;
let native: NativeBridge | undefined;
let socketError: Error | undefined;
let ready = false, committed = false;
let commitSentAt: number | undefined;
let firstTranscriptAt: number | undefined;
const elapsed = () => Math.round(performance.now() - started);
async function waitFor(condition: () => boolean, timeoutMs: number, message: string) {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (socketError) throw socketError;
    if (performance.now() >= deadline) throw new Error(message);
    await delay(20);
  }
}
async function sendPcm(pcm: Buffer) {
  const began = performance.now();
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    if (socketError) throw socketError;
    assert.equal(socket!.readyState, WebSocket.OPEN, "ASR must remain connected while streaming");
    const frame = pcm.subarray(offset, Math.min(offset + 3200, pcm.length));
    socket!.send(new Uint8Array(frame));
    await delay(Math.max(0, began + (offset + frame.length) / 32 - performance.now()));
  }
}

try {
  const config = await readAsrConfig();
  report.asrConfiguration = config;
  const url = `ws://127.0.0.1:${config.port}/v1/audio/transcriptions/realtime`;
  assert.ok(!process.env.MOOLAI_ASR_URL || process.env.MOOLAI_ASR_URL === url,
    "Any ASR URL override must match the checked configuration");
  process.env.MOOLAI_ASR_URL = url;
  const healthResponse = await fetch(`http://127.0.0.1:${config.port}/health`, {
    signal: AbortSignal.timeout(3000),
  });
  assert.equal(healthResponse.status, 200);
  const health = await healthResponse.json() as Record<string, unknown>;
  report.bridgeHealth = health;
  assert.equal(health.ready, true);
  assert.equal(health.activeCapture, false, "Do not interrupt an existing ASR capture");
  for (const key of ["model", "language", "initialPrompt", "inferencePort"] as const)
    assert.equal(health[key], config[key], `Loaded ASR ${key} must match configuration`);
  check("loaded_asr_matches_configuration", true);

  temporaryDirectory = await mkdtemp(path.join(tmpdir(), "moolai-synthetic-speech-"));
  const pcmBlocks: Buffer[] = [];
  for (const [index, phrase] of phrases.entries()) {
    const aiff = path.join(temporaryDirectory, `${index}.aiff`);
    const pcm = path.join(temporaryDirectory, `${index}.pcm`);
    await execFile("/usr/bin/say", ["-v", "Samantha", "-r", "155", "-o", aiff, phrase]);
    await execFile("ffmpeg", ["-loglevel", "error", "-i", aiff, "-ar", "16000", "-ac", "1", "-f", "s16le", pcm]);
    pcmBlocks.push(await readFile(pcm));
  }
  socket = new WebSocket(url);
  socket.addEventListener("open", () => socket!.send(JSON.stringify({
    type: "session.update", session: { sample_rate: 16000, input_audio_format: "pcm16" },
  })));
  socket.addEventListener("error", () => { socketError = new Error("Local ASR socket failed"); });
  socket.addEventListener("close", () => {
    if (!committed) socketError = new Error("Local ASR closed before acknowledging the final words");
  });
  socket.addEventListener("message", (message) => {
    try {
      const event = JSON.parse(String(message.data)) as Record<string, unknown>;
      const atMs = elapsed();
      events.push({ atMs, ...event });
      if (event.type === "session.updated") ready = true;
      if (event.type === "error") socketError = new Error(JSON.stringify(event));
      if (event.type === "conversation.item.input_audio_transcription.completed") {
        firstTranscriptAt ??= atMs;
        const block = blocks[segments.length];
        if (block) {
          block.finalAtMs = atMs;
          block.text = String(event.transcript ?? "");
        }
        segments.push({
          id: randomUUID(), turnId: randomUUID(), revision: 1, speaker: "user",
          text: String(event.transcript ?? ""), final: true, createdAt: new Date().toISOString(),
        });
      }
      if (event.type === "input_audio_buffer.committed") committed = true;
    } catch (error) { socketError = error instanceof Error ? error : new Error(String(error)); }
  });
  await waitFor(() => ready, 5000, "Local ASR did not configure the stream");
  for (const [index, pcm] of pcmBlocks.entries()) {
    blocks.push({ index, phrase: phrases[index]!, text: "", audioSeconds: pcm.length / 32000, sentAtMs: elapsed() });
    await sendPcm(pcm);
    if (index < pcmBlocks.length - 1) {
      await sendPcm(Buffer.alloc((config.endpointSilenceMs + 200) * 32));
      await waitFor(() => segments.length > index, 15000, `ASR did not finalize block ${index + 1} after a pause`);
    }
  }
  report.finalsBeforeCommit = segments.length;
  commitSentAt = elapsed();
  socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  await waitFor(() => committed, 15000, "Local ASR did not acknowledge the final flush");
  report.commitToAckMs = elapsed() - commitSentAt;
  report.firstTranscriptMs = firstTranscriptAt;
  report.transcript = segments.map((segment) => segment.text).join(" ");
  check("three_ordered_source_blocks", segments.length === 3);
  check("first_two_blocks_finalized_after_pause", Number(report.finalsBeforeCommit) >= 2);
  check("direct_question_retained", /explain.*plants.*sunlight/i.test(segments[0]?.text ?? ""));
  check("notes_only_and_separate_idea_retained", /only my notes/i.test(segments[1]?.text ?? "") && /first idea separate/i.test(segments[1]?.text ?? ""));
  check("final_word_survived_commit", /\btelescope\b/i.test(segments.at(-1)?.text ?? ""));
  check("final_flush_acknowledged", committed);
  socket.close();

  native = new NativeBridge(path.resolve("native/build/Moolai Native.app/Contents/MacOS/MoolaiNative"),
    (event) => nativeEvents.push({ atMs: elapsed(), ...event }));
  const beforeSpeech = await native.request<Record<string, unknown>>("health");
  assert.equal(beforeSpeech.listening, false);
  report.nativeBeforeSpeech = beforeSpeech;
  const speechStarted = elapsed();
  const speech = await native.request<{ completed: boolean }>("speak", {
    text: "Your thought is saved. Would you like help with that?",
  });
  report.nativeSpeechMs = elapsed() - speechStarted;
  const afterSpeech = await native.request<Record<string, unknown>>("health");
  report.nativeAfterSpeech = afterSpeech;
  check("apple_speech_completed", speech.completed === true);
  check("microphone_remained_off", afterSpeech.listening === false &&
    nativeEvents.every((event) => event.listening !== true));
  check("speech_status_observed", nativeEvents.some((event) => event.speaking === true));
  check("no_native_transcript_generated", !nativeEvents.some((event) => event.event === "transcript"));
  check("native_speech_finished", afterSpeech.speaking === false);
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  process.exitCode = 1;
} finally {
  socket?.close();
  native?.close();
  if (temporaryDirectory) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    const remains = await access(temporaryDirectory).then(() => true, () => false);
    check("temporary_synthetic_audio_removed", !remains);
  }
  report.passed = !report.error && checks.every((item) => item.passed);
  if (!report.passed) process.exitCode = 1;
  report.completedAt = new Date().toISOString();
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify({ output, passed: report.passed, error: report.error, checks,
    transcript: report.transcript, commitToAckMs: report.commitToAckMs }, null, 2));
}
