import type { BrainRecord } from "./index.js";

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
        metadata.version !== 1 ||
        !metadata.record?.id ||
        !Array.isArray(metadata.record.segments)
      ) {
        throw new Error("Unsupported or invalid Moolai note metadata");
      }
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
  return { record, userFrontmatter, userBody };
}

const visibleText = (text: string): string =>
  text.replaceAll("<!--", "&lt;!--");

/** Replace only the namespaced data and generated section, retaining user content. */
export function formatMarkdown(
  record: BrainRecord,
  existingMarkdown = "",
): string {
  const existing = parseMarkdown(existingMarkdown);
  const fields = existing.userFrontmatter;
  const metadata = `${metadataKey} ${JSON.stringify({ version: 1, record })}`;
  const frontmatter = `---\n${fields}${fields && !fields.endsWith("\n") ? "\n" : ""}${metadata}\n---\n`;
  const transcript = record.segments
    .map(
      (segment) =>
        `### ${segment.speaker} · ${segment.createdAt}\n\n${visibleText(segment.text)}`,
    )
    .join("\n\n");
  const generated = `${start}\n# ${visibleText(record.title || "Untitled note")}\n\n${visibleText(record.summary)}\n\n## Source transcript\n\n${transcript}\n${end}`;
  const body = existing.userBody;
  return `${frontmatter}${body}${body && !body.endsWith("\n") ? "\n" : ""}${generated}`;
}
