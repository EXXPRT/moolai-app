import type { MicHandle, OpenMic } from "../types.js";

// Browser echo cancellation and noise suppression stay on; gain control stays off so a quiet room is not
// amplified into false onsets.
const CONSTRAINTS: MediaTrackConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: false, channelCount: 1 };
const PROCESSOR = "moolai-capture";
const modules = new WeakMap<BaseAudioContext, Promise<void>>();

/** The microphone through public/voice-worklet.js. The context is created and resumed in the Start click. */
export function openMicrophone(ctx: AudioContext, workletUrl: string): OpenMic {
  return async onSamples => {
    if (!navigator.mediaDevices?.getUserMedia || !ctx.audioWorklet) throw new Error("This page can't use the microphone");
    let loading = modules.get(ctx);
    if (!loading) {
      loading = ctx.audioWorklet.addModule(workletUrl);
      modules.set(ctx, loading);
      loading.catch(() => modules.delete(ctx));
    }
    await loading;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: CONSTRAINTS });
    let source: MediaStreamAudioSourceNode | undefined, node: AudioWorkletNode | undefined, stopped = false;
    // Synchronous, so pagehide can release the microphone before the page goes.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      for (const track of stream.getTracks()) track.stop();
      // The port stays open until "stop" arrives, so the processor ends itself.
      if (node) { node.port.onmessage = null; node.port.postMessage("stop"); node.disconnect(); }
      source?.disconnect();
    };
    try {
      source = ctx.createMediaStreamSource(stream);
      // No outputs: the node still runs, and nothing it hears is played back.
      node = new AudioWorkletNode(ctx, PROCESSOR, { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 1, channelCountMode: "explicit", channelInterpretation: "speakers" });
      node.port.onmessage = event => { if (!stopped && event.data instanceof Float32Array) onSamples(event.data, ctx.sampleRate); };
      source.connect(node);
      if (ctx.state !== "running") void ctx.resume().catch(() => {});
    } catch (error) {
      stop();
      throw error;
    }
    const handle: MicHandle = { sampleRate: ctx.sampleRate, stop };
    return handle;
  };
}

/** The localhost-only ?e2e=1 microphone: `feed` drives the same controller path as real capture. */
export function createE2EFeed(): { open: OpenMic; feed(samples: Float32Array, sampleRate: number): void } {
  let listener: ((samples: Float32Array, sampleRate: number) => void) | undefined;
  let rate = 16000;
  return {
    async open(onSamples) {
      listener = onSamples;
      return { get sampleRate() { return rate; }, stop() { if (listener === onSamples) listener = undefined; } };
    },
    feed(samples, sampleRate) {
      if (!(samples instanceof Float32Array)) throw new TypeError("Feed mono Float32Array samples");
      if (!listener) throw new Error("The e2e microphone is not open; start voice first");
      rate = sampleRate;
      listener(samples, sampleRate);
    },
  };
}
