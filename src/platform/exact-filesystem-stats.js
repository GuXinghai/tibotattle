// Exact identifiers are never converted through JavaScript Number.
export function exactFilesystemStats(stats) {
  const result = {};
  for (const method of ["isFile", "isDirectory", "isSymbolicLink", "isBlockDevice", "isCharacterDevice", "isFIFO", "isSocket"]) result[method] = stats[method].bind(stats);
  for (const key of Object.keys(stats)) {
    if (key.endsWith("Ns")) continue;
    const value = stats[key];
    if (key === "dev" || key === "ino") {
      if (typeof value !== "bigint" || value < 0n || value > 18446744073709551615n) throw new Error("filesystem_identity_unavailable");
      result[key] = value.toString(10);
    }
    else if (key.endsWith("Ms") && typeof stats[key.replace(/Ms$/, "Ns")] === "bigint") {
      const nanoseconds = stats[key.replace(/Ms$/, "Ns")];
      // Match Node Stats: integer seconds plus the subsecond fraction. Avoid
      // rounding a large nanosecond integer before dividing into milliseconds.
      result[key] = Number(nanoseconds / 1000000000n) * 1000
        + Number(nanoseconds % 1000000000n) / 1e6;
      if (!Number.isFinite(result[key])) throw new Error("filesystem_metadata_unavailable");
    } else if (typeof value === "bigint") {
      const number = Number(value);
      if (!Number.isSafeInteger(number)) throw new Error("filesystem_metadata_unavailable");
      result[key] = number;
    } else result[key] = value;
  }
  return result;
}
export async function exactLstat(path, lstat) {
  return exactFilesystemStats(await lstat(path, { bigint: true }));
}
export async function exactOpen(path, flags, open, mode) {
  const handle = await open(path, flags, mode);
  return new Proxy(handle, { get(target, key) {
    if (key === "stat") return async () => exactFilesystemStats(await target.stat({ bigint: true }));
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}
