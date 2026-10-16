import { createWhisperBridge } from '../whisper-bridge.mjs';
import { QwenDecoder } from './decoder.mjs';

export async function startQwen(config, { createDecoder = () => new QwenDecoder() } = {}) {
  const decoder = createDecoder();
  let bridge;
  let requestedStop = false;
  let finish;
  const stopped = new Promise(resolve => { finish = resolve; });
  const onSignal = () => { requestedStop = true; finish(); void decoder.close(); };
  process.once('SIGTERM', onSignal); process.once('SIGINT', onSignal);
  try {
    console.log('Loading pinned Qwen3-ASR-1.7B BF16 on Metal; this launcher does not enable the microphone.');
    await decoder.ready;
    bridge = createWhisperBridge(config, {
      decode: decoder.decode.bind(decoder),
      endpointing: 'local PCM energy/pause; Silero utterance speech gate; original audio preserved',
      onError: error => finish(error),
    });
    await bridge.listen();
    decoder.child.once('exit', finish);
    console.log(`Local Qwen trial ready at ws://127.0.0.1:${config.port}/v1/audio/transcriptions/realtime; no word alignment`);
    const failure = await stopped;
    if (failure instanceof Error) throw failure;
    if (!requestedStop && decoder.failure) throw decoder.failure;
  } finally {
    try { await bridge?.close(); }
    finally {
      try { await decoder.close(); }
      finally { process.removeListener('SIGTERM', onSignal); process.removeListener('SIGINT', onSignal); }
    }
  }
}
