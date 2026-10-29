import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";
import { presentMarkdown } from "../../../packages/contracts/src/markdown-presentation.js";
import type { Segment } from "../../../packages/contracts/src/index.js";

/** Display retained Markdown without executing HTML or loading remote content. */
export const MarkdownContent = memo(function MarkdownContent({text}: {text: string}) {
  return <div className="markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} components={{
    img: ({alt}) => <span>[{alt || "Image"}; see attachments]</span>,
    a: ({children,href}) => {
      const safe = href && /^https?:\/\//i.test(href) && !/[\u0000-\u0020]/.test(href);
      return safe ? <a href={href} target="_blank" rel="noopener noreferrer" onClick={event=>{
        event.preventDefault(); void window.moolai?.openExternal?.(href).catch(()=>{});
      }}>{children}</a> : <span>{children}</span>;
    },
    table: ({children}) => <div className="markdown-table" tabIndex={0} role="region" aria-label="Scrollable table"><table>{children}</table></div>,
  }}>{presentMarkdown(text)}</Markdown></div>;
});

/** The user's own words are shown as written (2*3*4, x<y, a leading #); Moo's and the session's lines are Markdown. */
export function SegmentText({segment}: {segment: Pick<Segment, "speaker" | "text">}) {
  return segment.speaker === "user" ? <div className="markdown plain-text"><p>{segment.text}</p></div> : <MarkdownContent text={segment.text} />;
}
