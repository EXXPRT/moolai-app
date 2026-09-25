import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  AgentState,
  BrainRecord,
  LocalFolder,
  RecordPatch,
} from "../../../packages/contracts/src/index.js";
import "./style.css";

type Snapshot = {
  state: AgentState;
  records: BrainRecord[];
  mode: string;
  native?: Record<string, unknown>;
  localFolders: LocalFolder[];
};
declare global {
  interface Window {
    moolai?: {
      request<T = unknown>(
        method: "GET" | "POST",
        path: string,
        body?: unknown,
      ): Promise<T>;
      subscribe(callback: (event: AgentEvent) => void): () => void;
      chooseFolder(): Promise<LocalFolder | null>;
    };
  }
}

function App() {
  const [snapshot, setSnapshot] = useState<Snapshot>();
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [working, setWorking] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [query, setQuery] = useState("");
  const [showSessions, setShowSessions] = useState(false);
  const [edit, setEdit] = useState<{
    id: string;
    revision: number;
    title: string;
    summary: string;
    topics: string;
  }>();
  const api = window.moolai;
  async function refresh() {
    if (!api) return;
    const next = await api.request<Snapshot>("GET", "/api/state");
    setSnapshot(next);
  }
  useEffect(() => {
    if (!api) {
      setError(
        "Open Moolai through the Electron desktop host: npm run desktop",
      );
      return;
    }
    void refresh().catch((e: Error) => setError(e.message));
    const dispose = api.subscribe((event) => {
      if (event.type === "state" && event.state)
        setSnapshot((old) => (old ? { ...old, state: event.state! } : old));
      if (event.type === "record" && event.record)
        setSnapshot((old) =>
          old
            ? {
                ...old,
                records: [
                  event.record!,
                  ...old.records.filter(
                    (record) => record.id !== event.record!.id,
                  ),
                ],
              }
            : old,
        );
      if (event.type === "notice" && event.message) setNotice(event.message);
    });
    const timer = window.setInterval(
      () => void refresh().catch((e: Error) => setError(e.message)),
      3000,
    );
    return () => {
      dispose();
      clearInterval(timer);
    };
  }, []);
  async function act(path: string, body?: unknown, after?: () => void) {
    if (!api) return;
    setWorking(true);
    setError("");
    try {
      await api.request("POST", path, body);
      after?.();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  async function send() {
    if (!text.trim()) return;
    await act("/api/input", { text }, () => setText(""));
  }
  async function chooseFolder() {
    if (!api) return;
    setWorking(true);
    setError("");
    try {
      await api.chooseFolder();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  }
  async function talk() {
    if (!api) return;
    setError("");
    try {
      await api.request("POST", "/api/speech/stop");
      await act("/api/voice", { action: "start" });
    } catch (e) {
      setError(String(e));
    }
  }
  async function download(record: BrainRecord) {
    try {
      const markdown = await api!.request<string>(
        "GET",
        `/api/export/${record.id}`,
      );
      const url = URL.createObjectURL(
        new Blob([markdown], { type: "text/markdown" }),
      );
      const link = document.createElement("a");
      link.href = url;
      link.download = `${record.title || record.id}.md`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(String(e));
    }
  }
  const state = snapshot?.state;
  const records = [...(snapshot?.records || [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const nodes = records.filter(
    (record) =>
      (showSessions ? record.kind === "session" : record.kind !== "session") &&
      `${record.title} ${record.summary} ${record.segments.map((s) => s.text).join(" ")} ${record.topics.join(" ")}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  const record = records.find((item) => item.id === selected) || nodes[0];
  const session = records.find((item) => item.id === state?.sessionId);
  const conversation = records.find(
    (item) => item.id === state?.conversationId,
  );
  const transcript = conversation || session;
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="mark">m</span>
          <div>
            <h1>Moolai</h1>
            <p>A place for thoughts to become knowledge.</p>
          </div>
        </div>
        <div className="header-actions">
          <span className={`status ${state?.listening ? "on" : ""}`}>
            {state?.listening ? "Study session on" : "Session off"}
          </span>
          <button
            className="primary"
            disabled={!snapshot || working}
            onClick={() =>
              void act("/api/session", {
                action: state?.listening ? "stop" : "start",
              })
            }
          >
            {state?.listening ? "Stop session" : "Start session"}
          </button>
        </div>
      </header>
      {snapshot?.mode !== "live" && (
        <div className="mode">
          {snapshot
            ? "Fixture mode — responses are demonstrations, not live model answers."
            : "Connecting to your local Agent…"}
        </div>
      )}
      {(error || state?.lastError) && (
        <div role="alert" className="alert">
          {error || state?.lastError}
          <button
            onClick={() => {
              setError("");
              void refresh();
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {notice && (
        <div className="notice" role="status">
          {notice}
          <button aria-label="Dismiss notice" onClick={() => setNotice("")}>
            ×
          </button>
        </div>
      )}
      <main>
        <section className="conversation">
          <div className="section-heading">
            <div>
              <span className="eyebrow">CAPTURE & CONVERSATION</span>
              <h2>
                {state?.conversationId
                  ? "Talking with Moo"
                  : "Your thoughts, kept"}
              </h2>
            </div>
            <span className="small-status">
              {snapshot?.native?.phase === "finishing_transcription"
                ? "Finishing transcription…"
                : state?.busy
                ? "Moo is working…"
                : snapshot?.native?.listening
                  ? "Microphone on"
                  : "Ready"}
            </span>
          </div>
          <p className="hint">
            Start a session to save your thoughts. Ask a question when you need
            help. Follow-ups stay in the same conversation. Say “That’s all”
            or “Moo, finish conversation” when you're done.
          </p>
          <form
            className="subject"
            onSubmit={(event) => {
              event.preventDefault();
              void act("/api/subject", { subject });
            }}
          >
            <label htmlFor="subject">Current subject</label>
            <div>
              <input
                id="subject"
                placeholder={
                  state?.currentSubject || "Optional focus for this session"
                }
                value={subject}
                onChange={(event) => setSubject(event.target.value)}
              />
              <button disabled={working}>Set</button>
            </div>
            {state?.currentSubject && (
              <small>Focus: {state.currentSubject}</small>
            )}
          </form>
          <details className="folder-access">
            <summary>Local folder access · {snapshot?.localFolders?.length ?? 0} selected</summary>
            <p className="hint">
              Moo can read and search selected folders. Retrieved excerpts may
              reach your configured model provider. “Use only my notes” includes
              these folders and Brain records, and disables web access.
            </p>
            {!snapshot?.localFolders?.length && (
              <p className="hint">No local folders are enabled.</p>
            )}
            <ul>
              {snapshot?.localFolders?.map((folder) => (
                <li key={folder.id}>
                  <div><strong>{folder.name}</strong><small>{folder.path}</small></div>
                  <button
                    disabled={working}
                    aria-label={`Remove access to ${folder.name}`}
                    onClick={() => void act("/api/local-folders/revoke", { id: folder.id })}
                  >Remove</button>
                </li>
              ))}
            </ul>
            <button disabled={!snapshot || working} onClick={() => void chooseFolder()}>
              Choose folder
            </button>
          </details>
          <div className="transcript" aria-live="polite">
            {!transcript?.segments.length && (
              <div className="empty">
                <span>“</span>
                <h3>Begin anywhere.</h3>
                <p>
                  Dictate an idea, save a question, or ask Moo to explore
                  something with you.
                </p>
              </div>
            )}
            {transcript?.segments.map((segment) => (
              <article
                className={`utterance ${segment.speaker}`}
                key={segment.id}
              >
                <span>
                  {segment.speaker === "user"
                    ? "You"
                    : segment.speaker === "assistant"
                      ? "Moo"
                      : "Session"}
                </span>
                <p>
                  {segment.text || "…"}
                  {!segment.final && <em> · transcribing</em>}
                </p>
              </article>
            ))}
          </div>
          {(state?.pendingOffer?.kind === "help" ||
            state?.pendingOffer?.kind === "general_help") && (
            <div className="offer">
              <p>
                {state.pendingOffer.kind === "help"
                  ? "Would you like help with your saved doubt? Accepting captures your main display for context."
                  : "Would you like help with that? Your thought is saved. Moo will wait for your answer."}
              </p>
              <button onClick={() => void act("/api/input", { text: "Yes" })}>
                Yes, help me
              </button>
              <button onClick={() => void act("/api/input", { text: "No" })}>
                Keep it for later
              </button>
            </div>
          )}
          {state?.pendingOffer?.kind === "clarification" && (
            <div className="offer" role="status">
              Your words are saved. Tell Moo whether you want help or want to
              keep this as a note.
            </div>
          )}
          {state?.pendingOffer?.kind === "end_work" && (
            <div className="offer">
              <p>Moo still has work in progress.</p>
              {["Finish", "Cancel", "Continue"].map((choice) => (
                <button
                  key={choice}
                  onClick={() =>
                    void act("/api/end/resolve", {
                      action: choice.toLowerCase(),
                    })
                  }
                >
                  {choice}
                </button>
              ))}
            </div>
          )}
          <div className="composer">
            <label className="sr-only" htmlFor="input">
              Dictate or ask Moo
            </label>
            <textarea
              id="input"
              placeholder="A thought to keep, or ‘Can you help me…’"
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={!state?.listening}
            />
            <div className="controls">
              <div>
                <button
                  disabled={!state?.listening || working}
                  onClick={() => void talk()}
                >
                  Talk
                </button>
                <button
                  disabled={!state?.listening}
                  onClick={() => void act("/api/voice", { action: "stop" })}
                >
                  Stop mic
                </button>
                <button onClick={() => void act("/api/speech/stop")}>
                  Stop speech
                </button>
              </div>
              <button
                className="primary"
                disabled={!state?.listening || !text.trim() || working}
                onClick={() => void send()}
              >
                Send ↗
              </button>
            </div>
          </div>
          <div className="conversation-footer">
            <small>
              Saved locally first · Microphone audio is not retained
            </small>
            <button
              disabled={!state?.listening || working}
              onClick={() => void act("/api/voice", { action: "flush" })}
            >
              Send voice turn
            </button>
            {state?.conversationId && (
              <button disabled={working} onClick={() => void act("/api/end")}>
                End Moo conversation
              </button>
            )}
          </div>
        </section>
        <section className="brain">
          <div className="section-heading">
            <div>
              <span className="eyebrow">BRAIN</span>
              <h2>
                {showSessions ? "Session transcripts" : "Saved notes"}{" "}
                <span className="count">{nodes.length}</span>
              </h2>
            </div>
            <button onClick={() => void act("/api/retry")}>
              Retry pending
            </button>
          </div>
          <div className="view-switch">
            <button
              aria-pressed={!showSessions}
              onClick={() => {
                setShowSessions(false);
                setSelected(undefined);
              }}
            >
              Notes
            </button>
            <button
              aria-pressed={showSessions}
              onClick={() => {
                setShowSessions(true);
                setSelected(undefined);
              }}
            >
              Session transcripts
            </button>
          </div>
          <label className="sr-only" htmlFor="search">
            Search saved notes
          </label>
          <input
            id="search"
            className="search"
            placeholder="Find a thought, topic, or phrase…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <div className="notes">
            {nodes.length === 0 && (
              <p className="hint">
                Your saved notes will appear here. Off-topic and uncertain
                thoughts are kept too.
              </p>
            )}
            {nodes.map((node) => (
              <button
                className={`note ${record?.id === node.id ? "selected" : ""}`}
                onClick={() => {
                  setSelected(node.id);
                  setEdit(undefined);
                }}
                key={node.id}
              >
                <span className="note-top">
                  <strong>
                    {node.title ||
                      (node.kind === "conversation"
                        ? "Moo conversation"
                        : "Saved thought")}
                  </strong>
                  <small>
                    {new Date(node.createdAt).toLocaleTimeString([], {
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </small>
                </span>
                <p>
                  {node.summary ||
                    node.segments[0]?.text ||
                    "Transcript saved. Processing pending."}
                </p>
                <span className="tags">
                  {node.purpose && <span>{node.purpose}</span>}
                  {node.offTopic && <span>Off-topic</span>}
                  <span
                    className={node.quality === "needs_review" ? "review" : ""}
                  >
                    {node.quality.replace("_", " ")}
                  </span>
                </span>
              </button>
            ))}
          </div>
          {record && (
            <article className="detail">
              <div className="detail-heading">
                <h3>{record.title || "Saved thought"}</h3>
                <button
                  onClick={() =>
                    setEdit({
                      id: record.id,
                      revision: record.revision,
                      title: record.title,
                      summary: record.summary,
                      topics: record.topics.join(", "),
                    })
                  }
                >
                  Edit
                </button>
              </div>
              <div className="save-status">
                Saved locally ·{" "}
                {record.acceptedRevision >= record.revision
                  ? "Backend accepted"
                  : "Backend acceptance pending"}
              </div>
              {edit?.id === record.id ? (
                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    const topics = [...new Set(edit.topics.split(",").map((topic) => topic.trim()).filter(Boolean))];
                    const patch: RecordPatch = {};
                    if (edit.title !== record.title) patch.title = edit.title;
                    if (edit.summary !== record.summary) patch.summary = edit.summary;
                    if (JSON.stringify(topics) !== JSON.stringify(record.topics)) patch.topics = topics;
                    if (!Object.keys(patch).length) { setEdit(undefined); return; }
                    void act(
                      `/api/record/${record.id}`,
                      { revision: edit.revision, patch },
                      () => setEdit(undefined),
                    );
                  }}
                >
                  <label>
                    Title
                    <input
                      value={edit.title}
                      onChange={(event) =>
                        setEdit({ ...edit, title: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Summary
                    <textarea
                      value={edit.summary}
                      onChange={(event) =>
                        setEdit({ ...edit, summary: event.target.value })
                      }
                    />
                  </label>
                  <label>
                    Topics · separate with commas
                    <input
                      value={edit.topics}
                      onChange={(event) => setEdit({ ...edit, topics: event.target.value })}
                    />
                  </label>
                  <button className="primary" disabled={working}>
                    Save edits
                  </button>
                  <button type="button" onClick={() => setEdit(undefined)}>
                    Cancel
                  </button>
                </form>
              ) : (
                <p className="summary">
                  {record.summary || "Source retained. Summary pending."}
                </p>
              )}
              <div className="tags">
                {record.purpose && <span>{record.purpose}</span>}
                {record.topics.map((topic) => (
                  <span key={topic}>{topic}</span>
                ))}
                {record.offTopic && (
                  <span title={`Outside ${record.offTopic.subject}`}>
                    Off-topic: {record.offTopic.subject}
                  </span>
                )}
              </div>
              {record.topics.length > 0 && (
                <p className="topic-note">
                  {record.manualFields.includes("topics")
                    ? "Topics edited by you."
                    : "Suggested topics · edit to refine or remove."}
                </p>
              )}
              {record.qualityReasons.length > 0 && (
                <p className="quality">
                  Review: {record.qualityReasons.join(" · ")}
                </p>
              )}
              {record.error && <p className="quality">{record.error}</p>}
              {record.links.length > 0 && (
                <div className="connections">
                  <h4>Connections</h4>
                  {record.links.map((link) => (
                    <button
                      key={link.targetId}
                      onClick={() => setSelected(link.targetId)}
                    >
                      {records.find((item) => item.id === link.targetId)
                        ?.title || link.targetId}{" "}
                      <small>· {link.provenance}</small>
                    </button>
                  ))}
                </div>
              )}
              <details>
                <summary>
                  Original transcript · {record.segments.length} segments
                </summary>
                {record.segments.map((segment) => (
                  <p className="source" key={segment.id}>
                    <strong>{segment.speaker}:</strong> {segment.text}
                  </p>
                ))}
              </details>
              <div className="detail-actions">
                <button onClick={() => void download(record)}>
                  Export Markdown
                </button>
                <button
                  onClick={() =>
                    void act("/api/retry", { recordId: record.id })
                  }
                >
                  Retry processing
                </button>
              </div>
            </article>
          )}
        </section>
      </main>
      <footer>
        MOOLAI <span>Your ideas belong here, even before they make sense.</span>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
