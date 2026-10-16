// Synthetic PCM envelopes exercise transport/segmentation, not recognizer accuracy.
// Speech/noise annotations are used only by the scorer, never by the endpointer.
const speech = (ms, amplitude = 1800) => ({ ms, amplitude, kind: 'speech' });
const quiet = ms => ({ ms, amplitude: 0, kind: 'silence' });
const noise = (ms, amplitude) => ({ ms, amplitude, kind: 'noise' });
export const endpointCases = [
  { id: 'ordinary', parts: [quiet(200), speech(800), quiet(1600)] },
  { id: 'soft-first-syllable', parts: [quiet(200), speech(600, 100), speech(400), quiet(1600)] },
  { id: 'soft-final-syllable', parts: [speech(400), speech(240, 100), quiet(1600)] },
  { id: 'thinking-pause-700ms', parts: [speech(400), quiet(700), speech(400), quiet(1600)] },
  { id: 'breath-pause-300ms', parts: [speech(400), quiet(300), speech(400), quiet(1600)] },
  { id: 'digital-silence', parts: [quiet(2400)] },
  { id: 'low-background', parts: [noise(1600, 100), quiet(1600)] },
  { id: 'isolated-click', parts: [noise(20, 2000), quiet(1600)] },
  { id: 'quiet-whole-utterance', parts: [speech(800, 100), quiet(1600)] },
  { id: 'stop-with-short-final-frame', parts: [quiet(100), speech(377)] },
];

export function renderEndpointCase(input, sampleRate) {
  let offset = 0;
  const speechRanges = [];
  const buffers = input.parts.map(part => {
    const samples = Math.round(part.ms * sampleRate / 1000);
    const buffer = Buffer.alloc(samples * 2);
    // Alternating polarity avoids a DC-only signal while preserving exact RMS.
    for (let i = 0; i < samples; i++) buffer.writeInt16LE(i % 2 ? -part.amplitude : part.amplitude, i * 2);
    if (part.kind === 'speech') speechRanges.push({ start: offset, end: offset + samples });
    offset += samples;
    return buffer;
  });
  return { pcm: Buffer.concat(buffers), speechRanges };
}

export function endpointProfiles(config) {
  return [
    { id: 'current', config },
    { id: 'preroll-750', config: { ...config, preRollMs: 750 } },
    ...[400, 500, 600].map(endpointSilenceMs => ({ id: `pause-${endpointSilenceMs}`, config: {
      ...config, endpointSilenceMs, preRollMs: 750,
    } })),
  ];
}
