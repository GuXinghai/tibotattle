import { lstat, open, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { capturePreservationBaseline, verifyPreservationBaseline } from "./lib/local-index-preservation.mjs";

const fail = code => { throw Object.assign(new Error(code), { code }); };

export function parsePreservationArguments(args) {
  const [mode, ...rest] = args;
  if (!["capture", "verify"].includes(mode) || rest.length !== 4) fail("preservation_arguments_invalid");
  const flags = {};
  for (let i = 0; i < rest.length; i += 2) {
    if (!["--index", "--baseline"].includes(rest[i]) || flags[rest[i]] || !rest[i + 1]
        || rest[i + 1].startsWith("--")) fail("preservation_arguments_invalid");
    flags[rest[i]] = resolve(rest[i + 1]);
  }
  if (!flags["--index"] || !flags["--baseline"] || ["", "-wal", "-shm", "-journal"].some(suffix =>
    (flags["--index"] + suffix).toLowerCase() === flags["--baseline"].toLowerCase())) {
    fail("preservation_arguments_invalid");
  }
  return { mode, index: flags["--index"], baseline: flags["--baseline"] };
}

async function regularFile(path, max = Infinity) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > max) fail("preservation_file_invalid");
}

export async function runPreservation({ mode, index, baseline }) {
  await regularFile(index);
  if (mode === "verify") await regularFile(baseline, 16 * 1024 * 1024);
  const input = mode === "verify" ? JSON.parse(await readFile(baseline, "utf8")) : null;
  const db = new DatabaseSync(index, { readOnly: true, timeout: 1000 });
  let output;
  try {
    db.exec("PRAGMA query_only=ON; BEGIN");
    if (mode === "capture") {
      const value = capturePreservationBaseline(db);
      const check = verifyPreservationBaseline(db, value);
      if (!check.allOriginalFactsUnchanged) fail("preservation_capture_integrity_failed");
      output = value;
    } else output = verifyPreservationBaseline(db, input);
  } finally { db.close(); }
  if (mode === "capture") {
    // No overwrite, including existing files, symlinks and the original index.
    const bytes = JSON.stringify(output);
    if (Buffer.byteLength(bytes) > 16 * 1024 * 1024) fail("preservation_baseline_too_large");
    const file = await open(baseline, "wx", 0o600);
    try { await file.writeFile(bytes); await file.sync(); }
    finally { await file.close(); }
    return { captured: true, sourceCount: output.sources.length,
      counts: Object.fromEntries(Object.entries(output.tables).map(([key, value]) => [key, value.count])) };
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const output = await runPreservation(parsePreservationArguments(process.argv.slice(2)));
    console.log(JSON.stringify(output));
    if (output.allOriginalFactsUnchanged === false) process.exitCode = 1;
  } catch (error) {
    // Do not print database errors, rows, arguments or paths.
    const code = /^preservation_[a-z_]+$/.test(error.code ?? "") ? error.code
      : error.code === "EEXIST" ? "preservation_baseline_exists"
        : error instanceof SyntaxError ? "preservation_baseline_invalid" : "preservation_read_or_write_failed";
    console.error(JSON.stringify({ errors: [{ code }] }));
    process.exitCode = 1;
  }
}
