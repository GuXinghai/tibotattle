/** Desktop-owned preference; the companion scheduler is the execution authority. */
export function mountLocalRefreshPause({ button, summary, bridge, translate,
  onChange = () => {}, onError = () => {} } = {}) {
  if (!button || typeof bridge?.setRefreshPaused !== "function") return { teardown() {} };
  let paused = false, ready = false, busy = false, disposed = false, revision = 0;
  const paint = () => {
    if (disposed) return;
    button.hidden = false;
    button.disabled = !ready || busy;
    button.setAttribute("aria-pressed", String(paused));
    button.setAttribute("aria-label", translate(paused ? "refresh.resume" : "refresh.pause"));
    button.title = button.getAttribute("aria-label");
    button.querySelector("[data-pause-glyph]")?.toggleAttribute("hidden", paused);
    button.querySelector("[data-resume-glyph]")?.toggleAttribute("hidden", !paused);
    if (summary) {
      summary.hidden = !paused;
      summary.textContent = paused ? translate("refresh.paused") : "";
    }
    onChange({ paused, ready, busy });
  };
  const accept = snapshot => {
    if (typeof snapshot?.settings?.refreshPaused !== "boolean") throw new TypeError("refresh pause state is unavailable");
    paused = snapshot.settings.refreshPaused;
    ready = true;
  };
  async function reload() {
    if (busy || disposed) return;
    const current = ++revision;
    try {
      const snapshot = await bridge.getSettings();
      if (disposed || current !== revision) return;
      accept(snapshot);
    } catch { if (!disposed && current === revision) onError(); }
    if (!disposed && current === revision) paint();
  }
  async function click() {
    if (!ready || busy || disposed) return;
    busy = true;
    ++revision; // A previous read must not overwrite the acknowledged mutation.
    paint();
    try {
      const snapshot = await bridge.setRefreshPaused(!paused);
      if (!disposed) accept(snapshot);
    } catch {
      // Persistence may have succeeded before propagation failed. Re-read the
      // durable choice, but still show the failure rather than claiming success.
      try { const snapshot = await bridge.getSettings(); if (!disposed) accept(snapshot); } catch { /* Keep last known state. */ }
      if (!disposed) onError();
    } finally { busy = false; paint(); }
  }
  button.addEventListener("click", click);
  const unsubscribe = bridge.onCommand?.(command => {
    if (command?.command === "settingsChanged") void reload();
  });
  paint();
  void reload();
  return { repaint: paint, reload, teardown() {
    disposed = true; ++revision;
    button.removeEventListener("click", click);
    unsubscribe?.();
  } };
}
