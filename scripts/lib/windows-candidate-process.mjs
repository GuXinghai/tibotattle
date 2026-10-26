/**
 * Fixed Windows candidate process probes and bounded child execution.
 * This library has no entrypoint, installation, or registry mutation behavior.
 */
import { spawn } from "node:child_process";
import { basename, isAbsolute, join } from "node:path";

const PREFIX = "ELECTRON_WINDOWS_CANDIDATE_PROCESS_";
const APP_EXECUTABLE = "usage-monitor.exe";
const PROGRAM_TERMINATION_GRACE_MS = 10_000;
const PROGRAM_OUTPUT_LIMIT_BYTES = 64 * 1024;
const WINDOWS_PROCESS_ID_MAX = 0xffff_ffff;
const PROCESS_SNAPSHOT_MAX_TARGETS = 4096;
const WINDOWS_POWER_SHELL_UTILITY_MODULE = "Microsoft.PowerShell.Utility";
// Only a fixed read-only probe may inject this value into its child.
const EXPECTED_PATH_ENVIRONMENT_KEY =
  "USAGE_MONITOR_WINDOWS_CANDIDATE_EXPECTED_PATH_V1";

const PROGRAM_ENVIRONMENT_KEYS = Object.freeze([
  "SystemRoot",
  "WINDIR",
  "COMSPEC",
  "PATH",
  "PATHEXT",
  "OS",
  "PROCESSOR_ARCHITECTURE",
  "PROCESSOR_ARCHITEW6432",
  "NUMBER_OF_PROCESSORS",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "ProgramData",
  "ProgramFiles",
  "ProgramW6432",
  "CommonProgramFiles",
  "CommonProgramW6432",
]);

function fail(code) {
  const fixed = `${PREFIX}${code}`;
  throw Object.assign(new Error(fixed), { code: fixed });
}

function validAbsolutePath(value) {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 4096
    && !value.includes("\0")
    && isAbsolute(value);
}

function validWindowsProcessId(value) {
  return Number.isSafeInteger(value) && value > 0 && value <= WINDOWS_PROCESS_ID_MAX;
}

export function parseWindowsProcessSnapshot(text) {
  if (typeof text !== "string" || text.length === 0 || text.length > PROGRAM_OUTPUT_LIMIT_BYTES) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const entries = Array.isArray(parsed) ? parsed : [parsed];
  const seen = new Set();
  const result = [];
  for (const entry of entries) {
    const pid = entry?.ProcessId;
    const parentPid = entry?.ParentProcessId;
    const creation = entry?.CreationDate;
    if (!Number.isSafeInteger(pid) || pid <= 0
        || !Number.isSafeInteger(parentPid) || parentPid < 0
        || typeof creation !== "string" || creation.length === 0 || creation.length > 256
        || creation.includes("\0")) {
      fail("PROCESS_PROOF_UNAVAILABLE");
    }
    const key = `${pid}:${creation}`;
    if (seen.has(key)) fail("PROCESS_PROOF_UNAVAILABLE");
    seen.add(key);
    result.push(Object.freeze({ pid, parentPid, creation }));
  }
  return Object.freeze(result);
}

export function ownedWindowsProcessTree(snapshot, rootPid) {
  if (!Number.isSafeInteger(rootPid) || rootPid <= 0 || !Array.isArray(snapshot)) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const byParent = new Map();
  let root = null;
  for (const entry of snapshot) {
    if (entry?.pid === rootPid) root = entry;
    const children = byParent.get(entry?.parentPid) ?? [];
    children.push(entry);
    byParent.set(entry?.parentPid, children);
  }
  if (root === null) fail("PROCESS_PROOF_UNAVAILABLE");
  const result = [];
  const pending = [root];
  const seen = new Set();
  while (pending.length > 0) {
    const current = pending.shift();
    const key = `${current.pid}:${current.creation}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(Object.freeze({ pid: current.pid, creation: current.creation }));
    for (const child of byParent.get(current.pid) ?? []) pending.push(child);
  }
  return Object.freeze(result);
}

export function assertWindowsProcessTreeExited(tracked, snapshot) {
  if (!Array.isArray(tracked) || !Array.isArray(snapshot)) fail("PROCESS_PROOF_UNAVAILABLE");
  for (const prior of tracked) {
    if (snapshot.some((current) => current?.pid === prior?.pid
        && current?.creation === prior?.creation)) {
      fail("OWNED_PROCESS_REMAINS");
    }
  }
  return true;
}

function selectedProgramEnvironment(
  environment,
  fixedProbePath = null,
  fixedPowerShellUtilityModules = false,
) {
  const selected = {};
  for (const key of PROGRAM_ENVIRONMENT_KEYS) {
    const value = environment?.[key];
    if (typeof value === "string" && value.length > 0 && !value.includes("\0")) {
      selected[key] = value;
    }
  }
  // Do not forward an ambient value with this name. Only the fixed read-only
  // probe call below can add its prevalidated path to a child environment.
  if (fixedProbePath !== null) {
    if (!validAbsolutePath(fixedProbePath)) fail("PROGRAM_INVALID");
    selected[EXPECTED_PATH_ENVIRONMENT_KEY] = fixedProbePath;
  }
  // Process-proof queries use only the Windows PowerShell system module
  // directory. Do not forward a user, runner, or ambient module search path.
  if (fixedPowerShellUtilityModules) {
    selected.PSModulePath = systemPowerShellUtilityModuleDirectory(environment);
  }
  return selected;
}

export async function runWindowsCandidateProgram(command, args, {
  timeoutMs,
  captureOutput = false,
  environment = process.env,
  fixedProbePath = null,
  fixedPowerShellUtilityModules = false,
} = {}, {
  spawnProcess = spawn,
  terminationGraceMs = PROGRAM_TERMINATION_GRACE_MS,
} = {}) {
  if (!validAbsolutePath(command) || !Array.isArray(args)
      || args.some((value) => typeof value !== "string" || value.includes("\0"))
      || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0
      || (fixedProbePath !== null && !validAbsolutePath(fixedProbePath))
      || typeof fixedPowerShellUtilityModules !== "boolean"
      || (fixedPowerShellUtilityModules && (!captureOutput
        || command !== systemPowerShellExecutable(environment)))
      || typeof spawnProcess !== "function"
      || !Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
    fail("PROGRAM_INVALID");
  }
  return new Promise((resolveProgram) => {
    let child;
    try {
      child = spawnProcess(command, args, {
        shell: false,
        windowsHide: true,
        env: selectedProgramEnvironment(
          environment,
          fixedProbePath,
          fixedPowerShellUtilityModules,
        ),
        stdio: captureOutput ? ["ignore", "pipe", "ignore"] : "ignore",
      });
    } catch {
      resolveProgram(Object.freeze({ exitCode: null, timedOut: false, settled: true, stdout: "" }));
      return;
    }
    let stdout = "";
    let overflow = false;
    if (captureOutput) {
      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        if (overflow) return;
        stdout += chunk;
        if (stdout.length > PROGRAM_OUTPUT_LIMIT_BYTES) {
          overflow = true;
          stdout = "";
        }
      });
    }
    let delivered = false;
    let timedOut = false;
    let deadlineTimer = null;
    let terminationTimer = null;
    const finish = (exitCode, settled) => {
      if (delivered) return;
      delivered = true;
      clearTimeout(deadlineTimer);
      clearTimeout(terminationTimer);
      // Once the deadline fired, a later child close cannot establish that
      // its descendants exited. Keep the operation unsettled so callers
      // cannot race resource cleanup against an unproven process tree.
      const operationSettled = settled && !timedOut;
      if (!operationSettled) {
        // The child may still own resources. Detach only so the evidence
        // runner can return a failed result; its caller must refuse cleanup
        // while the operation remains unsettled.
        child.stdout?.destroy();
        child.unref?.();
      }
      resolveProgram(Object.freeze({
        exitCode: Number.isInteger(exitCode) ? exitCode : null,
        timedOut,
        settled: operationSettled,
        stdout: captureOutput && !overflow ? stdout : "",
      }));
    };
    deadlineTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* bounded grace resolves the fixed result. */ }
      if (!delivered) {
        terminationTimer = setTimeout(() => finish(null, false), terminationGraceMs);
      }
    }, timeoutMs);
    child.once("error", () => finish(null, true));
    child.once("close", (code) => finish(code, true));
  });
}

function systemExecutable(environment, relativePath) {
  const root = environment?.SystemRoot;
  if (!validAbsolutePath(root) || root.includes("\0")) fail("SYSTEM_ROOT_INVALID");
  return join(root, ...relativePath);
}

function systemPowerShellExecutable(environment) {
  return systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  ]);
}

function systemPowerShellUtilityModuleDirectory(environment) {
  return systemExecutable(environment, [
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "Modules",
  ]);
}

function fixedPowerShellExpectedPathPrelude() {
  return `function ConvertTo-CanonicalCandidatePath([string]$path){$full=[System.IO.Path]::GetFullPath($path);$root=[System.IO.Path]::GetPathRoot($full);if([string]::IsNullOrWhiteSpace($root) -or -not [System.IO.Path]::IsPathRooted($full)){throw 'expected-path'};if($full.Length -gt $root.Length){return $full.TrimEnd([System.IO.Path]::DirectorySeparatorChar,[System.IO.Path]::AltDirectorySeparatorChar)};return $full};$expectedPathRaw=[Environment]::GetEnvironmentVariable('${EXPECTED_PATH_ENVIRONMENT_KEY}','Process');if($expectedPathRaw -isnot [string] -or [string]::IsNullOrWhiteSpace($expectedPathRaw) -or -not [System.IO.Path]::IsPathRooted($expectedPathRaw)){throw 'expected-path'};$expected=ConvertTo-CanonicalCandidatePath($expectedPathRaw);`;
}

function fixedPowerShellUtilityModulePrelude() {
  return `Import-Module -Name ${WINDOWS_POWER_SHELL_UTILITY_MODULE} -ErrorAction Stop;`;
}

const WINDOWS_TOOLHELP_PROCESS_SNAPSHOT_SOURCE = String.raw`using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;

public static class UsageMonitorWindowsProcessSnapshot
{
    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000;
    private const int ERROR_NO_MORE_FILES = 18;
    private const int ERROR_INVALID_PARAMETER = 87;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new IntPtr(-1);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct FILETIME
    {
        public uint dwLowDateTime;
        public uint dwHighDateTime;
    }

    private sealed class SnapshotEntry
    {
        public uint ProcessId;
        public uint ParentProcessId;
    }

    public sealed class Evidence
    {
        public uint ProcessId { get; private set; }
        public uint ParentProcessId { get; private set; }
        public string CreationDate { get; private set; }

        public Evidence(uint processId, uint parentProcessId, ulong creationDate)
        {
            ProcessId = processId;
            ParentProcessId = parentProcessId;
            CreationDate = creationDate.ToString(CultureInfo.InvariantCulture);
        }
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32First(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool Process32Next(IntPtr hSnapshot, ref PROCESSENTRY32 lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool GetProcessTimes(IntPtr hProcess, out FILETIME lpCreationTime,
        out FILETIME lpExitTime, out FILETIME lpKernelTime, out FILETIME lpUserTime);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    private static Dictionary<uint, SnapshotEntry> CaptureProcessTable()
    {
        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == INVALID_HANDLE_VALUE)
        {
            throw new InvalidOperationException();
        }
        try
        {
            var entries = new Dictionary<uint, SnapshotEntry>();
            var current = new PROCESSENTRY32();
            current.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
            if (!Process32First(snapshot, ref current))
            {
                throw new InvalidOperationException();
            }
            while (true)
            {
                if (entries.ContainsKey(current.th32ProcessID) || entries.Count >= 65536)
                {
                    throw new InvalidOperationException();
                }
                entries.Add(current.th32ProcessID, new SnapshotEntry {
                    ProcessId = current.th32ProcessID,
                    ParentProcessId = current.th32ParentProcessID,
                });
                current.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (Process32Next(snapshot, ref current))
                {
                    continue;
                }
                if (Marshal.GetLastWin32Error() != ERROR_NO_MORE_FILES)
                {
                    throw new InvalidOperationException();
                }
                return entries;
            }
        }
        finally
        {
            if (!CloseHandle(snapshot))
            {
                throw new InvalidOperationException();
            }
        }
    }

    private static bool TryReadEvidence(SnapshotEntry entry, out Evidence evidence, out bool absent)
    {
        evidence = null;
        absent = false;
        IntPtr process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessId);
        if (process == IntPtr.Zero || process == INVALID_HANDLE_VALUE)
        {
            if (Marshal.GetLastWin32Error() == ERROR_INVALID_PARAMETER)
            {
                absent = true;
            }
            return false;
        }
        try
        {
            FILETIME creation;
            FILETIME exit;
            FILETIME kernel;
            FILETIME user;
            if (!GetProcessTimes(process, out creation, out exit, out kernel, out user))
            {
                return false;
            }
            ulong creationDate = ((ulong)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
            if (creationDate == 0)
            {
                return false;
            }
            evidence = new Evidence(entry.ProcessId, entry.ParentProcessId, creationDate);
            return true;
        }
        finally
        {
            if (!CloseHandle(process))
            {
                throw new InvalidOperationException();
            }
        }
    }

    public static Evidence[] Read(uint rootProcessId, uint[] retainedProcessIds)
    {
        bool rootMode = rootProcessId != 0;
        if ((rootMode && retainedProcessIds != null && retainedProcessIds.Length != 0)
            || (!rootMode && (retainedProcessIds == null || retainedProcessIds.Length == 0)))
        {
            throw new InvalidOperationException();
        }
        var entries = CaptureProcessTable();
        var selected = new HashSet<uint>();
        if (rootMode)
        {
            if (!entries.ContainsKey(rootProcessId))
            {
                throw new InvalidOperationException();
            }
            var children = new Dictionary<uint, List<uint>>();
            foreach (SnapshotEntry entry in entries.Values)
            {
                List<uint> childIds;
                if (!children.TryGetValue(entry.ParentProcessId, out childIds))
                {
                    childIds = new List<uint>();
                    children.Add(entry.ParentProcessId, childIds);
                }
                childIds.Add(entry.ProcessId);
            }
            var pending = new Queue<uint>();
            pending.Enqueue(rootProcessId);
            while (pending.Count != 0)
            {
                uint processId = pending.Dequeue();
                if (!selected.Add(processId))
                {
                    continue;
                }
                List<uint> childIds;
                if (children.TryGetValue(processId, out childIds))
                {
                    foreach (uint childId in childIds)
                    {
                        pending.Enqueue(childId);
                    }
                }
            }
        }
        else
        {
            var seen = new HashSet<uint>();
            foreach (uint processId in retainedProcessIds)
            {
                if (processId == 0 || !seen.Add(processId))
                {
                    throw new InvalidOperationException();
                }
                if (entries.ContainsKey(processId))
                {
                    selected.Add(processId);
                }
            }
        }

        var results = new List<Evidence>();
        bool rootObserved = false;
        foreach (uint processId in selected)
        {
            Evidence evidence;
            bool absent;
            if (!TryReadEvidence(entries[processId], out evidence, out absent))
            {
                if (absent && (!rootMode || processId != rootProcessId))
                {
                    continue;
                }
                throw new InvalidOperationException();
            }
            if (processId == rootProcessId)
            {
                rootObserved = true;
            }
            results.Add(evidence);
        }
        if (rootMode && !rootObserved)
        {
            throw new InvalidOperationException();
        }
        results.Sort(delegate(Evidence left, Evidence right) {
            return left.ProcessId.CompareTo(right.ProcessId);
        });
        return results.ToArray();
    }
}`;

function validTrackedWindowsProcessIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > PROCESS_SNAPSHOT_MAX_TARGETS) {
    return false;
  }
  const seen = new Set();
  for (const processId of value) {
    if (!validWindowsProcessId(processId) || seen.has(processId)) return false;
    seen.add(processId);
  }
  return true;
}

function toolhelpPowerShellTypeDefinition() {
  return `$source=@'
${WINDOWS_TOOLHELP_PROCESS_SNAPSHOT_SOURCE}
'@
Add-Type -TypeDefinition $source -ErrorAction Stop;
`;
}

/**
 * A fixed Toolhelp/Win32 query for either a ready app's live descendant tree
 * or the retained PIDs to recheck after it exits. It emits only PID, parent
 * PID, and exact creation metadata; each selected live process must permit
 * `GetProcessTimes`, otherwise the proof fails closed.
 */
export function buildWindowsOwnedProcessSnapshotQueryArguments({ rootProcessId = null, retainedProcessIds = null } = {}) {
  const rootMode = rootProcessId !== null;
  if ((rootMode && (!validWindowsProcessId(rootProcessId) || retainedProcessIds !== null))
      || (!rootMode && !validTrackedWindowsProcessIds(retainedProcessIds))) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const root = rootMode ? rootProcessId : 0;
  const retained = rootMode ? "@()" : `@(${retainedProcessIds.join(",")})`;
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellUtilityModulePrelude()}${toolhelpPowerShellTypeDefinition()}$rows=[UsageMonitorWindowsProcessSnapshot]::Read([uint32]${root},[uint32[]]${retained});[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 2))`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}

/**
 * Ask the .NET process API only whether the exact candidate Electron
 * executable remains. The app path is a fixed, validated child-only
 * environment value, never interpolated into the command or copied from the
 * parent environment. Output deliberately keeps paths out of receipts and
 * logs.
 */
export function buildWindowsExactExecutableProcessQueryArguments(appPath, {
  executableName = APP_EXECUTABLE,
} = {}) {
  if (!validAbsolutePath(appPath)
      || executableName !== APP_EXECUTABLE
      || basename(appPath) !== executableName) {
    fail("PROCESS_PROOF_UNAVAILABLE");
  }
  const imageName = executableName.slice(0, -".exe".length);
  // The image name is fixed. Every matching process must disclose both its
  // module path and start time: an access failure therefore rejects the proof
  // rather than silently treating an uninspectable process as absent. For an
  // exact match, Toolhelp supplies its real parent PID and independently
  // rechecks the same creation identity. The expected path remains a validated
  // child-only value, so this query never interpolates a caller-controlled path.
  const query = `$ErrorActionPreference='Stop';${fixedPowerShellExpectedPathPrelude()}${fixedPowerShellUtilityModulePrelude()}$matches=@();foreach($process in [System.Diagnostics.Process]::GetProcessesByName('${imageName}')){try{$processPath=$process.MainModule.FileName;$creationDate=$process.StartTime.ToFileTimeUtc().ToString([System.Globalization.CultureInfo]::InvariantCulture);if($processPath -isnot [string] -or [string]::IsNullOrWhiteSpace($processPath) -or [string]::IsNullOrWhiteSpace($creationDate)){throw 'process-proof'};if([string]::Equals($processPath,$expected,[System.StringComparison]::OrdinalIgnoreCase)){$matches+=[pscustomobject]@{ProcessId=[uint32]$process.Id;CreationDate=$creationDate}}}finally{$process.Dispose()}};if($matches.Count -eq 0){$rows=@()}else{${toolhelpPowerShellTypeDefinition()}$processIds=[uint32[]]@($matches|ForEach-Object {[uint32]$_.ProcessId});$proof=@([UsageMonitorWindowsProcessSnapshot]::Read([uint32]0,$processIds));$rows=@();foreach($match in $matches){$evidence=@($proof|Where-Object {$_.ProcessId -eq $match.ProcessId -and [string]::Equals($_.CreationDate,$match.CreationDate,[System.StringComparison]::Ordinal)});if($evidence.Count -gt 1){throw 'process-proof'};if($evidence.Count -eq 1){$rows+=$evidence[0]}}};[Console]::Out.Write((ConvertTo-Json -InputObject @($rows) -Compress -Depth 2))`;
  return Object.freeze([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    query,
  ]);
}
