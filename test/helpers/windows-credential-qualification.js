import { lstat, realpath } from "node:fs/promises";
import { win32 } from "node:path";

const QUALIFICATION_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_QUALIFICATION";
const QUALIFICATION_STATE_ROOT_ENVIRONMENT = "USAGE_MONITOR_WINDOWS_QUALIFICATION_STATE_ROOT";
const EXPECTED_STATE_DIRECTORY = "usagemonitor-windows-private-state";
const EXPECTED_CODEX_DIRECTORY = "usagemonitor-codex-home";

function failIf(condition, code) {
  if (condition) throw new Error(code);
}

function comparableWindowsPath(path) {
  return win32.normalize(path).replace(/[\\]+$/u, "").toLowerCase();
}

export function windowsCredentialQualificationSkipReason({
  platform = process.platform,
  architecture = process.arch,
  environment = process.env,
} = {}) {
  if (platform !== "win32" || architecture !== "x64") {
    return "native Windows x64 Credential Manager qualification only";
  }
  if (environment?.[QUALIFICATION_ENVIRONMENT] !== "1") {
    return "explicit Windows security qualification required";
  }
  return false;
}

/** Assert the dedicated hosted runner state root before any native binding load. */
export async function assertWindowsCredentialQualificationIsolation({
  environment = process.env,
} = {}) {
  failIf(environment?.GITHUB_ACTIONS !== "true", "CREDENTIAL_QUALIFICATION_REQUIRES_HOSTED_RUNNER");
  failIf(environment?.[QUALIFICATION_ENVIRONMENT] !== "1", "CREDENTIAL_QUALIFICATION_MARKER_MISSING");

  const runnerTemporary = environment?.RUNNER_TEMP;
  const stateRoot = environment?.[QUALIFICATION_STATE_ROOT_ENVIRONMENT];
  const codexHome = environment?.CODEX_HOME;
  failIf(typeof runnerTemporary !== "string" || !win32.isAbsolute(runnerTemporary), "CREDENTIAL_QUALIFICATION_TEMP_ROOT_INVALID");
  failIf(typeof stateRoot !== "string" || !win32.isAbsolute(stateRoot), "CREDENTIAL_QUALIFICATION_STATE_ROOT_INVALID");
  failIf(typeof codexHome !== "string" || !win32.isAbsolute(codexHome), "CREDENTIAL_QUALIFICATION_CODEX_HOME_INVALID");

  const expectedStateRoot = win32.resolve(runnerTemporary, EXPECTED_STATE_DIRECTORY);
  const expectedCodexHome = win32.resolve(runnerTemporary, EXPECTED_CODEX_DIRECTORY);
  failIf(comparableWindowsPath(stateRoot) !== comparableWindowsPath(expectedStateRoot), "CREDENTIAL_QUALIFICATION_STATE_ROOT_NOT_ISOLATED");
  failIf(comparableWindowsPath(codexHome) !== comparableWindowsPath(expectedCodexHome), "CREDENTIAL_QUALIFICATION_CODEX_HOME_NOT_ISOLATED");
  for (const profilePath of [
    environment.USERPROFILE,
    environment.HOME,
    environment.APPDATA,
    environment.LOCALAPPDATA,
  ]) {
    if (typeof profilePath === "string" && win32.isAbsolute(profilePath)) {
      failIf(
        comparableWindowsPath(stateRoot) === comparableWindowsPath(profilePath),
        "CREDENTIAL_QUALIFICATION_STATE_ROOT_EQUALS_PROFILE_PATH",
      );
    }
  }

  let runnerMetadata;
  let runnerRealPath;
  try {
    runnerMetadata = await lstat(runnerTemporary);
    runnerRealPath = await realpath(runnerTemporary);
  } catch {
    throw new Error("CREDENTIAL_QUALIFICATION_RUNNER_TEMP_UNAVAILABLE");
  }
  failIf(!runnerMetadata.isDirectory() || runnerMetadata.isSymbolicLink(), "CREDENTIAL_QUALIFICATION_RUNNER_TEMP_UNSAFE");

  const expectedRealStateRoot = win32.resolve(runnerRealPath, EXPECTED_STATE_DIRECTORY);
  const expectedRealCodexHome = win32.resolve(runnerRealPath, EXPECTED_CODEX_DIRECTORY);
  let stateMetadata = null;
  try {
    stateMetadata = await lstat(stateRoot);
  } catch (error) {
    if (error?.code !== "ENOENT") throw new Error("CREDENTIAL_QUALIFICATION_STATE_ROOT_UNREADABLE");
  }
  if (stateMetadata !== null) {
    failIf(!stateMetadata.isDirectory() || stateMetadata.isSymbolicLink(), "CREDENTIAL_QUALIFICATION_STATE_ROOT_UNSAFE");
    let stateRealPath;
    try {
      stateRealPath = await realpath(stateRoot);
    } catch {
      throw new Error("CREDENTIAL_QUALIFICATION_STATE_ROOT_UNREADABLE");
    }
    failIf(comparableWindowsPath(stateRealPath) !== comparableWindowsPath(expectedRealStateRoot), "CREDENTIAL_QUALIFICATION_STATE_ROOT_REPARSE_POINT");
  }

  let codexMetadata;
  let codexRealPath;
  try {
    codexMetadata = await lstat(codexHome);
    codexRealPath = await realpath(codexHome);
  } catch {
    throw new Error("CREDENTIAL_QUALIFICATION_CODEX_HOME_UNREADABLE");
  }
  failIf(!codexMetadata.isDirectory() || codexMetadata.isSymbolicLink(), "CREDENTIAL_QUALIFICATION_CODEX_HOME_UNSAFE");
  failIf(comparableWindowsPath(codexRealPath) !== comparableWindowsPath(expectedRealCodexHome), "CREDENTIAL_QUALIFICATION_CODEX_HOME_REPARSE_POINT");
}
