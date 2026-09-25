# Local Canary comparison

This isolated experiment compares **Canary-Qwen-2.5B BF16** with the configured Whisper large-v3-turbo profile. It does not change `asr-config.json`, start a microphone, invoke J1, or use paid inference.

The corpus contains twelve synthetic clips, plus predefined repeats of the Moo start and finish phrases. Each model receives the same temporary audio bytes. One warmup is excluded from quality scoring. Silence is scored for insertions, not word error rate. Strict WER is preserved; separately declared number/spelling aliases avoid calling “forty” versus “40” a semantic quantity error. Negation and Moo/Move remain distinct.

## Pins and prerequisites

- macOS Apple Silicon with Metal, CMake, a C++ toolchain, Node supporting `fetch`/`FormData`, `ffmpeg`, `ffprobe`, and Apple's Samantha voice.
- Runtime: [`handy-computer/transcribe.cpp`](https://github.com/handy-computer/transcribe.cpp/tree/c83df3f229accd6f769cb91b638cd365f3624c9c), commit `c83df3f229accd6f769cb91b638cd365f3624c9c`.
- Model: [`handy-computer/canary-qwen-2.5b-gguf`](https://huggingface.co/handy-computer/canary-qwen-2.5b-gguf/tree/df576c1641eb59bb66bc3c396bbdd8b0b113825a), revision `df576c1641eb59bb66bc3c396bbdd8b0b113825a`, file `canary-qwen-2.5b-BF16.gguf`, 5,076,107,136 bytes, SHA-256 `5b29334e1d257503b95436608519c39436f0e2056251d17b7c5c001f862c00b8`.
- This is a community runtime/conversion of NVIDIA's selected architecture. Runtime compatibility does not independently prove conversion parity with NeMo. Do not substitute the different Canary-1B-v2 model.
- The existing Whisper installation must match `docs/whisper-artifacts.json` and `.data/asr/whisper/runtime-install.json`. The runner checks model, VAD and binary hashes.

Place the runtime checkout in `.data/asr/canary-experiment/runtime` and the verified model in `.data/asr/canary-experiment/`. Keep the model lock from the recorded report's `freeze.canary` metadata as `model-lock.json`. The runtime commit and model hash must match that lock.

```sh
cmake -S .data/asr/canary-experiment/runtime -B .data/asr/canary-experiment/build -DTRANSCRIBE_METAL=ON -DTRANSCRIBE_BUILD_TESTS=OFF -DTRANSCRIBE_BUILD_EXAMPLES=ON -DCMAKE_BUILD_TYPE=Release
cmake --build .data/asr/canary-experiment/build --target transcribe-cli -j 8
node --test scripts/canary-metrics.test.mjs scripts/evaluation-metrics.test.mjs
node experiments/canary-comparison/run.mjs
node experiments/canary-comparison/run.mjs --run
```

The execution refuses to overwrite `.data/asr/canary-experiment/run-v1`. Preserve an existing run before deliberately creating a new experiment version. Source/config hashes are recorded before inference. Logs and transcripts persist; generated audio is removed in `finally`. The comparison owns and stops a separate loopback Whisper server, leaving the user's existing runtime alone. Each inference is attempted once.

## Interpretation

Canary runs once as a resident batch process, with explicit Metal, eight threads and a 2,048-token context. Whisper uses its configured Moo prompt and Silero speech detection; Canary receives the runtime's default prompt without VAD. These are declared profiles, not a pure model-only comparison.

Canary reports internal feature/encoder/decoder time; Whisper reports local HTTP round-trip time. Neither measures endpointing or live conversational latency. Synthetic speech cannot establish AirPods performance, personal accent robustness, sustained streaming, final-word retention when stopping live capture, or TTS echo prevention. Those remain separate acceptance checks. No observed J1 routing score may be inferred from the ASR transcripts.
