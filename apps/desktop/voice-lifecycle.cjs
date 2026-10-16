/** Stop only the already-connected runtime; closing the UI must never launch one. */
function installVoiceLifecycle({ app, connection, fetch, reportError = console.error }) {
  let stopping;
  let quitAllowed = false;
  let quitting = false;
  function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      let info;
      try { info = await connection(); }
      catch { return; } // No runtime connection exists.
      // Dispatch independently: slow cancellation must not delay microphone-off.
      const results = await Promise.allSettled([
        ["/api/speech/stop", {}], ["/api/voice", { action: "stop" }],
      ].map(async ([path, body]) => {
        const response = await fetch(info.base + path, {
          method: "POST",
          headers: { Authorization: `Bearer ${info.token}`, "Content-Type": "application/json" },
          body: JSON.stringify(body), signal: AbortSignal.timeout(45000),
        });
        if (!response.ok) throw new Error(`Voice shutdown failed (${response.status})`);
      }));
      for (const result of results) if (result.status === "rejected")
        reportError("Could not confirm Moo stopped:", result.reason);
    })().finally(() => { stopping = undefined; });
    return stopping;
  }
  app.on("before-quit", event => {
    if (quitAllowed) return;
    event.preventDefault();
    if (quitting) return;
    quitting = true;
    void stop().finally(() => { quitAllowed = true; app.quit(); });
  });
  return { stop };
}
module.exports = { installVoiceLifecycle };
