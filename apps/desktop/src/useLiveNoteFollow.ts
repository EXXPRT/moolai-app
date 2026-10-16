import { useEffect, useReducer, useRef } from "react";
import type { LiveThoughtPreview } from "../../../packages/contracts/src/index.js";
import { initialLiveNoteFollow, liveNoteFollow, liveNotePreference, liveNotePreferenceEnabled } from "./live-note-follow.js";

export function useLiveNoteFollow(preview: LiveThoughtPreview | undefined, ready: boolean,
  select: (preview: LiveThoughtPreview) => void) {
  const [state, dispatch] = useReducer(liveNoteFollow, undefined, () => {
    try { return initialLiveNoteFollow(liveNotePreferenceEnabled(localStorage.getItem(liveNotePreference))); }
    catch { return initialLiveNoteFollow(); }
  });
  const key = preview ? `${preview.sessionId}:${preview.recordId ?? "preview"}:${preview.revision}` : undefined;
  const latest = useRef({ preview, select, key });
  latest.current = { preview, select, key };
  const applied = useRef(0);
  useEffect(() => { dispatch({ type: "observe", key, ready }); }, [key, ready]);
  useEffect(() => {
    if (state.selection === applied.current || state.target !== latest.current.key || !latest.current.preview) return;
    applied.current = state.selection;
    latest.current.select(latest.current.preview);
  }, [state.selection, state.target]);
  function setEnabled(value: boolean) {
    try { localStorage.setItem(liveNotePreference, String(value)); } catch { /* Follow works without preference storage. */ }
    dispatch({ type: "enabled", value, key });
  }
  return { enabled: state.enabled, paused: state.paused, setEnabled,
    pause: () => dispatch({ type: "pause" }), resume: () => dispatch({ type: "resume", key }) };
}
