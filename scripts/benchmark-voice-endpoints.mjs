import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { PcmEndpointer } from './pcm-endpointer.mjs';
import { endpointCases, endpointProfiles, renderEndpointCase } from './voice-endpoint-fixtures.mjs';
import { readAsrConfig } from './asr-config.mjs';

export function evaluateEndpoint(input, profile, sampleRate, packetSamples = [2048]) {
  const { pcm, speechRanges } = renderEndpointCase(input, sampleRate);
  const utterances = [];
  const endpoint = new PcmEndpointer(profile.config, sampleRate, item => utterances.push(item));
  for (let offset = 0, index = 0; offset < pcm.length; index++) {
    const end = Math.min(pcm.length, offset + packetSamples[index % packetSamples.length] * 2);
    endpoint.push(pcm.subarray(offset, end)); offset = end;
  }
  endpoint.commit();
  const contains = sample => utterances.some(u => sample >= u.startSample && sample < u.endSample);
  const retained = speechRanges.reduce((total, range) => total + utterances.reduce((count, u) =>
    count + Math.max(0, Math.min(u.endSample, range.end) - Math.max(u.startSample, range.start)), 0), 0);
  const samples = speechRanges.reduce((n, r) => n + r.end - r.start, 0);
  const output = {
    case: input.id, profile: profile.id, sampleRate,
    utterances: utterances.length,
    missedSpeech: samples > 0 && !utterances.length,
    falseActivation: samples === 0 && utterances.length > 0,
    splitThought: samples > 0 && utterances.length > 1,
    retainedSpeechFraction: samples ? retained / samples : null,
    firstSampleRetained: samples ? contains(speechRanges[0].start) : null,
    finalSampleRetained: samples ? contains(speechRanges.at(-1).end - 1) : null,
    boundaries: utterances.map(({ startSample, endSample, lastVoicedSample, trigger }) => ({
      startSample, endSample, trigger,
      endpointWaitMs: trigger === 'pause' ? (endSample - lastVoicedSample) * 1000 / sampleRate : null,
    })),
  };
  // Assert byte identity here too: retention metrics cannot hide substituted audio.
  for (const u of utterances) {
    if (!u.pcm.equals(pcm.subarray(u.startSample * 2, u.endSample * 2)))
      throw new Error('Endpoint changed the captured samples');
    u.pcm.fill(0);
  }
  pcm.fill(0);
  return output;
}

export function endpointReport(config) {
  const profiles = endpointProfiles(config);
  return {
    kind: 'deterministic PCM segmentation; no speech recognition or acoustic playback',
    productionChanged: false, microphoneUsed: false, modelCalls: 0, audioFilesCreated: false,
    limits: ['Sample retention is not word accuracy.', 'Endpoint wait is audio time, not total response latency.',
      'Energy detection cannot distinguish all noise from speech.', 'No profile is promoted without representative human-speech validation.'],
    profiles: profiles.map(p => ({ id: p.id, endpointSilenceMs: p.config.endpointSilenceMs, preRollMs: p.config.preRollMs })),
    cases: endpointCases,
    rows: profiles.flatMap(p => [16000, 24000, 44100, 48000].flatMap(rate =>
      endpointCases.map(c => evaluateEndpoint(c, p, rate)))),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = endpointReport(await readAsrConfig());
  const output = process.argv[2] ?? '.data/validation/voice-endpoints.json';
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ output, cases: report.cases.length, profiles: report.profiles.length,
    sampleRates: 4, observations: report.rows.length, modelCalls: 0, productionChanged: false }));
}
