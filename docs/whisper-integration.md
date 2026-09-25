# Configurable local speech

The selected ASR is **Whisper large-v3-turbo F16 with Silero 6.2.0 speech detection**, running through pinned whisper.cpp 1.9.4 on Apple Silicon Metal. The primary close phrase is **“Moo, finish conversation.”** Full large-v3 remains an explicit configuration choice. There is no automatic model fallback.

## Setup and model selection

Install Node dependencies, Python 3.12+, Apple command-line tools and ffmpeg. Then run:

```sh
npm install
npm run setup:asr
npm run asr
```

Setup verifies the pinned source, build tool, selected model and VAD artifacts in [whisper-artifacts.json](whisper-artifacts.json). It builds the local runtime and downloads only the selected Whisper model. Artifacts and build output stay under ignored `.data/asr/whisper`. Setup starts no microphone or inference session.

Edit [asr-config.json](../asr-config.json) to select:

```json
"model": "large-v3-turbo"
```

or:

```json
"model": "large-v3"
```

Stop ASR, run `npm run setup:asr` for the selected artifact, then restart `npm run asr`. Restart the Agent if changing its connection port. `MOOLAI_ASR_CONFIG=/absolute/path/to/config.json` selects a separate complete configuration; a relative path resolves against the repository. `MOOLAI_ASR_URL` remains an explicit native-connection override. An unknown model, malformed configuration or missing/mismatched artifact fails visibly.

The same file controls the English language, short `Moo.` vocabulary hint, localhost ports, pause duration, microphone energy threshold, pre-roll and maximum utterance duration. These thresholds are provisional and configurable. They do not change Agent conversation membership. The configuration contains no API keys; provider keys remain in ignored `backend/.env`.

## Capture and transcript boundaries

Swift streams mono PCM16 at the actual microphone rate to one local WebSocket bridge. The bridge keeps pre-roll, assembles an utterance using energy and a silence interval, resamples through ffmpeg pipes, and sends an in-memory WAV to the resident Whisper server. **Pause detection uses PCM energy; Silero VAD screens speech inside the server before decoding.** This is not a claim of frame-by-frame Silero endpointing.

The first implementation emits final utterances only. It preserves Whisper's wording and embedded newlines as one transcript. It does not feed replacement hypotheses into an append-only delta assembler. The existing native identity/revision contract and Agent's longer Moo conversation remain intact, with no new Jev gate.

Continuous speech is bounded by `maxUtteranceSeconds` (60 by default). Pause or use Send before that limit; overflow fails visibly instead of silently dropping audio or pretending a partial buffer is complete. At most two queued/active utterances are decoded sequentially, each with a ten-second timeout. Exact digital silence causes no inference. Model repetition triggers a visible failure; rejected text is saved as an unconfirmed Brain record, without routing, tool execution or summarization.

Stop/Send drains already-captured PCM, completes pending transcriptions, emits all final text, and only then acknowledges commit. Native Stop waits up to 35 seconds; the host allows 40 seconds for Stop and 60 seconds for Flush plus reconnection. Concurrent Stop/Flush/TTS calls share a drain. Failed Stop still drains diagnostic storage before closing the Brain. Disconnected requests cannot deliver stale text into a new capture.

Audio buffers are released after completion, cancellation or failure. The server runs without `--convert`, so it reads uploaded WAV bytes in memory. Microphone recordings are not written to disk. Recognition pauses during Apple speech output; Stop/Talk remains the supported interaction style.

## Conversation controls and validation

Conversation intent belongs to J1 and the Agent controller. The source transcript is preserved as recognized. New Moo conversations announce “Moo, finish conversation”; the End button remains available. Quoted and negated endings are content, and work in progress retains finish/cancel/continue handling. Recognition of a control phrase alone does not establish that the controller acted correctly.

Run `npm run test:asr` with the local ASR service loaded for a synthetic streaming check. For multi-block speech and native synthesis, run `node --import tsx scripts/validate-synthetic-speech.ts .data/validation/synthetic-speech.json`. Neither starts the microphone. Outputs belong under ignored `.data/`; generated audio is deleted.

Separately test the selected microphone, ordinary pauses, complete final words on Stop/Send, recognition pausing during TTS, and quiet/noisy speech. A successful build or synthetic check does not establish human-speech accuracy. Use typed controls when recognition is ambiguous.
