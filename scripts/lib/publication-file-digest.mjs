import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { operationError } from "./release-operation.mjs";

const MAX_BYTES = 10 * 1024 ** 3;
const fail = (code) => { throw operationError(code); };

/** Stream-hash one regular publication input without following links. */
export async function hashPublicationFile(path, maximum = MAX_BYTES) {
  const selected = resolve(path);
  if (await realpath(dirname(selected)) !== dirname(selected)) fail("RELEASE_PUBLICATION_FILE_UNSAFE");
  const before = await lstat(selected);
  if (!before.isFile() || before.nlink !== 1 || before.size < 1 || before.size > maximum) fail("RELEASE_PUBLICATION_FILE_UNSAFE");
  const handle = await open(selected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.nlink !== 1) fail("RELEASE_PUBLICATION_FILE_CHANGED");
    const hash = createHash("sha256");
    let bytes = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) { hash.update(chunk); bytes += chunk.length; }
    const after = await handle.stat();
    if (after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs || after.size !== bytes || bytes !== before.size) fail("RELEASE_PUBLICATION_FILE_CHANGED");
    return { sha256: hash.digest("hex"), bytes };
  } finally { await handle.close(); }
}
