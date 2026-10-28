import { randomUUID } from "node:crypto";

// Content-free lifecycle notifications. Slow clients are disconnected rather than
// accumulating unbounded per-client queues; reconnect begins with current state.
export function createLocalProgressEvents({ snapshotStatus, refresh, limit = 16, heartbeatMs = 15_000 }) {
  const instanceId = randomUUID();
  const clients = new Set();
  let sequence = 0;
  let closed = false;
  const payload = (report = null) => ({ instanceId, sequence: ++sequence,
    snapshot: { status: snapshotStatus().status }, refresh: refresh.getProgressStatus(), report });
  const frame = (value) => `event: progress\ndata: ${JSON.stringify(value)}\n\n`;
  function send(response, message) {
    try {
      if (!response.write(message)) { clients.delete(response); response.destroy(); }
    } catch { clients.delete(response); response.destroy(); }
  }
  function publish(report = null) {
    if (report !== null && (!report || !["work_usage", "model_performance"].includes(report.kind)
        || !["ready", "failed", "cancelled", "changed"].includes(report.status))) return;
    if (report !== null) report = { kind: report.kind, status: report.status };
    if (closed || clients.size === 0) return;
    const message = frame(payload(report));
    for (const client of clients) send(client, message);
  }
  const unsubscribe = refresh.subscribe(() => publish());
  const heartbeat = setInterval(() => {
    for (const client of clients) send(client, ": heartbeat\n\n");
  }, heartbeatMs);
  heartbeat.unref?.();
  return {
    publish,
    connect(request, response) {
      if (closed || clients.size >= limit) return false;
      response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "Connection": "keep-alive", "X-Content-Type-Options": "nosniff", "Cross-Origin-Resource-Policy": "same-origin" });
      clients.add(response);
      response.once("close", () => clients.delete(response));
      send(response, frame(payload()));
      return true;
    },
    close() {
      if (closed) return;
      closed = true;
      unsubscribe();
      clearInterval(heartbeat);
      for (const client of clients) client.destroy();
      clients.clear();
    },
  };
}
