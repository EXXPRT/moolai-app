import type { RecordPatch } from "./index.js";

export function validateEdit(patch: unknown): asserts patch is RecordPatch {
  if (
    !patch ||
    typeof patch !== "object" ||
    Array.isArray(patch) ||
    !Object.keys(patch).length
  )
    throw new Error("Empty or invalid edit");
  for (const [key, value] of Object.entries(patch)) {
    if (["title", "summary", "body"].includes(key)) {
      if (
        typeof value !== "string" ||
        value.length > (key === "title" ? 1000 : 100000)
      )
        throw new Error(`Invalid ${key}`);
    } else if (key === "purpose") {
      if (
        !["Question", "Reference", "Idea", "Action"].includes(value as string)
      )
        throw new Error("Invalid purpose");
    } else if (key === "topics") {
      if (
        !Array.isArray(value) ||
        value.length > 30 ||
        !value.every(
          (t) => typeof t === "string" && t.trim() && t.length <= 200,
        )
      )
        throw new Error("Invalid topics");
    } else if (key === "resolution") {
      if (!["open", "resolved"].includes(value as string))
        throw new Error("Invalid resolution");
    } else if (key === "archived") {
      if (typeof value !== "boolean") throw new Error("Invalid archive state");
    } else if (key === "links") {
      if (
        !Array.isArray(value) ||
        value.length > 1000 ||
        !value.every(
          (l) =>
            l &&
            typeof l.targetId === "string" &&
            l.targetId.trim() &&
            l.targetId.length <= 200 &&
            ["source", "reply", "suggested", "manual", "correction"].includes(
              l.provenance,
            ) &&
            (l.decision === undefined ||
              ["accepted", "dismissed"].includes(l.decision)),
        )
      )
        throw new Error("Invalid relationships");
    } else
      throw new Error(
        "Only title, summary, body, purpose, topics, resolution, archived and links are editable",
      );
  }
}
