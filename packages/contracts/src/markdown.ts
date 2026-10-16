import type { BrainRecord } from "./index.js";

import { validateRecord } from "./records.js";
const bodyStart = "<!-- moolai:body:start -->";
const bodyEnd = "<!-- moolai:body:end -->";
const metadataKey = "moolai_record:";
const start = "<!-- moolai:generated:start -->";
const end = "<!-- moolai:generated:end -->";

export interface ParsedMarkdown {
  record?: BrainRecord;
  /** Unknown frontmatter and prose are kept verbatim, without interpreting YAML. */
  userFrontmatter: string;
  userBody: string;
}

/** Read Moolai's single namespaced JSON value (valid YAML) and preserve other content. */
export function parseMarkdown(markdown: string): ParsedMarkdown {
  const frontmatter = /^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(
    markdown,
  );
  let userBody = frontmatter ? markdown.slice(frontmatter[0].length) : markdown;
  const fields = frontmatter?.[1] ?? "";
  let record: BrainRecord | undefined;
  let foundMetadata = false;
  const userFrontmatter = fields
    .split(/(?<=\n)/)
    .filter((line) => {
      if (!line.startsWith(metadataKey)) return true;
      if (foundMetadata) throw new Error("Duplicate Moolai metadata");
      foundMetadata = true;
      const metadata = JSON.parse(line.slice(metadataKey.length).trim()) as {
        version?: number;
        record?: BrainRecord;
      };
      if (
        ![1, 2].includes(metadata.version ?? 0) ||
        !metadata.record?.id ||
        !Array.isArray(metadata.record.segments)
      ) {
        throw new Error("Unsupported or invalid Moolai note metadata");
      }
      validateRecord(metadata.record);
      record = metadata.record;
      return false;
    })
    .join("");
  const beginAt = userBody.indexOf(start);
  if (beginAt >= 0) {
    const endAt = userBody.indexOf(end, beginAt + start.length);
    if (endAt < 0)
      throw new Error(
        "Unclosed Moolai generated section; preserve the original note before repair",
      );
    userBody = userBody.slice(0, beginAt) + userBody.slice(endAt + end.length);
  }
  const bodyAt = userBody.indexOf(bodyStart);
  if (bodyAt >= 0) {
    const endAt = userBody.indexOf(bodyEnd, bodyAt);
    if (
      !record ||
      endAt < 0 ||
      userBody.indexOf(bodyStart, bodyAt + bodyStart.length) >= 0
    )
      throw new Error("Invalid authored section; preserve the original file");
    const framedBody = userBody.slice(bodyAt + bodyStart.length, endAt);
    const opening = /^(?:\r\n|\n)/.exec(framedBody)?.[0];
    const closing = /(?:\r\n|\n)$/.exec(framedBody)?.[0];
    if (!opening || !closing || framedBody.length < opening.length + closing.length)
      throw new Error(
        "Authored section separators changed; preserve the original file",
      );
    // Strip framing only. Authored whitespace, including its own CRLFs, is source.
    record = { ...record, body: framedBody.slice(opening.length, -closing.length) };
    userBody =
      userBody.slice(0, bodyAt) + userBody.slice(endAt + bodyEnd.length);
  }
  return { record, userFrontmatter, userBody };
}

const visibleText = (text: string): string =>
  text.replaceAll("<!--", "&lt;!--");
const destinationPart = (part: string): string => encodeURIComponent(part)
  .replace(/[()]/g, (character) => character === "(" ? "%28" : "%29");
// Callbacks provide raw vault paths; literal %, # and ? belong to the filename.
const markdownDestination = (path: string): string => path.startsWith("#")
  ? `#${destinationPart(path.slice(1))}`
  : path.split("/").map(destinationPart).join("/");

/** Replace only the namespaced data and generated section, retaining user content. */
export function formatMarkdown(
  record: BrainRecord,
  existingMarkdown = "",
  linkPath: (id: string) => string = (id) =>
    `#record-${id}`,
): string {
  if (
    [bodyStart, bodyEnd, start, end].some((marker) =>
      record.body?.includes(marker),
    )
  )
    throw new Error(
      "Authored content contains reserved document markers; source retained, export requires editing those markers",
    );
  const existing = parseMarkdown(existingMarkdown);
  const fields = existing.userFrontmatter;
  const metadata = `${metadataKey} ${JSON.stringify({ version: record.body !== undefined ? 2 : 1, record })}`;
  const frontmatter = `---\n${fields}${fields && !fields.endsWith("\n") ? "\n" : ""}${metadata}\n---\n`;
  const transcript = record.segments
    .map(
      (segment) =>
        `### ${segment.speaker} · ${segment.createdAt}\n\n${visibleText(segment.text)}`,
    )
    .join("\n\n");
  const relationships = record.links
    .filter((l) => l.decision !== "dismissed")
    .map(
      (l) =>
        `- [${l.provenance}: ${l.targetId.replace(/[\[\]\n]/g, " ")}](${markdownDestination(linkPath(l.targetId))})`,
    )
    .join("\n");
  const generated = `${start}\n# ${visibleText(record.title || "Untitled note")}\n\n${visibleText(record.summary)}\n\n## Source transcript\n\n${transcript}\n\n## Related notes\n\n${relationships}\n${end}`;
  const authored =
    record.body !== undefined ? `${bodyStart}\n${record.body}\n${bodyEnd}` : "";
  const body = existing.userBody;

  return `${frontmatter}${body}${body && !body.endsWith("\n") ? "\n" : ""}${authored}${generated}`;
}
