const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const UINT64_MAX = 0xffff_ffff_ffff_ffffn;
const UINT128_MAX = 0xffff_ffff_ffff_ffff_ffff_ffff_ffff_ffffn;

export function validSha256(value) {
  return typeof value === "string" && SHA256_PATTERN.test(value);
}

export function safeCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

export function validFilesystemId(value, legacy = false) {
  return legacy ? safeCount(value) : typeof value === "string"
    && /^(0|[1-9][0-9]{0,19})$/.test(value) && BigInt(value) <= 18446744073709551615n;
}
export function sameFilesystemId(actual, expected) {
  return validFilesystemId(actual, typeof actual === "number")
    && validFilesystemId(expected, typeof expected === "number")
    && String(actual) === String(expected);
}

export function normalizeCodexSourcePlanFilesystemId(value, field) {
  const maximum = field === "device" ? UINT64_MAX : field === "inode" ? UINT128_MAX : null;
  if (maximum === null) return null;
  let exact;
  if (Number.isSafeInteger(value) && value >= 0) exact = BigInt(value);
  else if (typeof value === "string" && /^(0|[1-9][0-9]{0,38})$/u.test(value)) exact = BigInt(value);
  else return null;
  return exact <= maximum ? exact.toString(10) : null;
}
