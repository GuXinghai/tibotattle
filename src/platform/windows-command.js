import { spawn } from "node:child_process";
import { win32 } from "node:path";
const OWNED_CHILDREN = new WeakSet();

// Prior status commands are owner-configured shell programs, not argv assembled
// from provider input. Pin the system shell and bypass Command Processor AutoRun.
export function spawnWindowsCommand(command, options = {}, spawnCommand = spawn) {
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || typeof systemRoot !== "string"
    || !win32.isAbsolute(systemRoot) || /[\0\r\n"]/.test(systemRoot)
    || typeof command !== "string" || command.includes("\0")) {
    throw new Error("windows_command_unavailable");
  }
  const child = spawnCommand(win32.join(systemRoot, "System32", "cmd.exe"),
    ["/d", "/v:off", "/s", "/c", `"${command}"`], {
      ...options,
      windowsHide: true,
      windowsVerbatimArguments: true,
    });
  OWNED_CHILDREN.add(child);
  return child;
}

export async function terminateWindowsCommand(child) {
  if (!OWNED_CHILDREN.has(child) || child.exitCode !== null || child.signalCode !== null
    || !Number.isSafeInteger(child.pid) || child.pid <= 0) return false;
  const systemRoot = process.env.SystemRoot;
  if (process.platform !== "win32" || typeof systemRoot !== "string"
    || !win32.isAbsolute(systemRoot) || /[\0\r\n"]/.test(systemRoot)) return false;
  return new Promise((resolve) => {
    let killer;
    let timer;
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!ok) {
        try { child.kill("SIGKILL"); } catch { /* Bounded termination failure. */ }
      }
      resolve(ok);
    };
    try {
      killer = spawn(win32.join(systemRoot, "System32", "taskkill.exe"),
        ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("error", () => finish(false));
      killer.once("close", code => finish(code === 0));
      timer = setTimeout(() => {
        try { killer.kill("SIGKILL"); } catch { /* Bounded termination failure. */ }
        finish(false);
      }, 1000);
    } catch { finish(false); }
  });
}
