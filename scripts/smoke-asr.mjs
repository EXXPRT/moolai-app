// Real local inference, with synthetic speech. No microphone or cloud provider is used.
import { execFile as callbackExec } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
const execFile = promisify(callbackExec);
const dir = await mkdtemp(path.join(tmpdir(), "moolai-asr-"));
const phrase =
  "Moo, explain how gravity works. Use only my notes. Include a simple example and remember the final word, telescope.";
let socket, timer;
try {
  await execFile("say", [
    "-v",
    "Samantha",
    "-r",
    "155",
    "-o",
    path.join(dir, "input.aiff"),
    phrase,
  ]);
  await execFile("ffmpeg", [
    "-loglevel",
    "error",
    "-i",
    path.join(dir, "input.aiff"),
    "-ar",
    "16000",
    "-ac",
    "1",
    "-f",
    "s16le",
    path.join(dir, "input.pcm"),
  ]);
  const speechPcm = await readFile(path.join(dir, "input.pcm"));
  const trailingSilenceSeconds = Number(
    process.env.MOOLAI_TEST_ASR_SILENCE ?? 0,
  );
  if (
    !Number.isFinite(trailingSilenceSeconds) ||
    trailingSilenceSeconds < 0 ||
    trailingSilenceSeconds > 5
  )
    throw new Error("Test silence must be 0–5 seconds");
  const pcm = Buffer.concat([
    speechPcm,
    Buffer.alloc(Math.round(trailingSilenceSeconds * 32000)),
  ]);
  const started = performance.now();
  let firstDelta, firstTranscript, committedAt, commitSent;
  const events = [];
  socket = new WebSocket(
    process.env.MOOLAI_ASR_URL ??
      "ws://127.0.0.1:8178/v1/audio/transcriptions/realtime",
  );
  let readyResolve, doneResolve, fail;
  const ready = new Promise((resolve) => (readyResolve = resolve));
  const done = new Promise((resolve, reject) => {
    doneResolve = resolve;
    fail = reject;
  });
  timer = setTimeout(() => fail(new Error("Local ASR smoke timed out")), 60000);
  socket.addEventListener("open", () =>
    socket.send(
      JSON.stringify({
        type: "session.update",
        session: {
          sample_rate: 16000,
          language: "en-US",
          endpointing_ms: 1200,
          speech_contexts: [{ phrases: ["Moo"], boost: 3 }],
        },
      }),
    ),
  );
  socket.addEventListener("message", (event) => {
    const data = JSON.parse(event.data);
    events.push({ ms: Math.round(performance.now() - started), ...data });
    if (data.type === "session.updated") readyResolve();
    if (data.type.endsWith(".delta") && firstDelta === undefined)
      firstDelta = performance.now() - started;
    if ((data.type.endsWith(".delta") || data.type.endsWith(".completed")) && firstTranscript === undefined)
      firstTranscript = performance.now() - started;
    if (data.type === "input_audio_buffer.committed") {
      committedAt = performance.now();
      doneResolve();
    }
    if (data.type === "error") fail(new Error(JSON.stringify(data)));
  });
  socket.addEventListener("error", () =>
    fail(new Error("Local ASR WebSocket failed")),
  );
  // A rejected done promise also aborts a missing session.updated handshake.
  await Promise.race([ready, done]);
  const audioStarted = performance.now();
  for (let offset = 0; offset < pcm.length; offset += 3200) {
    socket.send(pcm.subarray(offset, offset + 3200));
    const due = audioStarted + offset / 32 + 100;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, due - performance.now())),
    );
  }
  commitSent = performance.now();
  socket.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
  await done;
  clearTimeout(timer);
  const finals = events.filter((event) => event.type.endsWith(".completed"));
  const transcript = finals
    .map((event) => event.transcript ?? event.text ?? "")
    .join(" ");
  const result = {
    date: new Date().toISOString(),
    kind: "synthetic real-time PCM; no microphone",
    phrase,
    audioSeconds: pcm.length / 32000,
    trailingSilenceSeconds,
    automaticFinalBeforeCommit: events.some(
      (event) =>
        event.type.endsWith(".completed") && event.ms < commitSent - started,
    ),
    firstDeltaMs: Math.round(firstDelta ?? -1),
    firstTranscriptMs: Math.round(firstTranscript ?? -1),
    finalsOnly: firstDelta === undefined,
    commitToAckMs: Math.round(committedAt - commitSent),
    transcript,
    mooRecognized: /\bmoo\b/i.test(transcript),
    finalWordPreserved: /telescope/i.test(transcript),
    events,
  };
  const output = process.argv[2];
  if (output) {
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(result, null, 2) + "\n");
  }
  console.log(JSON.stringify({ ...result, events: undefined }, null, 2));
  const failures = [];
  if (!result.mooRecognized) failures.push("Moo invocation was not recognized");
  if (!result.finalWordPreserved) failures.push("Final spoken word was lost");
  if (firstTranscript === undefined) failures.push("No transcript was received");
  if (trailingSilenceSeconds >= 3 && !result.automaticFinalBeforeCommit)
    failures.push("Three seconds of silence did not produce an automatic final");
  if (failures.length) throw new Error(failures.join("; "));
} finally {
  clearTimeout(timer);
  socket?.close();
  await rm(dir, { recursive: true, force: true });
}
