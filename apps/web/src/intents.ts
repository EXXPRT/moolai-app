import type { Route } from "../../../packages/contracts/src/index.js";
import type { IntentChip } from "../../desktop/src/snapshot.js";

const LABELS: Record<Route, string> = {
  start_agent: "Request for Moo",
  continue_agent: "Reply to Moo",
  end_agent: "Ending the conversation",
  offer_help: "Doubt: Moo offers help",
  check_status: "Status check",
  suppress_note: "Don't keep that note",
  dictate: "Saved as a thought",
  no_action: "No action",
  unclear: "Unclear: Moo asks",
};
/** The Agent's default threshold: below it Moo asks before acting, and a doubt at or above it gets the screen offer. */
const SURE = 0.8;
const DECISIONS = ["route", "filler_ignored", "wake_acknowledged"];

/** How each user turn was handled, keyed by `Segment.turnId`. The Agent keeps this only in its interaction trace,
 * where a later entry for a turn (a corrected transcript routed again) replaces the earlier one. */
export function intentsFromTrace(trace: unknown): Record<string, IntentChip> {
  const latest = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(trace) ? trace : [])
    if (entry && typeof entry === "object" && typeof entry.turnId === "string" && DECISIONS.includes(entry.action))
      latest.set(entry.turnId, entry);
  return Object.fromEntries([...latest].flatMap(([turnId, entry]) => {
    const chip = intentChip(entry);
    return chip ? [[turnId, chip]] : [];
  }));
}

function intentChip(entry: Record<string, unknown>): IntentChip | undefined {
  const route = typeof entry.route === "string" ? entry.route : undefined;
  if (entry.action === "filler_ignored") return { label: "Ignored sound" };
  if (entry.action === "wake_acknowledged") return { label: "Moo heard its name", ...(route ? { route } : {}) };
  if (!route || !Object.hasOwn(LABELS, route)) return undefined;
  const confidence = typeof entry.confidence === "number" && Number.isFinite(entry.confidence) ? entry.confidence : undefined;
  const doubt = route === "dictate" && typeof entry.doubt === "number" && entry.doubt >= SURE;
  const label = LABELS[doubt ? "offer_help" : route as Route];
  return {
    label: confidence !== undefined && confidence < SURE ? `${label} · unsure` : label,
    route,
    ...(confidence !== undefined ? { confidence } : {}),
  };
}
