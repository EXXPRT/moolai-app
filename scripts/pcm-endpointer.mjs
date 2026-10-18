// Energy endpointing only, not a speech classifier. Keep analysis frames independent
// of transport packets so packet size cannot change which audio reaches ASR.
// Reading aloud rarely pauses for the full endpoint. Past three quarters of the utterance limit a
// sentence gap ends the utterance; at the limit it is emitted as it stands and the next frame starts
// a new one, so continuous speech is split and never dropped (MOO-074).
const LONG_UTTERANCE_SHARE = 0.75;
const SENTENCE_GAP_MS = 300;
export class PcmEndpointer {
  constructor(config, sampleRate, onUtterance, onPreview) {
    this.config = config;
    this.sampleRate = sampleRate;
    this.onUtterance = onUtterance;
    this.onPreview = onPreview;
    this.utteranceSequence = 0;
    this.frameBytes = Math.max(2, Math.round(sampleRate * 0.02) * 2);
    this.preRollBytes = Math.ceil(sampleRate * config.preRollMs / 1000) * 2;
    this.pending = Buffer.alloc(0);
    this.samples = 0;
    this.committed = false;
    this.resetUtterance();
  }

  resetUtterance() {
    this.preRoll = Buffer.alloc(0);
    this.chunks = [];
    this.bytes = 0;
    this.silenceSamples = 0;
    this.revision = 0;
    this.previewSamples = 0;
  }

  push(data, context = '') {
    if (this.committed) throw new Error('PCM arrived after the final commit');
    if (data.length % 2) throw new Error('PCM16 payload must have an even byte length');
    let offset = 0;
    if (this.pending.length) {
      const needed = this.frameBytes - this.pending.length;
      const count = Math.min(needed, data.length);
      this.pending = Buffer.concat([this.pending, data.subarray(0, count)]);
      offset = count;
      if (this.pending.length < this.frameBytes) return;
      this.frame(this.pending, this.pendingContext);
      this.pending = Buffer.alloc(0);
    }
    while (offset + this.frameBytes <= data.length) {
      this.frame(data.subarray(offset, offset + this.frameBytes), context);
      offset += this.frameBytes;
    }
    if (offset < data.length) {
      this.pending = Buffer.from(data.subarray(offset));
      this.pendingContext = context;
    }
  }

  frame(frame, context) {
    let square = 0;
    for (let i = 0; i < frame.length; i += 2) square += (frame.readInt16LE(i) / 32768) ** 2;
    const voiced = Math.sqrt(square / (frame.length / 2)) >= this.config.rmsThreshold;
    const start = this.samples;
    this.samples += frame.length / 2;
    if (!this.bytes && !voiced) {
      this.preRoll = Buffer.concat([this.preRoll, frame]);
      if (this.preRoll.length > this.preRollBytes)
        this.preRoll = Buffer.from(this.preRoll.subarray(this.preRoll.length - this.preRollBytes));
      return;
    }
    if (!this.bytes) {
      this.utteranceSequence++;
      this.context = context;
      this.startSample = start - this.preRoll.length / 2;
      if (this.preRoll.length) { this.chunks.push(this.preRoll); this.bytes += this.preRoll.length; }
      this.preRoll = Buffer.alloc(0);
    }
    this.chunks.push(Buffer.from(frame)); this.bytes += frame.length;
    this.silenceSamples = voiced ? 0 : this.silenceSamples + frame.length / 2;
    if (voiced) this.lastVoicedSample = this.samples;
    const limit = this.sampleRate * 2 * this.config.maxUtteranceSeconds;
    const endpointMs = this.bytes >= limit * LONG_UTTERANCE_SHARE
      ? Math.min(SENTENCE_GAP_MS, this.config.endpointSilenceMs) : this.config.endpointSilenceMs;
    if (this.silenceSamples * 1000 >= this.sampleRate * endpointMs) this.emit('pause');
    else if (this.bytes + this.frameBytes > limit) this.emit('limit');
    else if (voiced && this.onPreview && !this.committed &&
      (this.samples - this.startSample - this.previewSamples) * 1000 >= this.sampleRate * (this.config.previewIntervalMs ?? 2000)) {
      this.previewSamples = this.samples - this.startSample;
      this.onPreview(this.snapshot('preview'));
    }
  }

  snapshot(trigger) {
    return { pcm: Buffer.concat(this.chunks, this.bytes), context: this.context,
      startSample: this.startSample, endSample: this.samples, lastVoicedSample: this.lastVoicedSample, trigger,
      utteranceSequence: this.utteranceSequence, revision: ++this.revision };
  }

  emit(trigger) {
    if (!this.bytes) return;
    const utterance = this.snapshot(trigger);
    this.resetUtterance();
    this.onUtterance(utterance);
  }

  commit() {
    if (this.committed) throw new Error('This capture has already been committed');
    this.committed = true;
    // Stop must include the final short frame, even if it has only one sample.
    if (this.pending.length) this.frame(this.pending, this.pendingContext);
    this.pending = Buffer.alloc(0);
    this.emit('commit');
    this.resetUtterance();
  }

  discard() {
    this.committed = true;
    this.pending = Buffer.alloc(0);
    this.resetUtterance();
  }
}
