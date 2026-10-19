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
| `speak` with `{text}` | While listening, synthesizes buffers into the capture engine’s player node and keeps voice-processed input active. Returns when output has finished or been stopped. Output-only calls with capture off use system synthesis and never start input. |
| `stopSpeaking` | Stops queued playback and synthesis immediately. |
| `recognitionContext` with `{text}` | Updates bounded (400-character) hints for the next utterance without resetting capture. |
| `capture` with optional `{excludeBundleIds}` | Takes a fresh main-display screenshot, maximum width 1920, leaving out running apps with those bundle ids. Returns `{mimeType,dataBase64,excludedApplications}`, where `excludedApplications` names only the apps actually left out. The desktop runtime leaves its own Electron app out. Only this method requests screen permission. |

Unsolicited `transcript` events contain a stable segment `id`, `turnId`, increasing `revision`, role, text, final flag and creation time. Legacy deltas append to the same segment; versioned `conversation.item.input_audio_transcription.partial` events replace its full provisional text. Each carries an `utterance_id` and increasing `revision`. A nonempty completed event replaces the preview, then emits `turn_end`; stale or already-completed events are ignored. New utterances get new identities, which are independent of the Agent's longer conversation identity. `status` events contain current `listening`/`speaking` state and any error.

Empty progress deltas and a commit final with no preceding transcript are ignored. A final that corrects an existing preview to empty text clears it without `turn_end`. Rejected previews and connection failures retain unconfirmed text as diagnostic evidence rather than execute it.

PCM16 audio exists only in bounded in-memory queues and the local WebSocket. No microphone file is created. A stalled server stops recognition with a visible error. Stopping waits up to 35 seconds for final ASR confirmation; on failure the error identifies that final transcription was unconfirmed, while received transcripts remain in Brain storage. Overlapping Stop and Flush share a single drain/commit. TTS does not drain or pause capture. Old socket events cannot enter a new capture.

The local adapter preserves the existing [realtime protocol](https://github.com/NVIDIA/NeMo-Speech.cpp/blob/v0.1.0/docs/api.md#websocket-v1audiotranscriptionsrealtime): a session update at the microphone rate, mono PCM16 frames, full final transcripts and explicit commit. The assembler supports legacy append-only deltas and versioned replacement previews. `livePreview` enables bounded coalesced previews while speaking; the Qwen trial enables it, while Whisper stays final-only. Preview mode currently requires Qwen so final decoding can wait for cancellation acknowledgement from the local inference worker. Preview decoding never changes the pause endpoint or triggers Agent routing. Newlines inside an utterance never create extra turns. The bridge resamples in memory; pause threshold, pre-roll and the Moo hint come from the config file. Silero screens speech during server decoding. Rejected repetitive text travels as `asr_diagnostic`, is saved for review, and never produces `turn_end` or agent actions.

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

## Interruption and device state

Active capture enables AVAudioEngine voice processing; AVSpeechSynthesizer.write buffers feed an AVAudioPlayerNode on that engine so playback is available to echo cancellation. Local energy onset on the processed input stops playback, emits `speech_started`, and leaves all PCM in the existing pre-roll/ASR path. The host holds response publication and further tool dispatch until J1 interprets the new utterance. A turn that was already being routed when new speech starts is still applied: its dictation reaches the notes and its request waits on the hold. Only a close, a reply to an end or close question, or a new question the user has not heard is dropped; Moo also checks for new speech at the moment it speaks, so it never asks, greets or acknowledges over the user. Status checks preserve the original request; substantive redirection cancels superseded work. Known limit: speech that starts while the previous sentence is still being transcribed (a pause of roughly 1.2–1.5 s) counts as part of that turn. Empty or rejected recognition explicitly releases the hold. A lost recognition event times out visibly rather than suspending work indefinitely. No interrupted answer resumes automatically. These onset thresholds are provisional: acoustic false triggers, echo rejection, first/final words and the 500 ms target require separate AirPods and speaker checks.

Status includes `requestedOn`, actual `listening`/`speaking`, and phase (`off`, `listening`, `speaking`, `reconnecting`, `error`, plus startup/drain phases). A bounded 40-event diagnostic history is available via health. One device-change reconnection is attempted after draining; a failed drain/reconnect stays visible for explicit retry. Explicit Stop revokes capture intent and cannot be undone by a late reconnect. No microphone audio is stored.

See Apple’s [voice-processing overview](https://developer.apple.com/videos/play/wwdc2023/10235/) and [buffer synthesis API](https://developer.apple.com/documentation/avfaudio/avspeechsynthesizer/write(_:tobuffercallback:)).

## Local Kokoro output

Run `npm run setup:tts` once. `tts-config.json` selects the default pinned Kokoro Heart voice; `provider: "apple"` is an explicit fallback. Runtime/model pins live under `native/tts/`. The reusable host starts one worker when voice is enabled, warms it, and streams 24 kHz mono float32 PCM without audio files. Synthesis errors remain visible beside retained answer text. Bundled hosts can set `MOOLAI_PROJECT_ROOT` to the directory containing `tts-config.json` and `native/tts/worker.py`; the normal desktop runtime already runs there.

Native commands `beginSpeechAudio`, `speechAudio` and `endSpeechAudio` share an `utteranceId`. Chunks are base64 float32 little-endian, limited to 24,000 frames each and four minutes queued total. `stopSpeaking` invalidates the active identity and releases queued audio; stale chunks cannot restart playback. During capture, PCM uses the voice-processing engine's player. With capture off, a separate output-only engine never opens microphone input. Physical echo rejection and headset interruption still require acoustic validation.
