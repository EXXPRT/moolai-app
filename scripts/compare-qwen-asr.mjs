// Frozen synthetic comparison. Both recognizers receive identical PCM; no microphone.
import { execFile as callbackExec } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import WebSocket from 'ws';
import { wordErrors } from './evaluation-metrics.mjs';
const execFile = promisify(callbackExec);
const cases = [
  'Moo, explain how capillary action works. Use only my notes.',
  'I meant iodine, not iron. Explain the difference briefly.',
  'Do not end the conversation. I have another question.',
  'The note title is That is all. Keep discussing the experiment.',
  'That is all, thanks. Moo, finish conversation.',
  'The goalpost is five metres wide and two metres high.',
  'Evapotranspiration includes evaporation from the soil and transpiration from plants.',
  'There are four issues: speech recognition, incomplete summaries, broken connections, and missing dates.',
  'The batch identifier is unknown. Do not substitute the receipt number.',
  'First I planned to order fifteen units. Correction, fifty units. I have not placed the order.',
  'The pressure is two point five kilopascals, not twenty five.',
  'Please keep the final word telescope.',
];
const profiles = [{ name: 'Whisper Turbo', port: 8178, model: 'large-v3-turbo' }, { name: 'Qwen BF16', port: 8188, model: 'qwen3-asr-1.7b' }];
const output = process.argv[2] ?? '.data/validation/qwen-asr-20261001';
await mkdir(output, { recursive: true });
await writeFile(path.join(output, 'frozen.json'), JSON.stringify({ cases, voices: ['Samantha', 'Daniel'], profiles,
  additionalCases: ['digital silence', 'click'], settings: 'English, Moo hint, current 1200ms endpoint; Qwen whole-utterance Silero gate',
  scoring: 'strict normalized word error rate; retain all raw outputs and separate silent-input insertions',
  limitations: 'Synthetic speech and complete PCM burst, not human accuracy or end-of-speech latency' }, null, 2));
const temp = await mkdtemp(path.join(tmpdir(), 'moolai-qwen-'));
const rows = [];

async function transcribe(pcm, profile) {
  const health = await fetch(`http://127.0.0.1:${profile.port}/health`).then(r => r.json());
  if (!health.ready || health.activeCapture || health.model !== profile.model) throw Error(`${profile.name} unavailable, model mismatch or capture busy`);
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${profile.port}/v1/audio/transcriptions/realtime`);
    const events = []; const started = performance.now(); let settled = false;
    const finish = (error) => {
      if (settled) return; settled = true; clearTimeout(timer);
      const result = { transcript: events.filter(e => e.type.endsWith('.completed')).map(e => e.transcript).join(' '),
        decodeAndBridgeMs: Math.round(performance.now() - started), events };
      // Wait for close so the next case cannot race the bridge's capture release.
      const closeTimer = setTimeout(() => socket.terminate(), 1000);
      socket.once('close', () => { clearTimeout(closeTimer); if (error) reject(error); else resolve(result); });
      socket.close();
    };
    const timer = setTimeout(() => finish(Error('ASR comparison timed out')), 15000);
    socket.on('error', error => finish(error));
    socket.on('close', () => { if (!settled) finish(Error('ASR closed before commit')); });
    socket.on('open', () => socket.send(JSON.stringify({ type: 'session.update', session: { sample_rate: 16000, input_audio_format: 'pcm16' } })));
    socket.on('message', raw => {
      const event = JSON.parse(raw.toString()); events.push(event);
      if (event.type === 'session.updated') {
        for (let i = 0; i < pcm.length; i += 6400) socket.send(pcm.subarray(i, i + 6400));
        socket.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
      } else if (event.type === 'input_audio_buffer.committed') finish();
      else if (event.type === 'error') finish(Error(event.error.message));
    });
  });
}
try {
  let index = 0;
  for (const voice of ['Samantha', 'Daniel']) {
    for (let i = 0; i < cases.length; i++) {
      const filename = path.join(temp, 'speech.aiff');
      await execFile('say', ['-v', voice, '-r', '165', '-o', filename, cases[i]]);
      const { stdout: pcm } = await execFile('ffmpeg', ['-loglevel', 'error', '-i', filename, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'], { encoding: 'buffer', maxBuffer: 4 * 1024 * 1024 });
      await rm(filename);
      for (const profile of index++ % 2 ? [...profiles].reverse() : profiles) {
        try {
          const result = await transcribe(pcm, profile);
          rows.push({ case: i + 1, voice, model: profile.model, reference: cases[i], audioSha256: createHash('sha256').update(pcm).digest('hex'),
            audioSeconds: pcm.length / 32000, ...result, ...wordErrors(cases[i], result.transcript) });
        } catch (error) { rows.push({ case: i + 1, voice, model: profile.model, error: error.message }); }
      }
      pcm.fill(0); console.log(`Completed ${voice} ${i + 1}/${cases.length}`);
    }
  }
  for (const kind of ['silence', 'click']) {
    const pcm = Buffer.alloc(64000);
    if (kind === 'click') for (let i = 16000; i < 16160; i += 2) pcm.writeInt16LE(6000, i);
    for (const profile of profiles) {
      try { rows.push({ case: kind, model: profile.model, ...await transcribe(pcm, profile) }); }
      catch (error) { rows.push({ case: kind, model: profile.model, error: error.message }); }
    }
    pcm.fill(0);
  }
} finally {
  await rm(temp, { recursive: true, force: true });
  const totals = profiles.map(({model}) => {
    const speech = rows.filter(r => r.model === model && typeof r.case === 'number' && !r.error);
    const errors = speech.reduce((n,r) => n + r.errors, 0), words = speech.reduce((n,r) => n + r.referenceWords, 0);
    const times = speech.map(r => r.decodeAndBridgeMs).sort((a,b) => a-b);
    return { model, completed: speech.length, errors, words, wer: words ? errors / words : null,
      medianDecodeAndBridgeMs: times[Math.floor(times.length / 2)],
      nonSpeechInsertions: rows.filter(r => r.model === model && typeof r.case === 'string' && r.transcript?.trim()).length };
  });
  await writeFile(path.join(output, 'report.json'), JSON.stringify({ at: new Date().toISOString(), audioRemoved: true, paidCalls: 0,
    microphone: false, totals, rows }, null, 2) + '\n');
  console.log(JSON.stringify(totals));
}
