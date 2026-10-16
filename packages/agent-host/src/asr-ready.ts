import {setTimeout as delay} from 'node:timers/promises';

/** Wait without opening the microphone while the separately managed model loads. */
export async function waitForLocalAsr(signal: AbortSignal, options: {
  url?: string;
  timeoutMs?: number;
  intervalMs?: number;
  fetch?: typeof fetch;
} = {}): Promise<void> {
  const url = new URL(options.url ?? process.env.MOOLAI_ASR_URL ?? 'ws://127.0.0.1:8178/v1/audio/transcriptions/realtime');
  if (url.protocol !== 'ws:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password)
    throw Error('Local speech recognition requires a local ws:// address.');
  url.protocol = 'http:'; url.pathname = '/health'; url.search = ''; url.hash = '';
  const deadline = Date.now() + (options.timeoutMs ?? 90000);
  while (Date.now() < deadline) {
    signal.throwIfAborted();
    try {
      const response = await (options.fetch ?? fetch)(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, Math.min(2000, deadline - Date.now())))]),
        redirect: 'error',
      });
      if (response.ok && (await response.json()).ready === true) return;
    } catch { signal.throwIfAborted(); }
    await delay(Math.max(1, Math.min(options.intervalMs ?? 1000, deadline - Date.now())), undefined, {signal});
  }
  throw Error('Local speech recognition is unavailable. Start npm run asr, wait for the model to load, then turn the microphone on again.');
}
