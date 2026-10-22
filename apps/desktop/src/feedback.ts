/** Reader-facing status never exposes provider diagnostics or promises an unconfirmed save. */
export type ConnectionStatus = "connecting" | "connected" | "disconnected";
export function connectionAfterRefresh(succeeded: boolean): ConnectionStatus {
  return succeeded ? "connected" : "disconnected";
}
export function processingMessage(available: boolean, savedSubmission: boolean): string | undefined {
  if (available) return undefined;
  return savedSubmission
    ? "Processing unavailable. Your text is saved locally."
    : "Processing unavailable. You can still browse your saved notes.";
}
export function actionMessage(error: unknown, action: string): string {
  const detail = String(error);
  if (action === "/api/input" && /(?:^|: )Saved;/.test(detail)) return "Your message is saved, but Moo couldn't act on it. Send it again to retry.";
  if (/changed|revision|conflict/i.test(detail)) return "This note changed. Reopen it before saving your edit.";
  if (action === "/api/input") return "Your message could not be confirmed as saved. It is still in the input box.";
  if (action === "/api/voice" && /confirm all voice output and capture stopped|Voice shutdown is unconfirmed/i.test(detail))
    return "Moo couldn't confirm the microphone stopped. Click the microphone again to retry.";
  if (action === "/api/voice") return /local (?:speech recognition|ASR)/i.test(detail)
    ? "Speech recognition is not ready. Start the local ASR service, then turn the microphone on again."
    : "The microphone could not connect. Check its permission and connection, then try again.";
  if (action === "/api/retry") return "Processing could not finish. The original text is still available.";
  return "That action could not be completed. Please try again.";
}
export function readableNotice(value: string): string | undefined {
  if (/^Saved locally; backend acceptance pending/.test(value)) return undefined;
  if (/^(Transcript saved; thought organization|Source saved; enrichment pending)/.test(value)) return "Your text is saved. The summary could not finish; you can retry it.";
  if (/^Connections unavailable:/.test(value)) return "Connections could not be checked. Your note is still saved.";
  if (/^(Loading local Heart voice|Local Heart voice ready)/.test(value)) return value.startsWith("Loading") ? "Preparing Moo’s voice…" : undefined;
  // A dropped event stream reconnects by itself: hide its bare "terminated" or "other side closed", or an UND_ERR_ code, but not a spoken line using those words.
  if (/^(?:Error:|TypeError:|Backend \d|fetch failed|Failed to fetch|Agent event connection|Runtime unavailable)|^(?:terminated|other side closed)$|UND_ERR_/i.test(value)) return undefined;
  if (/(?:Kokoro unavailable|Local speech|speech worker|Speech interrupted|Speech superseded|Speech session closed)/i.test(value))
    return /interrupted|superseded|closed/i.test(value) ? undefined : "Moo’s voice is unavailable. The full response is on screen.";
  return value;
}

export function clearAcknowledgedDraft(current: string, submitted: string): string {
  return current === submitted ? "" : current;
}
/** Playback stop and response cancel stay separate: while Moo speaks, Stop only ends playback. */
export function stopControl(speaking: boolean, busy: boolean): { label: string; path: string } | undefined {
  if (speaking) return { label: "Stop speech", path: "/api/speech/stop" };
  if (busy) return { label: "Stop response", path: "/api/response/cancel" };
  return undefined;
}
