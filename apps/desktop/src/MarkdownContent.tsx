import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { memo } from "react";
import { presentMarkdown } from "../../../packages/contracts/src/markdown-presentation.js";

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
