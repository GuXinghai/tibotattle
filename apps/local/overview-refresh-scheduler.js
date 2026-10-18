export const OVERVIEW_REFRESH_INTERVAL_MS = 300_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

// Mirrored at the desktop IPC boundary. Only whole minutes or disabled cross
// the inherited parent/child channel; no paths, secrets, or work payloads.
export function validOverviewRefreshIntervalSeconds(seconds) {
  return seconds === -1 || (Number.isSafeInteger(seconds) && seconds > 0
    && seconds % 60 === 0 && Number.isSafeInteger(seconds * 1_000));
}
// One-shot, completion-based cadence. Joining or manual work invalidates the
// old deadline. This scheduler never runs a second ledger/index writer.
export function createOverviewRefreshScheduler({ refresh, setTimer = setTimeout, clearTimer = clearTimeout,
  intervalSeconds = OVERVIEW_REFRESH_INTERVAL_MS / 1_000,
  onError = () => {}, clock = () => Date.now() } = {}) {
  if (!validOverviewRefreshIntervalSeconds(intervalSeconds)) throw new TypeError("refresh interval is invalid");
  let timer = null, pending = null, closed = false, started = false, errorCode = null, nextAt = null, generation=0;
  const report = (code) => { errorCode=code; onError(code); };
  function disarm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextAt = null;
  }
  function arm() {
    disarm();
    if (closed || !started || pending !== null || intervalSeconds === -1) return;
    const revision = ++generation;
    const duration = intervalSeconds * 1_000;
    const deadline = clock() + duration;
    nextAt = Number.isFinite(deadline) && deadline <= 8_640_000_000_000_000
      ? new Date(deadline).toISOString() : null;
    function chunk(remaining) {
      const delay = Math.min(remaining, MAX_TIMER_DELAY_MS);
      timer = setTimer(() => {
        if (closed || revision !== generation) return;
        timer = null;
        if (remaining > delay) chunk(remaining - delay);
        else request();
      }, delay);
      timer?.unref?.();
    }
    chunk(duration);
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
    started = true;
    errorCode=null; nextAt=null;
    if (timer !== null) { clearTimer(timer); timer = null; }
    let accepted = false;
    try { accepted = refresh.start({mode:"overview"}); observe(); }
    catch { report("overview_refresh_schedule_failed"); arm(); }
    return accepted;
  }
  return {
    start() { started = true; arm(); }, request, observe,
    setIntervalSeconds(seconds) {
      if (!validOverviewRefreshIntervalSeconds(seconds)) throw new TypeError("refresh interval is invalid");
      intervalSeconds = seconds;
      if (pending === null) { ++generation; arm(); }
      else disarm();
    },
    status:()=>({nextAt,errorCode}),
    close() { closed=true; ++generation; disarm(); },
  };
}

/** Fixed parent-only IPC listener. Unknown broker messages remain untouched. */
export function attachOverviewRefreshIntervalChannel({ channel, scheduler } = {}) {
  const onMessage = (message) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)
        || Object.getPrototypeOf(message) !== Object.prototype
        || Reflect.ownKeys(message).length !== 2
        || message.type !== "tibotattle.refresh-interval.v1"
        || !Object.hasOwn(message, "seconds")
        || !validOverviewRefreshIntervalSeconds(message.seconds)) return;
    scheduler.setIntervalSeconds(message.seconds);
  };
  channel.on("message", onMessage);
  return () => channel.off("message", onMessage);
}
