// Mono microphone capture for apps/web/src/voice/mic.ts. Render quanta are 128 frames, so input is batched
// to about 20 ms per message, and each batch is a fresh copy the engine never reuses.
class MoolaiCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = Math.max(128, Math.round(sampleRate * 0.02));
    this.batch = new Float32Array(this.size);
    this.filled = 0;
    this.stopped = false;
    this.port.onmessage = event => { if (event.data === 'stop') this.stopped = true; };
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    for (let offset = 0; offset < channel.length;) {
      const count = Math.min(channel.length - offset, this.size - this.filled);
      this.batch.set(channel.subarray(offset, offset + count), this.filled);
      this.filled += count; offset += count;
      if (this.filled === this.size) {
        this.port.postMessage(this.batch, [this.batch.buffer]);
        this.batch = new Float32Array(this.size);
        this.filled = 0;
      }
    }
    return true;
  }
}

registerProcessor('moolai-capture', MoolaiCapture);
