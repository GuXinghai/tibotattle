// Only fixed categories cross the child-process boundary. Exception messages,
// paths, arbitrary stderr and native diagnostics are never forwarded.
export const COMPANION_STARTUP_ERROR_CODES = Object.freeze([
  "companion_state_security_policy",
  "companion_instance_lock_failed",
  "companion_database_unavailable",
  "companion_dependency_missing",
  "companion_configuration_invalid",
  "companion_startup_failed",
]);
const PREFIX = "TIBOTATTLE_COMPANION_FAILURE ";
export function companionStartupErrorCode(error) {
  const code = typeof error?.code === "string" ? error.code : "";
  if (/^(?:WINDOWS_FILESYSTEM_|windows_protected_state_store_)/u.test(code)) return COMPANION_STARTUP_ERROR_CODES[0];
  if (error?.name === "CompanionInstanceLockError") return COMPANION_STARTUP_ERROR_CODES[1];
  if (code.startsWith("ERR_SQLITE") || code.startsWith("local_index_")) return COMPANION_STARTUP_ERROR_CODES[2];
  if (["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"].includes(code)) return COMPANION_STARTUP_ERROR_CODES[3];
  if (error instanceof TypeError || code === "companion_parent_watchdog_invalid") return COMPANION_STARTUP_ERROR_CODES[4];
  return COMPANION_STARTUP_ERROR_CODES[5];
}
export function companionStartupErrorLine(error) {
  return `${PREFIX}${companionStartupErrorCode(error)}\n`;
}
export function createCompanionStartupErrorParser(onCode) {
  let line = "", overflow = false;
  return (chunk) => {
    for (const char of String(chunk)) {
      if (char === "\n") {
        if (!overflow && line.startsWith(PREFIX)) {
          const code = line.slice(PREFIX.length).replace(/\r$/u, "");
          if (COMPANION_STARTUP_ERROR_CODES.includes(code)) onCode(code);
        }
        line = ""; overflow = false;
      } else if (!overflow) {
        if (line.length >= 160) { line = ""; overflow = true; }
        else line += char;
      }
    }
  };
}
