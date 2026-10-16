/** Presentation state only: disabling follow never changes capture or processing. */
export interface LiveNoteFollowState {
  enabled: boolean;
  paused: boolean;
  initialized: boolean;
  observed?: string;
  target?: string;
  selection: number;
}
export type LiveNoteFollowAction =
  | { type: "observe"; ready: boolean; key?: string }
  | { type: "enabled"; value: boolean; key?: string }
  | { type: "pause" }
  | { type: "resume"; key?: string };

export function initialLiveNoteFollow(enabled = true): LiveNoteFollowState {
  return { enabled, paused: false, initialized: false, selection: 0 };
}

export function liveNoteFollow(state: LiveNoteFollowState, action: LiveNoteFollowAction): LiveNoteFollowState {
  if (action.type === "pause") return state.paused ? state : { ...state, paused: true };
  if (action.type === "observe") {
    if (!action.ready) return state;
    // The first loaded snapshot is history. Only fresh activity or explicit Resume opens it.
    if (!state.initialized) return { ...state, initialized: true, observed: action.key };
    if (action.key === state.observed) return state;
    const observed = { ...state, observed: action.key };
    return state.enabled && !state.paused && action.key
      ? { ...observed, target: action.key, selection: state.selection + 1 }
      : observed;
  }
  if (action.type === "enabled" && !action.value) return { ...state, enabled: false };
  return { ...state, enabled: true, paused: false, observed: action.key, target: action.key,
    selection: action.key ? state.selection + 1 : state.selection };
}

export const liveNotePreference = "moolai.live-note-follow.v1";
export function liveNotePreferenceEnabled(value: string | null): boolean { return value !== "false"; }
