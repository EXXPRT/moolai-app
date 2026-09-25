# macOS companion

`npm run build:native` builds an Apple Silicon app bundle at `native/build/Moolai Native.app`. The runtime launches its `Contents/MacOS/MoolaiNative` executable. The bundle has microphone and screen permission descriptions and an ad-hoc development signature. No full Xcode installation is required; Apple command-line tools and macOS 14+ are required. Permission testing requires a normal user session outside an execution sandbox.

The helper uses AVAudioEngine, AVSpeechSynthesizer and ScreenCaptureKit. It connects only to a local ASR WebSocket. The selected path is **Whisper large-v3-turbo + Silero speech detection + the `Moo.` hint**; full large-v3 is an explicit config option. The Agent derives its URL from [asr-config.json](../asr-config.json), unless `MOOLAI_ASR_URL` explicitly overrides it; the standalone helper defaults to `ws://127.0.0.1:8178/v1/audio/transcriptions/realtime`. Run `npm run setup:asr` then `npm run asr` to keep that model loaded. The helper never downloads, chooses or substitutes a model. See [configuration and implementation](../docs/whisper-integration.md).

The primary spoken close phrase is **“Moo, finish conversation.”** New Moo exchanges announce it once; the End button remains available. Conversation membership and closing decisions belong to the Agent, so a pause, ASR final or Send does not itself close the conversation.

## Protocol

Send one JSON object per stdin line: `{"id":1,"method":"health","params":{}}`. Responses carry the same `id` and either `result` or an error string. Stdout is reserved for protocol events; OS diagnostics use stderr.

| Method | Behavior |
|---|---|
| `health` | Reports permission, speech, microphone and connection status without asking for permission. |
| `startListening` | Requests microphone permission when necessary and begins the local ASR stream. |
| `stopListening` | Stops microphone capture, drains queued PCM, commits ASR, waits for the committed event, and disconnects. |
| `flushListening` | Commits the current audio and reconnects, so an explicit Send can end a voice turn without disabling the session. |
| `speak` with `{text}` | Drains and pauses recognition, speaks through Apple TTS, then resumes recognition if still enabled. Returns when output has finished or been stopped. |
| `stopSpeaking` | Interrupts Apple TTS. |
| `capture` | Takes a fresh main-display screenshot, maximum width 1920, returning `{mimeType,dataBase64}`. Only this method requests screen permission. |

Unsolicited `transcript` events contain a stable segment `id`, `turnId`, increasing `revision`, role, text, final flag and creation time. Deltas revise the same segment. A completed ASR event replaces the partial text, then emits `turn_end`. New utterances get new identities, which are independent of the Agent's longer conversation identity. `status` events contain current `listening`/`speaking` state and any error.

Empty progress deltas and a commit final with no preceding transcript are ignored. A final that corrects an existing partial to empty text is still emitted and retained.

PCM16 audio exists only in bounded in-memory queues and the local WebSocket. No microphone file is created. A stalled server stops recognition with a visible error. Stopping waits up to 35 seconds for final ASR confirmation; on failure the error identifies that final transcription was unconfirmed, while received transcripts remain in Brain storage. Overlapping Stop, Flush and TTS share a single drain/commit. Old socket events cannot enter a new capture.

The local adapter preserves the existing [realtime protocol](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.1.0/docs/api.md#websocket-v1audiotranscriptionsrealtime): a session update at the microphone rate, mono PCM16 frames, full final transcripts and explicit commit. The assembler also supports append-only deltas, but the initial Whisper adapter emits finals only. Newlines inside an utterance never create extra turns. The bridge resamples in memory; pause threshold, pre-roll and the Moo hint come from the config file. Silero screens speech during server decoding. Rejected repetitive text travels as `asr_diagnostic`, is saved for review, and never produces `turn_end` or agent actions.

Select the intended microphone under System Settings → Sound → Input. Test with the actual input device after granting microphone permission. An absent input is reported without installing an invalid audio tap.

`sh native/test.sh` validates transcript revisions and final/turn ordering without a microphone. A successful build or health command does not validate microphone recognition, end-of-turn latency, TTS echo prevention, or permissions under the final launch environment. Verify those behaviors separately on the intended device.

## Synthetic speech workflow

With the configured model running through `npm run asr` and the companion built, run:

```sh
node --import tsx scripts/validate-synthetic-speech.ts .data/validation/synthetic-speech.json
```

This uses three known Apple-generated speech blocks and sends their PCM directly to the local ASR bridge. The first two blocks end through the configured silence threshold; the last is explicitly committed to check that its final word survives. The report includes ordered `blocks[].text` and full source segments for the separate Agent workflow harness. It records the exact model configuration and refuses an already active ASR capture.

The script also runs one native Apple speech output with capture disabled, checks that listening remains off, and deletes its temporary generated AIFF/PCM files. It never calls `startListening` or `capture`. Stop the ASR process after validation if no study session needs the loaded model.

Results are written under ignored `.data/validation/`. Keep reports and personal transcripts out of Git. Synthetic speech does not prove microphone accuracy, acoustic echo handling or overlapping interruption.
