import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { createWindowsProcessExitObserver } from "./helpers/windows-process-exit-observer.js";

function syntheticChild(exitCode) {
  const child = spawn(process.execPath, ["-e",
    `process.stdin.once('data', () => process.exit(${exitCode})); setInterval(() => {}, 1000);`], {
    stdio: ["pipe", "ignore", "ignore"], windowsHide: true,
  });
  const closed = once(child, "close");
  return { child, closed };
}

test("Windows exit observer pins one process and preserves a nonzero exit code", async () => {
  const observer = await createWindowsProcessExitObserver();
  const { child, closed } = syntheticChild(17);
  try {
    await observer.watch(child.pid);
    child.stdin.end("exit\n");
    await assert.rejects(observer.waitForExit(), /orphan exit code/u);
    await observer.waitForExit({ expectedCode: 17 });
    assert.deepEqual(await closed, [17, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await observer.close();
  }
});

test("Windows exit observer rejects a live process after the five-second bound without killing it", async () => {
  const observer = await createWindowsProcessExitObserver();
  const { child, closed } = syntheticChild(0);
  try {
    await observer.watch(child.pid);
    await assert.rejects(observer.waitForExit(), /kernel confirms process termination/u);
    assert.equal(child.exitCode, null);
    assert.doesNotThrow(() => process.kill(child.pid, 0));
    child.stdin.end("exit\n");
    assert.deepEqual(await closed, [0, null]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
    await observer.close();
  }
});
