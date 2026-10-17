import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";

// Test-only observer: pin the exact synthetic process before ending its parent.
// On Windows kill(pid, 0) can report ESRCH while ExitProcess is still releasing
// SQLite handles. Only the kernel process signal proves that teardown finished.
const SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class SyntheticProcessExit {
 [DllImport("kernel32.dll", SetLastError=true)]
 public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
 [DllImport("kernel32.dll")]
 public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
 [DllImport("kernel32.dll")]
 public static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
 [DllImport("kernel32.dll")]
 public static extern bool CloseHandle(IntPtr handle);
}
'@
[Console]::WriteLine('READY')
$pidValue = [int][Console]::ReadLine()
$held = [SyntheticProcessExit]::OpenProcess(0x101000, $false, $pidValue)
if ($held -eq [IntPtr]::Zero) { exit 2 }
try {
 [Console]::WriteLine('WATCHING')
 if ([SyntheticProcessExit]::WaitForSingleObject($held, 5000) -ne 0) { exit 3 }
 [uint32]$code = 0
 if (-not [SyntheticProcessExit]::GetExitCodeProcess($held, [ref]$code)) { exit 4 }
 [Console]::WriteLine('EXIT=' + $code)
} finally { [void][SyntheticProcessExit]::CloseHandle($held) }
`;

export async function createWindowsProcessExitObserver() {
  assert.equal(process.platform, "win32");
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SCRIPT], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const closed = once(child, "close");
  // Prevent a spawn error from becoming an unhandled rejection during setup.
  void closed.catch(() => {});
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  async function nextLine() {
    let timer;
    try {
      return await Promise.race([
        lines.next().then(line => line.value),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("synthetic_process_observer_timeout")), 10_000);
        }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async function close() {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    await closed;
  }
  try {
    assert.equal(await nextLine(), "READY", "Windows process observer starts");
    let exitLine;
    return {
      async watch(pid) {
        assert.ok(Number.isSafeInteger(pid) && pid > 0);
        child.stdin.end(`${pid}\n`);
        assert.equal(await nextLine(), "WATCHING", "exact process handle is held before parent exit");
        exitLine = nextLine();
        void exitLine.catch(() => {});
      },
      async waitForExit({ expectedCode = 0 } = {}) {
        assert.ok(exitLine, "process was observed before exit");
        const result = await exitLine;
        assert.match(result ?? "", /^EXIT=\d+$/u, "kernel confirms process termination within five seconds");
        assert.deepEqual(await closed, [0, null]);
        if (expectedCode !== null) assert.equal(result, `EXIT=${expectedCode}`, "orphan exit code");
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
