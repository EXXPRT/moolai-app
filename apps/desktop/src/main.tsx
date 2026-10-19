import { MarkdownContent } from "./MarkdownContent.js";
import { BrainWorkspace } from "./BrainWorkspace.js";
import { useChatFollow } from "./useChatFollow.js";
import React, { useEffect, useRef, useState } from "react";
import { actionMessage, connectionAfterRefresh, processingMessage, readableNotice, clearAcknowledgedDraft, stopControl, type ConnectionStatus } from "./feedback.js";
import { createRoot } from "react-dom/client";
import type {
  AgentEvent,
  AgentState,
  BrainRecord,
  LocalFolder,
} from "../../../packages/contracts/src/index.js";
import "./style.css";

import { applySnapshotEvent, reconcileSnapshot, type Snapshot, type SnapshotEvent } from "./snapshot.js";
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
      openExternal?(url: string): Promise<void>;
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
  const [selectedNote,setSelectedNote] = useState<{id:string;nonce:number}>();
  const [connection, setConnection] = useState<ConnectionStatus>("connecting");
  const [savedSubmission, setSavedSubmission] = useState(false);
  const refreshSequence = useRef(0);
  const refreshEvents = useRef<SnapshotEvent[]>([]);
  const refreshPending = useRef<Promise<void> | undefined>(undefined);
  const transcriptPane = useRef<HTMLDivElement>(null);
  const api = window.moolai;
  async function refresh() {
    if (!api) return;
    // Polling and post-action refresh share one request, so an older response cannot replace newer UI state.
    if (refreshPending.current) return refreshPending.current;
    const sequence = ++refreshSequence.current;
    refreshEvents.current = [];
    const request = api.request<Snapshot>("GET", "/api/state").then(next => {
      if (sequence !== refreshSequence.current) return;
      setSnapshot(reconcileSnapshot(next, refreshEvents.current));
      setConnection(connectionAfterRefresh(true));
    }).catch(() => {
      if (sequence === refreshSequence.current) setConnection(connectionAfterRefresh(false));
    }).finally(() => { if (refreshPending.current === request) refreshPending.current = undefined; });
    refreshPending.current = request;
    return request;
  }
  useEffect(() => {
    if (!api) {
      setError(
        "Open Moolai through the Electron desktop host: npm run desktop",
      );
      return;
    }
    void refresh();
    const dispose = api.subscribe((event) => {
      if (refreshPending.current) refreshEvents.current.push(event);
      setSnapshot(old => old ? applySnapshotEvent(old, event) : old);
      if (event.type === "notice" && event.message) {
        const message = readableNotice(event.message);
        if (message) setNotice(message);
      }

    });
    const timer = window.setInterval(
      () => void refresh(),
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
      setError(actionMessage(e, path));
    } finally {
      setWorking(false);
    }
  }
  async function send() {
    if (!text.trim() || working) return;
    const submitted = text;
    setSavedSubmission(false);
    await act("/api/input", { text: submitted }, () => { setText(current => clearAcknowledgedDraft(current, submitted)); setSavedSubmission(true); });
  }
  async function chooseFolder() {
    if (!api) return;
    setWorking(true);
    setError("");
    try {
      await api.chooseFolder();
      await refresh();
    } catch (e) {
      setError(actionMessage(e, "/api/local-folders"));
    } finally {
      setWorking(false);
    }
  }
  async function talk() {
    if (!api) return;
    setError("");
    try {
      await act("/api/voice", { action: "start" });
    } catch (e) {
      setError(actionMessage(e, "/api/voice"));
    }
  }
  const state = snapshot?.state;
  const stop = stopControl(Boolean(snapshot?.native?.speaking), Boolean(state?.busy));
  const records = [...(snapshot?.records || [])].sort((a, b) =>
    b.updatedAt.localeCompare(a.updatedAt),
  );
  const session = records.find((item) => item.id === state?.sessionId);
  const conversation = records.find(
    (item) => item.id === state?.conversationId,
  );
  const transcript = conversation || session;
  const visibleSegments = transcript?.segments.filter(segment => segment.text.trim()) ?? [];
  const follow = useChatFollow(transcriptPane, `${transcript?.id ?? ""}:${transcript?.sourceRevision ?? 0}`);
  const micRequested = Boolean(snapshot?.native?.requestedOn || snapshot?.native?.enabled);
  const processingAvailable = snapshot?.processing?.status === "available";
  const offlineMessage = snapshot?.processing?.status === "unavailable" ? processingMessage(false, savedSubmission && !text.trim()) : undefined;
  const currentResponseFailed = Boolean(state?.conversationId && state.lastError && !state.busy && processingAvailable);
  useEffect(() => {
    if (!notice) return;
    const timer = window.setTimeout(() => setNotice(""), 8000);
    return () => window.clearTimeout(timer);
  }, [notice]);
  return (
    <div className="shell">
      <header>
        <div className="brand">
          <span className="mark">m</span>
          <div>
            <h1>Moolai</h1>
            <p>Your second brain, in conversation.</p>
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
      {connection === "disconnected" && <div className="connection-status" role="status">Connecting to your local workspace… Your draft stays here.</div>}
      {offlineMessage && connection !== "disconnected" && <div className="connection-status" role="status">{offlineMessage}</div>}
      {error && <div role="alert" className="alert">{error}<button className="text-button" aria-label="Dismiss action message" onClick={() => setError("")}>Dismiss</button></div>}
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
              <span className="eyebrow">MOO</span>
              <h2>
                {state?.conversationId
                  ? "Talking with Moo"
                  : "Your thoughts, kept"}
              </h2>
            </div>
            <span className="small-status">
              {snapshot?.native?.phase === "finishing_transcription"
                ? "Finishing transcription…"
                : snapshot?.native?.error
                ? "Microphone needs attention"
                : snapshot?.native?.phase === "reconnecting"
                ? "Reconnecting microphone…"
                : snapshot?.native?.phase === "connecting_asr"
                ? "Preparing speech recognition…"
                : snapshot?.native?.speaking
                ? "Moo is speaking · speak to interrupt"
                : state?.busy
                ? state.activity === "listening" ? "Listening to your update…" : state.activity === "searching" ? "Searching…" : "Preparing answer…"
                : state?.activity === "interrupted"
                  ? "Interrupted · ready for your next request"
                  : snapshot?.native?.listening
                  ? "Listening"
                  : snapshot?.native?.requestedOn ? "Connecting microphone…" : "Microphone off"}
            </span>
          </div>
          <details className="study-settings"><summary>Settings{state?.currentSubject ? ` · ${state.currentSubject}` : ""}</summary>
          <div className="study-settings-panel">
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
          {snapshot?.localFoldersAvailable && <details className="folder-access">
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
          </details>}
          </div>
          </details>
          <div className="chat-follow-controls">
            <label><input type="checkbox" checked={follow.enabled} onChange={event => follow.setFollow(event.target.checked)} />Auto-follow latest</label>
            {follow.enabled && follow.paused ? <span>Paused while reading</span> : null}
            {!follow.atBottom ? <button className="text-button" onClick={follow.jump}>Jump to latest ↓</button> : null}
          </div>
          <div ref={transcriptPane} className="transcript" role="region" aria-label="Conversation transcript" tabIndex={0} aria-live="polite">
            {!visibleSegments.length && (
              <div className="empty">
                <span>“</span>
                <h3>Begin anywhere.</h3>
                <p>
                  Dictate an idea, save a question, or ask Moo to explore
                  something with you.
                </p>
              </div>
            )}
            {visibleSegments.map((segment) => (
              <article
                className={`utterance ${segment.speaker}`}
                key={segment.id}
                aria-busy={!segment.final}
              >
                <span>
                  {segment.speaker === "user"
                    ? "You"
                    : segment.speaker === "assistant"
                      ? "Moo"
                      : "Session"}
                </span>
                <div>
                  <MarkdownContent text={segment.text} />
                  {!segment.final && <em> · Transcribing…</em>}
                </div>
                {segment.references?.map(ref=><button key={ref.recordId} className="note-reference" onClick={()=>setSelectedNote({id:ref.recordId,nonce:Date.now()})}>{ref.title}</button>)}
              </article>
            ))}
          </div>
          {state?.understoodRequest?.conversationId === state?.conversationId && state?.understoodRequest &&
            <p className="response-status understood-request" role="status"><strong>Moo understood: </strong>{state.understoodRequest.text}</p>}
          {currentResponseFailed && <p className="response-status" role="status">Moo couldn’t finish that response. Your conversation is still here; you can ask again.</p>}
          {(state?.pendingOffer?.kind === "help" ||
            state?.pendingOffer?.kind === "general_help") && (
            <div className="offer">
              <p>
                {state.pendingOffer.kind === "help"
                  ? "Would you like help with your saved doubt? Accepting captures your main display for context."
                  : "Would you like help with that? Your thought is saved. Moo will wait for your answer."}
              </p>
              <button disabled={working} onClick={() => void act("/api/input", { text: "Yes" })}>
                Yes, help me
              </button>
              <button disabled={working} onClick={() => void act("/api/input", { text: "No" })}>
                Keep it for later
              </button>
            </div>
          )}
          {state?.pendingOffer?.kind === "clarification" && (
            <div className="offer" role="status">
              Would you like Moo to answer that? Say yes or no. Your original request is saved.
            </div>
          )}
          {(state?.pendingOffer?.kind === "close" || state?.pendingOffer?.kind === "note_suppression") && (
            <div className="offer" role="status">
              <p>{state.pendingOffer.question}</p>
              <button disabled={working} onClick={() => void act("/api/input", { text: "Yes" })}>Yes</button>
              <button disabled={working} onClick={() => void act("/api/input", { text: "No" })}>No</button>
            </div>
          )}
          {state?.pendingOffer?.kind === "end_work" && (
            <div className="offer">
              <p>Moo still has work in progress.</p>
              {["Finish", "Cancel", "Continue"].map((choice) => (
                <button
                  key={choice}
                  disabled={working}
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
              onChange={(event) => { setText(event.target.value); setSavedSubmission(false); }}
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
                <button className={`mic-toggle ${micRequested ? "is-on" : ""}`}
                  disabled={!state?.listening || (working && !micRequested)} aria-pressed={micRequested}
                  aria-label={micRequested ? "Turn microphone off" : "Turn microphone on"}
                  onClick={() => void (micRequested ? act("/api/voice", {action:"stop"}) : talk())}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3M8 22h8"/></svg>
                  {micRequested ? "Mic on" : "Mic off"}
                </button>
                {stop && <button className="text-button" onClick={() => void act(stop.path)}>{stop.label}</button>}
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
            <small>{session?.segments.length ? "Saved locally · audio isn’t stored" : "Your words stay yours"}</small>
            {state?.conversationId && (
              <button className="text-button" disabled={working} onClick={() => void act("/api/end")}>
                Finish conversation
              </button>
            )}
          </div>
        </section>
        <BrainWorkspace ready={!!snapshot} liveThought={snapshot?.liveThought} processing={snapshot?.thoughtProcessing} processingAvailable={processingAvailable} retry={()=>act("/api/retry",{recordId:state?.sessionId,scope:"summary"})} records={snapshot?.records ?? []} api={api} refresh={refresh} requestedNote={selectedNote}/>

      </main>

    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
