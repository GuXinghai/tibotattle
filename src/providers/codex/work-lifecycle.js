// Content-free task lifecycle. This is deliberately independent of model
// throughput qualification: tools, waiting, failures and cancellation are work.
const KINDS = new Map([
  ["task_started", "start"], ["task_complete", "complete"],
  ["turn_aborted", "abort"],
]);
export function codexWorkLifecycle(record) {
  if (record?.type !== "event_msg") return null;
  const payload = record.payload;
  const kind = KINDS.get(payload?.type);
  if (!kind) return null;
  const atMs = Date.parse(record.timestamp);
  const taskId = payload.turn_id;
  if (!Number.isSafeInteger(atMs) || atMs < 0
      || typeof taskId !== "string" || taskId.length < 1 || taskId.length > 256
      || /[\u0000-\u001f\u007f]/u.test(taskId)) return null;
  const durationMs = kind === "complete" && Number.isSafeInteger(payload.duration_ms)
    && payload.duration_ms >= 0 ? payload.duration_ms : null;
  return { kind, taskId, observedAtMs: atMs, durationMs };
}
