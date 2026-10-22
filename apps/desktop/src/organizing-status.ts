import type { BrainRecord } from "../../../packages/contracts/src/index.js";

export type Processing = { status: string; error?: string; pending: boolean; continuationRequired?: boolean; recordId?: string };

/** One always-visible answer to "has the graph finished organizing?" (Ian, 20 Oct). */
export function organizingStatus(processing: Processing | undefined, notes: BrainRecord[]): { label: string; tone: "busy" | "done" | "attention" } {
  const stuck = new Set(notes.filter(note => note.thoughtStatus && note.error && !note.suppressed && !note.archived).map(note => note.id));
  if (processing?.error && processing.recordId) stuck.add(processing.recordId);
  else if (processing?.error) stuck.add("current session");
  const retry = `${stuck.size} ${stuck.size === 1 ? "note needs" : "notes need"} Retry`;
  // A pass that is still running says so first, even while older notes wait for their own Retry.
  if (!processing?.error && (processing?.pending || processing?.status === "running")) return { label: stuck.size ? `Organizing… · ${retry}` : "Organizing…", tone: "busy" };
  if (stuck.size) return { label: retry, tone: "attention" };
  return { label: "All notes organized", tone: "done" };
}
