export const OVERVIEW_REFRESH_INTERVAL_MS = 300_000;
// One-shot, completion-based cadence. Joining or manual work invalidates the
// old deadline. This scheduler never runs a second ledger/index writer.
export function createOverviewRefreshScheduler({ refresh, setTimer = setTimeout, clearTimer = clearTimeout,
  onError = () => {}, clock = () => Date.now() } = {}) {
  let timer = null, pending = null, closed = false, errorCode = null, nextAt = null, generation=0;
  const report = (code) => { errorCode=code; onError(code); };
  function arm() {
    if (closed) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => { timer = null; request(); }, OVERVIEW_REFRESH_INTERVAL_MS);
    nextAt = new Date(clock()+OVERVIEW_REFRESH_INTERVAL_MS).toISOString();
    timer?.unref?.();
  }
  function observe() {
    nextAt=null;
    if (timer !== null) { clearTimer(timer); timer = null; }
    const work=refresh.whenSettled();
    if (pending === work) return;
    pending=work;
    const current=++generation;
    Promise.resolve(work)
      .catch(() => report("overview_refresh_settlement_failed"))
      .finally(() => { if(current===generation){pending = null; arm();} });
  }
  function request() {
    if (closed) return false;
    errorCode=null; nextAt=null;
    if (timer !== null) { clearTimer(timer); timer = null; }
    let accepted = false;
    try { accepted = refresh.start({mode:"overview"}); observe(); }
    catch { report("overview_refresh_schedule_failed"); arm(); }
    return accepted;
  }
  return { start: arm, request, observe, status:()=>({nextAt,errorCode}),close() { closed=true; if(timer!==null)clearTimer(timer);timer=null;nextAt=null; } };
}
