import net from 'node:net';

export async function requireFreePort(port) {
  await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(port, '127.0.0.1', () => probe.close(error => error ? reject(error) : resolve()));
  });
}

/** A duplicate launch must not load another model or interrupt an existing capture. */
export async function existingAsr(config, { timeoutMs = 1500 } = {}) {
  try { await requireFreePort(config.port); return undefined; }
  catch (error) { if (error.code !== 'EADDRINUSE') throw error; }
  let health;
  try {
    const response = await fetch(`http://127.0.0.1:${config.port}/health`, {
      signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (response.ok) {
      const reader = response.body.getReader();
      const parts = []; let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8192) throw new Error('Unexpected health response');
          parts.push(value);
        }
        health = JSON.parse(Buffer.concat(parts).toString());
      } finally { await reader.cancel().catch(() => {}); }
    }
  } catch { /* An occupied port is not necessarily Moolai. Never stop its owner. */ }
  const supportedTranscripts = health?.finalsOnly === true ||
    (health?.finalsOnly === false && health.livePreview === true && Number.isInteger(health.previewIntervalMs));
  if (health?.ready === true && supportedTranscripts && health.audioFilesCreated === false &&
      typeof health.activeCapture === 'boolean' && ['large-v3-turbo', 'large-v3', 'qwen3-asr-1.7b'].includes(health.model)) {
    if (health.model === config.model) return health;
    throw new Error(`ASR port ${config.port} is already running ${health.model}; requested ${config.model} was not started. Turn the microphone off and stop that ASR service before switching models.`);
  }
  throw new Error(`ASR loopback port ${config.port} is occupied, but no healthy Moolai ASR service could be verified. No model was loaded. Check the existing service before restarting.`);
}
