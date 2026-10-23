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
  paused = false,
  onError = () => {}, clock = () => Date.now(), canAutomaticallyRefresh = async () => true } = {}) {
  if (!validOverviewRefreshIntervalSeconds(intervalSeconds)) throw new TypeError("refresh interval is invalid");
  if (typeof paused !== "boolean") throw new TypeError("refresh pause is invalid");
  let timer = null, pending = null, closed = false, started = false, errorCode = null, nextAt = null, generation=0;
  const report = (code) => { errorCode=code; onError(code); };
  function disarm() {
    if (timer !== null) clearTimer(timer);
    timer = null;
    nextAt = null;
  }
  function arm() {
    disarm();
    if (closed || paused || !started || pending !== null || intervalSeconds === -1) return;
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
        else void automaticRequest();
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
  function submit({ mode = "overview", reason = "manual" } = {}) {
    if (closed || paused) return { started: false, joined: false, pending: false, refresh: refresh.getStatus?.() };
    started = true;
    errorCode = null; disarm();
    try {
      const receipt = typeof refresh.request === "function"
        ? refresh.request({ mode, reason })
        : { started: refresh.start({ mode }), joined: false, pending: false };
      observe();
      return receipt;
    } catch {
      report("overview_refresh_schedule_failed"); arm();
      return { started: false, joined: false, pending: false, refresh: refresh.getStatus?.() };
    }
  }
  function request(options) { return submit(options).started; }
  async function automaticRequest() {
    const current = generation;
    try {
      const allowed = await canAutomaticallyRefresh();
      if (closed || paused || current !== generation) return false;
      if (!allowed) { arm(); return false; }
      return request({ reason: "automatic" });
    } catch { report("overview_refresh_schedule_failed"); arm(); return false; }
  }
  return {
    start() { started = true; arm(); }, request, submit, observe,
    setPaused(value) {
      if (typeof value !== "boolean") throw new TypeError("refresh pause is invalid");
      paused = value;
      // Invalidate permission checks already awaiting I/O. Keep the pending
      // run's settlement observer so resume cannot start a second writer.
      // cancel() also clears any queued detailed pass.
      if (pending === null) ++generation;
      disarm();
      if (paused) refresh.cancel?.();
      else arm();
    },
    setIntervalSeconds(seconds) {
      if (!validOverviewRefreshIntervalSeconds(seconds)) throw new TypeError("refresh interval is invalid");
      intervalSeconds = seconds;
      if (pending === null) { ++generation; arm(); }
      else disarm();
    },
    status:()=>({nextAt,errorCode,intervalSeconds,paused}),
    close() { closed=true; ++generation; disarm(); },
  };
}

/** Fixed parent-only IPC listener. Unknown broker messages remain untouched. */
export function attachOverviewRefreshIntervalChannel({ channel, scheduler } = {}) {
  const onMessage = (message) => {
    if (message === null || typeof message !== "object" || Array.isArray(message)
        || Object.getPrototypeOf(message) !== Object.prototype
        || Reflect.ownKeys(message).length !== 3
        || message.type !== "tibotattle.refresh-interval.v2"
        || !Object.hasOwn(message, "type") || !Object.hasOwn(message, "paused")
        || typeof message.paused !== "boolean"
        || !Object.hasOwn(message, "seconds")
        || !validOverviewRefreshIntervalSeconds(message.seconds)) return;
    scheduler.setPaused(message.paused);
    scheduler.setIntervalSeconds(message.seconds);
  };
  channel.on("message", onMessage);
  return () => channel.off("message", onMessage);
}
