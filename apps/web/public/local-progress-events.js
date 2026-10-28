const exact = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const oneOf = (value, values) => values.includes(value);
const modes = [null, 'quick', 'overview', 'detailed'];
function validProgress(value) {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const keys = ['kind', 'status', 'phase', 'filesDiscovered', 'filesSelected', 'filesProcessed', 'recordsWritten'];
  if (Object.keys(value).some(key => !keys.includes(key))) return false;
  if (value.kind !== undefined && !oneOf(value.kind, ['accounting', 'unified_index'])) return false;
  if (!oneOf(value.status, ['calculating', 'scanning', 'recent_7d_indexing', 'recent_7d_complete', 'recent_7d_partial', 'prospective_only', 'bounded_pause'])) return false;
  if (value.phase !== undefined && !oneOf(value.phase, ['discovering', 'rollout_index', 'quota_refresh', 'quick_result', 'complete', 'paused', 'prospective'])) return false;
  return ['filesDiscovered', 'filesSelected', 'filesProcessed', 'recordsWritten'].every(key =>
    value[key] === undefined || Number.isSafeInteger(value[key]) && value[key] >= 0);
}
function validEvent(value) {
  if (!exact(value, ['instanceId', 'sequence', 'snapshot', 'refresh', 'report'])
      || typeof value.instanceId !== 'string' || !/^[0-9a-f-]{36}$/i.test(value.instanceId)
      || !Number.isSafeInteger(value.sequence) || value.sequence < 1
      || !exact(value.snapshot, ['status']) || !oneOf(value.snapshot.status, ['building', 'ready', 'failed'])) return false;
  const r = value.refresh;
  return exact(r, ['refreshId', 'status', 'mode', 'reason', 'quota', 'usage', 'progress', 'pending', 'quickResultPublished', 'publication'])
    && (r.refreshId === null || typeof r.refreshId === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(r.refreshId))
    && oneOf(r.status, ['idle', 'running', 'cancelling', 'succeeded', 'degraded', 'failed', 'cancelled'])
    && oneOf(r.mode, modes) && oneOf(r.reason, [null, 'manual', 'automatic', 'startup'])
    && exact(r.quota, ['status']) && oneOf(r.quota.status, ['skipped', 'running', 'published', 'failed', 'cancelled'])
    && exact(r.usage, ['status']) && oneOf(r.usage.status, ['skipped', 'pending', 'running', 'succeeded', 'deferred', 'reused', 'failed', 'cancelled'])
    && validProgress(r.progress) && (r.pending === null || exact(r.pending, ['mode']) && oneOf(r.pending.mode, modes.slice(1)))
    && typeof r.quickResultPublished === 'boolean' && oneOf(r.publication, [null, 'running'])
    && (value.report === null || exact(value.report, ['kind', 'status'])
      && oneOf(value.report.kind, ['work_usage', 'model_performance']) && oneOf(value.report.status, ['ready', 'failed', 'cancelled', 'changed']));
}

// The stream reports observation state only. A disconnected renderer never
// cancels or declares failure of the companion's independent work.
export function createLocalProgressEvents({ EventSourceRef = globalThis.EventSource, url = '/api/local/events',
  setTimeoutRef = globalThis.setTimeout, clearTimeoutRef = globalThis.clearTimeout } = {}) {
  const listeners = new Set();
  const retired = new Set();
  let source = null, instance = null, sequence = -1, revision = 0, latest = null;
  let connection = 'connecting', closed = false;
  const waiters = new Set();
  function changed() {
    revision++;
    for (const resolve of waiters) resolve();
    waiters.clear();
  }
  function setConnection(value) {
    if (connection === value) return;
    connection = value;
    changed();
    if (value !== 'connected') for (const listener of listeners) {
      try { Promise.resolve(listener({ ...latest, connection: value })).catch(() => {}); } catch { /* Isolate observers. */ }
    }
  }
  if (typeof EventSourceRef === 'function') {
    try {
      source = new EventSourceRef(url);
      source.addEventListener('error', () => { if (!closed) setConnection('disconnected'); });
      source.addEventListener('progress', event => {
        if (closed) return;
        let value;
        try { value = JSON.parse(event.data); } catch { return; }
        if (!validEvent(value)) return;
        if (retired.has(value.instanceId)) return;
        if (instance !== value.instanceId) {
          if (instance !== null) {
            if (retired.size >= 64) { source.close(); setConnection('unavailable'); return; }
            retired.add(instance);
          }
          instance = value.instanceId;
          sequence = -1;
        }
        if (value.sequence <= sequence) return;
        sequence = value.sequence;
        latest = { ...value, connection: 'connected' };
        connection = 'connected';
        changed();
        for (const listener of listeners) { try { Promise.resolve(listener(latest)).catch(() => {}); } catch { /* Isolate observers. */ } }
      });
    } catch { connection = 'unavailable'; }
  } else connection = 'unavailable';
  return {
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    current: () => latest,
    connection: () => connection,
    cursor: () => revision,
    wait(after, { signal, timeoutMs } = {}) {
      if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs < 0))
        throw new TypeError('Invalid progress wait timeout');
      if (closed || connection === 'unavailable' || after !== revision || signal?.aborted || timeoutMs === 0) return Promise.resolve();
      return new Promise(resolve => {
        let timer = null;
        const finish = () => {
          waiters.delete(finish);
          signal?.removeEventListener('abort', finish);
          if (timer !== null) clearTimeoutRef(timer);
          resolve();
        };
        waiters.add(finish);
        signal?.addEventListener('abort', finish, { once: true });
        if (timeoutMs !== undefined) timer = setTimeoutRef(finish, timeoutMs);
      });
    },
    close() { if (closed) return; closed = true; source?.close(); setConnection('closed'); changed(); listeners.clear(); },
  };
}
