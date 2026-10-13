import { desktopText } from "./desktop-copy.js";

const FAILURE_REASONS = Object.freeze([
  "locked",
  "denied",
  "migration_required",
  "timeout",
  "credential_invalid",
  "adapter_integrity_failed",
  "security_unavailable",
]);

const FAILURE_REASON_SET = new Set(FAILURE_REASONS);
const MAX_OPERATION_TIMEOUT_MS = 15_000;

const ERROR_CODE_REASONS = new Map([
  ["broker_timeout", "timeout"],
  ["adapter_integrity_failed", "adapter_integrity_failed"],
  ["broker_unavailable", "security_unavailable"],
  ["contribution_device_credential_recovery_required", "migration_required"],
]);

const SUPPORT_CODES = Object.freeze({
  locked: "SECURE_STORAGE_LOCKED",
  denied: "SECURE_STORAGE_DENIED",
  migration_required: "SECURE_STORAGE_MIGRATION_REQUIRED",
  timeout: "SECURE_STORAGE_TIMEOUT",
  credential_invalid: "SECURE_STORAGE_CREDENTIAL_INVALID",
  adapter_integrity_failed: "SECURE_STORAGE_ADAPTER_INTEGRITY_FAILED",
  security_unavailable: "SECURE_STORAGE_UNAVAILABLE",
});

export const DESKTOP_SECURE_STORAGE_FAILURE_REASONS = FAILURE_REASONS;

export function normalizeDesktopSecureStorageFailureReason(value) {
  return FAILURE_REASON_SET.has(value) ? value : "security_unavailable";
}

export function isDesktopSecureStorageFailure(error) {
  try {
    return FAILURE_REASON_SET.has(error?.secureStorageReason)
      || ERROR_CODE_REASONS.has(error?.code);
  } catch {
    return false;
  }
}

export function classifyDesktopSecureStorageFailure(error) {
  try {
    if (FAILURE_REASON_SET.has(error?.secureStorageReason)) {
      return error.secureStorageReason;
    }
    return ERROR_CODE_REASONS.get(error?.code) ?? "security_unavailable";
  } catch {
    return "security_unavailable";
  }
}

export function createDesktopSecureStorageFailure(reason) {
  const selected = normalizeDesktopSecureStorageFailureReason(reason);
  return Object.assign(new Error("Desktop secure storage is unavailable"), {
    code: "desktop_secure_storage_unavailable",
    secureStorageReason: selected,
  });
}

export async function awaitDesktopSecureStorageOperation(operation, {
  timeoutMs = MAX_OPERATION_TIMEOUT_MS,
  disposeLateResult = () => {},
} = {}) {
  if (typeof operation !== "function"
      || typeof disposeLateResult !== "function"
      || !Number.isInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_OPERATION_TIMEOUT_MS) {
    throw createDesktopSecureStorageFailure("adapter_integrity_failed");
  }
  let timer;
  let timedOut = false;
  const pending = Promise.resolve().then(operation);
  void pending.then((value) => {
    if (timedOut) disposeLateResult(value);
  }, () => {});
  try {
    return await Promise.race([
      pending,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => {
            timedOut = true;
            reject(createDesktopSecureStorageFailure("timeout"));
          },
          timeoutMs,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function createDesktopSecureStorageDialog(reason, textOptions = {}) {
  const selected = normalizeDesktopSecureStorageFailureReason(reason);
  const text = (key, values = {}) => desktopText(key, values, textOptions);
  return Object.freeze({
    type: "warning",
    title: text("electron.secureStorage.title"),
    message: text(`electron.secureStorage.${selected}.message`),
    detail: `${text(`electron.secureStorage.${selected}.detail`)} ${text("electron.secureStorage.preserved")} ${text("electron.recovery.supportCode", { code: SUPPORT_CODES[selected] })}`,
    // Quit is the safe Return/Escape default. Retry happens only after an
    // explicit click and never schedules an automatic prompt or retry loop.
    buttons: Object.freeze([text("electron.recovery.quit"), text("electron.recovery.retry")]),
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
}
