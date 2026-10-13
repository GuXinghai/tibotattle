// Worker batch credits and lineage work balancing for the local index refresh.
//
// The refresh parses rollouts on worker threads and writes each received batch
// on the host through synchronous node:sqlite calls. Lineage components keep a
// fork and every ancestor and descendant together so inheritance works when
// components are spread across lanes.

// A received worker batch is written through synchronous node:sqlite calls.
// Bound that one host turn independently from the writer's commit cadence so
// loopback health, progress, and cancellation can run between batches.
export const WORKER_BATCH_EVENTS = 500;
// `postMessage` itself has no producer-side queue bound. Two shared credits let
// one parser overlap extraction with one synchronous host write without ever
// retaining more than two structured-clone batches (1,000 records) per lane.
export const WORKER_BATCH_WINDOW_SIZE = 2;

const WORKER_BATCH_CREDITS = 0;
const WORKER_BATCH_OUTSTANDING = 1;
const WORKER_BATCH_PEAK_OUTSTANDING = 2;
const WORKER_BATCH_WAIT_COUNT = 3;
const WORKER_BATCH_WINDOW_SLOT = 4;
const WORKER_BATCH_CONTROL_LENGTH = 5;

function assertWorkerBatchControl(control) {
  if (!(control instanceof Int32Array)
      || !(control.buffer instanceof SharedArrayBuffer)
      || control.length !== WORKER_BATCH_CONTROL_LENGTH) {
    throw new TypeError("worker batch control is invalid");
  }
  return control;
}

export function createWorkerBatchControl({
  initialCredits = WORKER_BATCH_WINDOW_SIZE,
} = {}) {
  if (!Number.isSafeInteger(initialCredits)
      || initialCredits < 0
      || initialCredits > WORKER_BATCH_WINDOW_SIZE) {
    throw new TypeError(
      `initialCredits must be between 0 and ${WORKER_BATCH_WINDOW_SIZE}`,
    );
  }
  const control = new Int32Array(new SharedArrayBuffer(
    Int32Array.BYTES_PER_ELEMENT * WORKER_BATCH_CONTROL_LENGTH,
  ));
  Atomics.store(control, WORKER_BATCH_CREDITS, initialCredits);
  Atomics.store(
    control,
    WORKER_BATCH_WINDOW_SLOT,
    WORKER_BATCH_WINDOW_SIZE,
  );
  return control;
}

export function workerBatchControlSnapshot(control) {
  const view = assertWorkerBatchControl(control);
  return {
    credits: Atomics.load(view, WORKER_BATCH_CREDITS),
    outstanding: Atomics.load(view, WORKER_BATCH_OUTSTANDING),
    peakOutstanding: Atomics.load(view, WORKER_BATCH_PEAK_OUTSTANDING),
    waitCount: Atomics.load(view, WORKER_BATCH_WAIT_COUNT),
    window: Atomics.load(view, WORKER_BATCH_WINDOW_SLOT),
  };
}

export function releaseWorkerBatch(control) {
  const view = assertWorkerBatchControl(control);
  while (true) {
    const outstanding = Atomics.load(view, WORKER_BATCH_OUTSTANDING);
    if (outstanding < 1) {
      throw new Error("worker batch acknowledgement is unbalanced");
    }
    if (Atomics.compareExchange(
      view,
      WORKER_BATCH_OUTSTANDING,
      outstanding,
      outstanding - 1,
    ) === outstanding) break;
  }
  const credits = Atomics.add(view, WORKER_BATCH_CREDITS, 1) + 1;
  const window = Atomics.load(view, WORKER_BATCH_WINDOW_SLOT);
  if (credits > window) {
    Atomics.sub(view, WORKER_BATCH_CREDITS, 1);
    Atomics.add(view, WORKER_BATCH_OUTSTANDING, 1);
    throw new Error("worker batch acknowledgement exceeds its window");
  }
  Atomics.notify(view, WORKER_BATCH_CREDITS, 1);
}


/**
 * Group discovered sources into lineage components — a fork and every one of
 * its ancestors and descendants stay together — and order each component
 * parent-first. That ordering is what lets a forked child inherit its parent's
 * model, and keeping a component whole is what lets the same inheritance work
 * when components are spread across worker threads.
 */
export function lineageComponents(infos) {
  const byThreadId = new Map();
  const byRolloutId = new Map();
  for (const info of infos) {
    const threadId = info.threadId ?? info.lineage?.sessionId;
    if (threadId) {
      const members = byThreadId.get(threadId) ?? [];
      members.push(info);
      byThreadId.set(threadId, members);
    }
    if (info.rolloutId) byRolloutId.set(info.rolloutId, info);
  }
  const dependencies = new Map(infos.map((info) => [info, new Set()]));
  const neighbors = new Map(infos.map((info) => [info, new Set()]));
  function connect(info, dependency) {
    if (dependency === undefined || dependency === info) return;
    dependencies.get(info).add(dependency);
    neighbors.get(info).add(dependency);
    neighbors.get(dependency).add(info);
  }
  for (const info of infos) {
    const baseId = info.lineage?.historyBase?.rolloutId ?? null;
    if (baseId !== null) connect(info, byRolloutId.get(baseId));
    const parentId = info.lineage?.parentId ?? null;
    for (const parent of byThreadId.get(parentId) ?? []) {
      connect(info, parent);
    }
  }

  const components = [];
  const assigned = new Set();
  for (const start of infos) {
    if (assigned.has(start)) continue;
    const members = [];
    const queue = [start];
    let queueIndex = 0;
    assigned.add(start);
    while (queueIndex < queue.length) {
      const current = queue[queueIndex];
      queueIndex += 1;
      members.push(current);
      for (const neighbor of neighbors.get(current)) {
        if (assigned.has(neighbor)) continue;
        assigned.add(neighbor);
        queue.push(neighbor);
      }
    }
    const depthMemo = new Map();
    function depth(startInfo) {
      if (depthMemo.has(startInfo)) return depthMemo.get(startInfo);
      const active = new Set();
      const stack = [{ info: startInfo, expanded: false }];
      while (stack.length > 0) {
        const frame = stack[stack.length - 1];
        if (depthMemo.has(frame.info)) {
          active.delete(frame.info);
          stack.pop();
          continue;
        }
        if (!frame.expanded) {
          frame.expanded = true;
          active.add(frame.info);
          for (const parent of dependencies.get(frame.info)) {
            if (!depthMemo.has(parent) && !active.has(parent)) {
              stack.push({ info: parent, expanded: false });
            }
          }
          continue;
        }
        let maximumParentDepth = -1;
        for (const parent of dependencies.get(frame.info)) {
          maximumParentDepth = Math.max(
            maximumParentDepth,
            depthMemo.get(parent) ?? 0,
          );
        }
        depthMemo.set(frame.info, maximumParentDepth + 1);
        active.delete(frame.info);
        stack.pop();
      }
      return depthMemo.get(startInfo) ?? 0;
    }
    members.sort((left, right) => (
      depth(left) - depth(right)
      || Number(left.resolvedHead === true) - Number(right.resolvedHead === true)
      || left.rolloutKey.localeCompare(right.rolloutKey)
    ));
    components.push({
      root: members[0],
      members,
      bytes: members.reduce((sum, info) => sum + Number(info.size ?? 0), 0),
    });
  }
  return components.sort((left, right) => right.bytes - left.bytes);
}

export function balanceComponents(components, workerCount) {
  const lanes = Array.from(
    { length: workerCount },
    () => ({ bytes: 0, members: [], components: [] }),
  );
  for (const component of components) {
    let lightest = lanes[0];
    for (const lane of lanes) if (lane.bytes < lightest.bytes) lightest = lane;
    lightest.bytes += component.bytes;
    // A lane keeps its components separable, not just concatenated: the worker
    // holds fork-replay snapshot sets for one component at a time and frees
    // them at its boundary, so a lane's peak is its largest component rather
    // than the whole lane.
    lightest.components.push(component.members);
    for (const member of component.members) lightest.members.push(member);
  }
  return lanes.filter((lane) => lane.members.length > 0);
}
