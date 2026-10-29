import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { MarkdownContent as Preview } from "./MarkdownContent.js";
import type { BrainRecord, BrainQuery, LiveThoughtPreview, RecordPatch } from "../../../packages/contracts/src/index.js";
import { noteTitle, queryRecords } from "../../../packages/contracts/src/records.js";
import { connectionDismissals, connectionsFor, originalSources, readerError, sourceGroups } from "./note-reader.js";
import { useLiveNoteFollow } from "./useLiveNoteFollow.js";
import { sessionHubs } from "./session-hubs.js";
import { organizingStatus } from "./organizing-status.js";

const Graph = lazy(() => import("./BrainGraph.js"));
type Api = NonNullable<Window["moolai"]>;
type Tab = "summary" | "recorded" | "connections";
const tabs: { id: Tab; label: string }[] = [
  { id: "summary", label: "Summary" }, { id: "recorded", label: "Recorded text" }, { id: "connections", label: "Connections" },
];
const defaultFilters: BrainQuery = { kinds: ["note", "dictation", "conversation"] };
const purposes = ["Question", "Reference", "Idea", "Action"] as const;

function SummaryReview({ record }: { record: BrainRecord }) {
  const sourcePreview = record.thoughtStatus === "draft" && record.summarySourceRevision === undefined && !record.manualFields.includes("summary");
  if (!record.summary || sourcePreview || record.quality === "ready") return null;
  return <span className="summary-review">{record.quality === "needs_review" ? "Needs review" : "Unchecked summary"}</span>;
}

export function BrainWorkspace({ records, api, refresh, requestedNote, processing, retry, processingAvailable, liveThought, ready = true }: {
  liveThought?: LiveThoughtPreview;
  ready?: boolean;
  requestedNote?: { id: string; nonce: number };
  processing?: { status: string; error?: string; pending: boolean; continuationRequired?: boolean; recordId?: string };
  retry?: () => Promise<void>;
  processingAvailable?: boolean;
  records: BrainRecord[];
  api?: Api;
  refresh: () => Promise<void>;
}) {
  const [filters, setFilters] = useState<BrainQuery>(defaultFilters);
  const [selected, setSelected] = useState("");
  const [temporaryPreview, setTemporaryPreview] = useState(false);
  const [tab, setTab] = useState<Tab>("summary");
  const [editor, setEditor] = useState<BrainRecord>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const inspector = useRef<HTMLElement>(null);
  const lastFocus = useRef<HTMLElement | null>(null);
  const focusSelection = useRef(false);
  const notes = queryRecords(records, filters);
  const activeFilters = [filters.text?.trim(), filters.topic, filters.purpose].filter(Boolean).length;
  const record = records.find(item => item.id === selected && !item.suppressed);
  const live = liveThought && (!liveThought.recordId || !records.find(item => item.id === liveThought.recordId)?.suppressed) ? liveThought : undefined;
  const liveForRecord = live?.recordId === record?.id && record ? live : undefined;
  const showTemporaryPreview = temporaryPreview && !record && !!live;
  const follow = useLiveNoteFollow(live, ready, preview => {
    if (editor) return;
    focusSelection.current = false;
    if (preview.recordId) {
      if (preview.recordId !== selected) { setSelected(preview.recordId); setTab("summary"); setError(""); }
      setTemporaryPreview(false);
    } else { setSelected(""); setTemporaryPreview(true); }
  });
  const continuation = !!record && processing?.recordId === record.id && processing.continuationRequired === true;
  const organizationPending = !!record && processing?.recordId === record.id && processing.pending;
  // Filters offer only what the notes carry, and keep the one chosen even when no note has it any more.
  const shown = records.filter(item => !item.archived && !item.suppressed && !item.sourceOnly && item.kind !== "session");
  const topics = [...new Set([...shown.flatMap(item => item.topics), ...(filters.topic ? [filters.topic] : [])])]
    .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
  const categories = purposes.filter(purpose => purpose === filters.purpose || shown.some(item => item.purpose === purpose));

  function select(id: string) {
    follow.pause(); focusSelection.current = true; setTemporaryPreview(false);
    if (!selected) lastFocus.current = document.activeElement as HTMLElement;
    setSelected(id); setTab("summary"); setEditor(undefined); setError("");
  }
  function close() { follow.pause(); setSelected(""); setTemporaryPreview(false); setEditor(undefined); setError(""); lastFocus.current?.focus(); }
  useEffect(() => { if (requestedNote) select(requestedNote.id); }, [requestedNote?.id, requestedNote?.nonce]);
  useEffect(() => {
    if (focusSelection.current) inspector.current?.querySelector<HTMLButtonElement>('[aria-label="Close note"]')?.focus();
    focusSelection.current = false;
  }, [selected]);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError("");
    try { await action(); await refresh(); }
    catch (cause) { setError(readerError(cause)); }
    finally { setBusy(false); }
  }
  async function save(draft: RecordPatch) {
    if (!api || !editor) return;
    const editing = editor;
    await run(async () => {
      await api.request("POST", `/api/record/${editing.id}`, { revision: editing.revision, patch: draft });
      setEditor(undefined);
    });
  }
  async function removeConnection(other: BrainRecord) {
    if (!record || !api) return;
    await run(async () => {
      for (const update of connectionDismissals(record, other)) await api.request("POST", `/api/record/${update.id}`, { revision: update.revision, patch: update.patch });
    });
  }

  return <section className={`brain workspace ${record || showTemporaryPreview ? "has-inspector" : ""}`}>
    <div className="section-heading">
      <div><span className="eyebrow">YOUR SECOND BRAIN</span><h2>Thoughts, connected.</h2></div>
      <details className="search-dropdown">
        <summary>Search &amp; filters{activeFilters ? <span className="filter-count">{activeFilters}</span> : null}</summary>
        <div className="search-popover">
          <label>Search<input aria-label="Search Brain" placeholder="Find a thought…" value={filters.text ?? ""} onChange={event => setFilters({ ...filters, text: event.target.value })} /></label>
          <label>Topic<select value={filters.topic ?? ""} onChange={event => setFilters({ ...filters, topic: event.target.value || undefined })}>
            <option value="">All topics</option>{topics.map(topic => <option key={topic}>{topic}</option>)}
          </select></label>
          <label>Category<select value={filters.purpose ?? ""} onChange={event => setFilters({ ...filters, purpose: (event.target.value || undefined) as BrainQuery["purpose"] })}>
            <option value="">All categories</option>{categories.map(purpose => <option key={purpose}>{purpose}</option>)}
          </select></label>
          <div className="filter-footer"><span role="status">{notes.length} matching {notes.length === 1 ? "note" : "notes"}</span><button className="text-button" onClick={() => setFilters(defaultFilters)} disabled={!activeFilters}>Clear</button></div>
        </div>
      </details>
    </div>
    <div className="live-note-controls">
      <label><input type="checkbox" checked={follow.enabled} onChange={event => follow.setEnabled(event.target.checked)} aria-describedby="live-note-help" />Live note generation</label>
      {follow.enabled && follow.paused ? <span>Following paused</span> : null}
      {follow.enabled && follow.paused && live ? <button className="text-button" onClick={follow.resume}>Resume live note</button> : null}
      <small id="live-note-help">Follow growing notes. Turning this off keeps background saving on.</small>
    </div>
    {processing?.pending ? <div className="thought-status" role="status">
      <span>{processing.continuationRequired ? "Summaries saved. More recorded text is waiting to be organized." : processing.error ? "Some thoughts are waiting to be organized." : processing.status === "running" ? "Organizing your thoughts…" : "Your latest thought is saved."}</span>
      {processing.error && retry ? <button className="text-button" disabled={busy || processingAvailable === false} onClick={() => void run(retry)}>{processing.continuationRequired ? "Continue organization" : "Retry organization"}</button> : null}
    </div> : null}
    {!record && error ? <p role="alert" className="inline-alert">{error}</p> : null}
    <div className="brain-layout">
      <aside className="brain-navigation" aria-label="Recent notes">
        <div className="recent-heading"><span>{activeFilters ? "Matching thoughts" : "Recent thoughts"}</span><span>{notes.length}</span></div>
        <div className="notes" aria-label="Saved notes">
          {notes.slice(0, 100).map(note => <button className={`note ${record?.id === note.id ? "selected" : ""}`} aria-pressed={record?.id === note.id} key={note.id} onClick={() => select(note.id)}>
            <strong>{noteTitle(note, records)}</strong>{note.thoughtStatus === "draft" || note.thoughtStatus === "growing" ? <span className="hint">Growing note</span> : null}<SummaryReview record={note} /><p>{note.summary || note.body || note.segments[0]?.text || "Summary pending"}</p>
          </button>)}
          {!notes.length ? <p className="recent-empty">{activeFilters ? "No thoughts match these filters." : "Your saved thoughts will appear here."}</p> : null}
        </div>
      </aside>
      <div className="graph-area"><Suspense fallback={<p className="hint">Opening your connections…</p>}><Graph records={notes} record={record} onSelect={select} sessions={sessionHubs(records, notes)} status={organizingStatus(processing, notes)} overview /></Suspense></div>
      {record ? <article key={record.id} ref={inspector} className="brain-document" aria-label="Note inspector" onKeyDown={event => { if (event.key === "Escape" && !editor) close(); }}>
        <div className="inspector-header"><h3>{noteTitle(record, records)}</h3><button className="icon-button close-inspector" aria-label="Close note" title="Close note" onClick={close}>×</button></div>
        <div className="view-switch" role="tablist" aria-label="Note views">
          {tabs.map((item, index) => <button key={item.id} id={`note-tab-${item.id}`} role="tab" aria-selected={tab === item.id} aria-controls={`note-panel-${item.id}`} tabIndex={tab === item.id ? 0 : -1} onClick={() => { setTab(item.id); setEditor(undefined); }} onKeyDown={event => {
            const direction = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
            if (!direction) return;
            event.preventDefault(); const next = tabs[(index + direction + tabs.length) % tabs.length]!;
            setTab(next.id); setEditor(undefined); document.getElementById(`note-tab-${next.id}`)?.focus();
          }}>{item.label}</button>)}
        </div>
        <div className="inspector-content" role="tabpanel" id={`note-panel-${tab}`} aria-labelledby={`note-tab-${tab}`}>
          {error ? <p role="alert" className="inline-alert">{error}</p> : null}
          {tab === "summary" ? editor ? <SummaryEditor key={editor.id} record={editor} busy={busy} save={save} cancel={() => setEditor(undefined)} /> : <>
            <div className="summary-actions"><button className="text-button" disabled={busy || !api} onClick={() => { follow.pause(); setEditor(record); }}>Edit</button></div>
            {record.thoughtStatus === "draft" && record.summarySourceRevision === undefined && !record.manualFields.includes("summary")
              ? <p className="note-processing" role="status">Preview from your recorded words · {record.error ? "Organization is paused." : "Moo is preparing the summary in the background."} Full text is in Recorded text.</p>
              : record.thoughtStatus === "draft" || record.thoughtStatus === "growing" ? <p className="note-processing" role="status">Growing note · This summary stays visible while new speech is organized. Your edits are preserved.</p> : null}
            <SummaryReview record={record} />
            {record.summary ? <Preview text={record.summary} /> : <p className="empty-summary">{record.body ? "Your written note is in Recorded text. Its summary is pending." : "Your recorded text is saved. Its summary is pending."}</p>}
            {liveForRecord?.segments.length ? <LivePreview preview={liveForRecord} /> : null}
            {continuation || record.error ? <div className="note-processing" role="status"><span>{processingAvailable === false ? "Processing unavailable. Your text is saved locally." : continuation ? "This summary is saved. More recorded text is waiting to be organized." : organizationPending || record.thoughtStatus === "draft" || record.thoughtStatus === "growing" ? "Organization stopped before the updated summary was ready. Your text is saved." : "This summary needs another try. Your recorded text is saved."}</span>
              <button className="text-button" disabled={busy || !api || processingAvailable === false} onClick={() => void run(async () => { await api!.request("POST", "/api/retry", { recordId: record.id, scope: "summary" }); })}>{continuation ? "Continue organization" : organizationPending || record.thoughtStatus === "draft" || record.thoughtStatus === "growing" ? "Retry organization" : "Retry summary"}</button></div>
              : null}
          </> : null}
          {tab === "recorded" ? <RecordedText key={record.id} record={record} records={records} api={api} /> : null}
          {tab === "connections" ? <div className="connections">
            {connectionsFor(record, records).map(connection => <div className="relationship" key={connection.record.id}>
              <button className="connection-note" onClick={() => select(connection.record.id)}><span>{connection.label}</span><strong>{noteTitle(connection.record, records)}</strong><p>{connection.record.summary || connection.record.body || connection.record.segments[0]?.text}</p></button>
              {connection.removable ? <button className="text-button" disabled={busy || !api} aria-label={`Remove connection to ${noteTitle(connection.record, records)}`} onClick={() => void removeConnection(connection.record)}>Remove</button> : null}
            </div>)}
            {!connectionsFor(record, records).length ? <p className="empty-summary">{record.connectionStatus === "pending" ? "Looking for related thoughts…" : record.connectionStatus === "failed" ? "Connections couldn’t be checked yet." : "No connections yet. Related thoughts will appear here."}</p> : null}
          </div> : null}
        </div>
      </article> : null}
      {showTemporaryPreview ? <article className="brain-document live-thought-document" aria-label="Live thought preview" onKeyDown={event => { if (event.key === "Escape") close(); }}>
        <div className="inspector-header"><h3>Your next thought</h3><button className="icon-button close-inspector" aria-label="Close live preview" onClick={close}>×</button></div>
        <div className="inspector-content"><p className="hint">These words may change as you speak. A note appears after Moo understands what to keep.</p><LivePreview preview={live!} /></div>
      </article> : null}
    </div>
  </section>;
}

function LivePreview({ preview }: { preview: LiveThoughtPreview }) {
  return <section className="live-thought-preview" aria-label="Live transcription preview">
    <h4>Live transcription preview</h4><p className="hint">New words appear here while the summary updates in the background.</p>
    {preview.segments.map(segment => <div className="source" key={segment.id} aria-busy={!segment.final}>
      <span>{segment.speaker === "user" ? "You" : segment.speaker === "assistant" ? "Moo" : "Session"}{!segment.final ? " · Transcribing…" : ""}</span>
      <p>{segment.text}</p>
    </div>)}
  </section>;
}

function SummaryEditor({ record, busy, save, cancel }: { record: BrainRecord; busy: boolean; save: (patch: RecordPatch) => Promise<void>; cancel: () => void }) {
  const [title, setTitle] = useState(record.title);
  const [summary, setSummary] = useState(record.summary);
  function submit() { const patch: RecordPatch = {}; if (title !== record.title) patch.title = title; if (summary !== record.summary) patch.summary = summary; if (Object.keys(patch).length) void save(patch); else cancel(); }
  return <form className="note-editor" onSubmit={event => { event.preventDefault(); submit(); }} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (!busy) submit(); } }}>
    <label>Title<input required disabled={busy} value={title} onChange={event => setTitle(event.target.value)} /></label>
    <label>Summary<textarea disabled={busy} value={summary} onChange={event => setSummary(event.target.value)} /></label>
    <div className="editor-actions"><button className="primary" disabled={busy}>Save</button><button type="button" disabled={busy} onClick={cancel}>Cancel</button></div>
  </form>;
}

function RecordedText({ record, records, api }: { record: BrainRecord; records: BrainRecord[]; api?: Api }) {
  const [attachment, setAttachment] = useState<{ mimeType: string; base64: string }>();
  const [attachmentError, setAttachmentError] = useState("");
  const [loading, setLoading] = useState(false);
  const request = useRef(0);
  useEffect(() => () => { request.current++; }, []);
  const groups = sourceGroups(record, records);
  const sources = originalSources(record, records);
  const attachments = [...new Set([...record.attachmentIds, ...sources.flatMap(source => source.attachmentIds)])];
  async function openAttachment(id: string) {
    if (!api) return;
    const current = ++request.current; setLoading(true); setAttachmentError(""); setAttachment(undefined);
    try { const result = await api.request<{ mimeType: string; base64: string }>("GET", `/api/attachment/${id}`); if (request.current === current) setAttachment(result); }
    catch { if (request.current === current) setAttachmentError("This attachment is unavailable right now. Your recorded text is still saved."); }
    finally { if (request.current === current) setLoading(false); }
  }
  return <div className="recorded-text">
    {record.body ? <div className="source-group"><h4>Written note</h4><Preview text={record.body} /></div> : null}
    {groups.map((group, index) => <div className="source-group" key={index}><h4>{group.kind}</h4>{group.segments.map(segment => <div className="source" key={segment.id}><span>{segment.speaker === "user" ? "You" : segment.speaker === "assistant" ? "Moo" : "Session"}</span><Preview text={segment.text} /></div>)}</div>)}
    {!record.body && !groups.length ? <p className="empty-summary">No original text is available for this note.</p> : null}
    {sources.length ? <div className="original-sources">{sources.map(source => <details key={source.id}><summary>{source.kind === "conversation" ? "Original Moo conversation" : source.kind === "session" ? "Full recorded session" : "Original request"}{source.kind !== "session" && source.kind !== "conversation" ? ` · ${noteTitle(source, records)}` : ""}</summary>
      {source.body ? <Preview text={source.body} /> : null}
      {source.segments.map(segment => <div className="source" key={segment.id}><span>{segment.speaker === "user" ? "You" : segment.speaker === "assistant" ? "Moo" : "Session"}</span><Preview text={segment.text} /></div>)}
    </details>)}</div> : null}
    {attachments.length ? <div className="source-attachments"><h4>Attachments</h4>{attachments.map((id, index) => <button disabled={loading || !api} key={id} onClick={() => void openAttachment(id)}>View attachment{attachments.length > 1 ? ` ${index + 1}` : ""}</button>)}</div> : null}
    {loading ? <p role="status" className="hint">Opening attachment…</p> : null}
    {attachmentError ? <p role="alert" className="inline-alert">{attachmentError}</p> : null}
    {attachment ? /^image\/(png|jpeg|webp)$/.test(attachment.mimeType) ? <img className="evidence-image" src={`data:${attachment.mimeType};base64,${attachment.base64}`} alt="Recorded source attachment" /> : <p className="hint">This attachment cannot be previewed here.</p> : null}
  </div>;
}
