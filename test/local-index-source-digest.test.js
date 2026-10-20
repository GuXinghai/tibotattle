import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, openSync, writeSync, closeSync } from "node:fs";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  SEGMENT_BYTES,
  WINDOW_BYTES,
  classifyFromStat,
  createSegmentTap,
  digestRange,
  digestWindows,
  verifySegments,
  windowsMatch,
} from "../src/local-index-source-digest.js";

function withDirectory(work) {
  const directory = mkdtempSync(join(tmpdir(), "local-index-digest-"));
  return Promise.resolve(work(directory)).finally(() => {
    rmSync(directory, { recursive: true, force: true });
  });
}

async function readThroughTap(tap, size, chunkSizes) {
  const buffer = Buffer.allocUnsafe(Math.max(...chunkSizes));
  let position = tap.startOffset;
  let index = 0;
  while (position < size) {
    const length = Math.min(chunkSizes[index % chunkSizes.length], size - position);
    index += 1;
    const { bytesRead } = await tap.handle.read(buffer, 0, length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
  }
}

test("segment tap digests equal direct digests for aligned and unaligned starts", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "rollout.jsonl");
    const size = SEGMENT_BYTES * 3 + 12_345;
    writeFileSync(file, randomBytes(size));
    const handle = await open(file, "r");
    try {
      for (const startOffset of [0, SEGMENT_BYTES, Math.floor(SEGMENT_BYTES * 0.37), SEGMENT_BYTES + 5, SEGMENT_BYTES * 2 + 1]) {
        const tap = await createSegmentTap(handle, { startOffset });
        const probe = { handle: tap.handle, startOffset };
        await readThroughTap(probe, size, [1024 * 1024, 65_537, 300_001]);
        const segments = tap.finish(size);
        const expectedFrom = Math.floor(startOffset / SEGMENT_BYTES);
        const complete = Math.floor(size / SEGMENT_BYTES);
        assert.deepEqual([...segments.keys()], Array.from(
          { length: complete - expectedFrom }, (_, index) => expectedFrom + index,
        ));
        for (const [index, digest] of segments) {
          const direct = await digestRange(handle, index * SEGMENT_BYTES, SEGMENT_BYTES);
          assert.equal(Buffer.compare(digest, direct), 0, `segment ${index} from ${startOffset}`);
        }
      }
    } finally {
      await handle.close();
    }
  });
});

test("segment tap records only segments below the scanned bytes and refuses gaps", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "rollout.jsonl");
    writeFileSync(file, randomBytes(SEGMENT_BYTES * 2));
    const handle = await open(file, "r");
    try {
      const tap = await createSegmentTap(handle, { startOffset: 0 });
      await readThroughTap({ handle: tap.handle, startOffset: 0 }, SEGMENT_BYTES * 2, [1024 * 1024]);
      assert.deepEqual([...tap.finish(SEGMENT_BYTES * 2 - 100).keys()], [0]);
      assert.equal(tap.finish(SEGMENT_BYTES * 2).size, 2);

      const gapped = await createSegmentTap(handle, { startOffset: 0 });
      const scratch = Buffer.allocUnsafe(1024);
      await gapped.handle.read(scratch, 0, 1024, 0);
      await gapped.handle.read(scratch, 0, 1024, 4096);
      assert.equal(gapped.finish(SEGMENT_BYTES * 2), null);
    } finally {
      await handle.close();
    }
  });
});

test("window digests detect head, boundary and open-tail edits but not closed-segment edits", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "rollout.jsonl");
    const size = SEGMENT_BYTES * 3 + WINDOW_BYTES * 8;
    writeFileSync(file, randomBytes(size));
    const reader = await open(file, "r");
    try {
      const { head, boundary, tail } = await digestWindows(reader, size);
      const row = {
        scanned_bytes: size, head_digest: head, boundary_digest: boundary, tail_digest: tail,
      };
      assert.equal(await windowsMatch(reader, row), true);

      for (const [position, expected] of [
        [10, false],
        [size - 10, false],
        [SEGMENT_BYTES * 3 + WINDOW_BYTES, false],
        [SEGMENT_BYTES + 777, true],
      ]) {
        const writer = openSync(file, "r+");
        const original = Buffer.alloc(1);
        const probe = await open(file, "r");
        await probe.read(original, 0, 1, position);
        await probe.close();
        writeSync(writer, Buffer.from([original[0] ^ 0xff]), 0, 1, position);
        assert.equal(await windowsMatch(reader, row), expected, `edit at ${position}`);
        writeSync(writer, original, 0, 1, position);
        closeSync(writer);
      }
    } finally {
      await reader.close();
    }
  });
});

test("segment verification finds an interior edit that stat and windows miss", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "rollout.jsonl");
    const size = SEGMENT_BYTES * 2 + 999;
    writeFileSync(file, randomBytes(size));
    const reader = await open(file, "r");
    try {
      const segments = new Map();
      for (let index = 0; index < 2; index += 1) {
        segments.set(index, await digestRange(reader, index * SEGMENT_BYTES, SEGMENT_BYTES));
      }
      assert.equal(await verifySegments(reader, segments, size), -1);
      const writer = openSync(file, "r+");
      writeSync(writer, Buffer.from([1, 2, 3]), 0, 3, SEGMENT_BYTES + 100_000);
      closeSync(writer);
      assert.equal(await verifySegments(reader, segments, size), 1);
      segments.delete(0);
      assert.equal(await verifySegments(reader, segments, size), 0, "a missing digest is a mismatch");
    } finally {
      await reader.close();
    }
  });
});

test("stat classification follows the consistency table", () => {
  const parser = "p1";
  const row = {
    parser_version: parser,
    file_id: "1:2", birthtime_ms: 1_000.9,
    size_bytes: 500, scanned_bytes: 500, mtime_ms: 5_000.25, ctime_ms: 5_000.5,
    quarantine_code: null,
  };
  const info = {
    fileId: "1:2", birthtimeMs: 1_000.1, size: 500, mtimeMs: 5_000.25, ctimeMs: 5_000.5,
  };
  const classify = (changes, rowChanges = {}) => classifyFromStat(
    { ...info, ...changes }, { ...row, ...rowChanges }, parser,
  );
  assert.deepEqual(classifyFromStat(info, undefined, parser), { mode: "new" });
  assert.equal(classify({}).mode, "skip");
  assert.equal(classify({ size: 800 }).mode, "append");
  assert.deepEqual(classify({ size: 100 }), { mode: "rescan", reason: "shrink" });
  assert.deepEqual(classify({ mtimeMs: 6_000 }), { mode: "rescan", reason: "same_size_changed" });
  assert.deepEqual(classify({ ctimeMs: 6_000 }), { mode: "rescan", reason: "same_size_changed" });
  assert.deepEqual(classify({ fileId: "1:9" }), { mode: "rescan", reason: "identity_changed" });
  assert.deepEqual(classify({ fileId: null }), { mode: "rescan", reason: "identity_changed" });
  assert.deepEqual(classify({}, { file_id: null }), { mode: "rescan", reason: "identity_changed" });
  // Two NTFS ids that round to the same double are still different files.
  const adjacent = { file_id: "7:9007199254740993" };
  assert.equal(Number("9007199254740993"), Number("9007199254740992"));
  assert.deepEqual(
    classify({ fileId: "7:9007199254740992" }, adjacent),
    { mode: "rescan", reason: "identity_changed" },
  );
  assert.equal(classify({ fileId: "7:9007199254740993" }, adjacent).mode, "skip");
  assert.deepEqual(classify({ birthtimeMs: 2_500 }), { mode: "rescan", reason: "identity_changed" });
  assert.deepEqual(classify({}, { parser_version: "p0" }), { mode: "rescan", reason: "parser_version" });
  assert.deepEqual(classify({}, { scanned_bytes: 400 }), { mode: "rescan", reason: "cursor_invalid" });
  const deferred = { scanned_bytes: 400, deferred_tail_bytes: 100 };
  assert.equal(classify({}, deferred).mode, "skip");
  assert.equal(classify({ size: 800 }, deferred).mode, "append");
  assert.deepEqual(classify({}, { ...deferred, deferred_tail_bytes: 99 }), { mode: "rescan", reason: "cursor_invalid" });
  assert.deepEqual(classify({ size: 300 }, deferred), { mode: "rescan", reason: "shrink" });
  assert.deepEqual(classify({ size: 800, compressed: true }), { mode: "rescan", reason: "compressed_changed" });
  const quarantined = { quarantine_code: "codex_rollout_content_invalid", scanned_bytes: 0 };
  assert.equal(classify({}, quarantined).mode, "quarantined");
  assert.deepEqual(classify({ size: 800 }, quarantined), { mode: "rescan", reason: "quarantine_changed" });
});

test("random append, truncate and edit sequences are classified or verified", async () => {
  await withDirectory(async (directory) => {
    const file = join(directory, "rollout.jsonl");
    let seed = 0x9e3779b9;
    const next = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      value ^= value + Math.imul(value ^ (value >>> 7), 61 | value);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
    writeFileSync(file, randomBytes(SEGMENT_BYTES * 3 + WINDOW_BYTES * 3));
    const snapshot = async () => {
      const reader = await open(file, "r");
      try {
        const stat = await reader.stat();
        const scanned = stat.size;
        const windows = await digestWindows(reader, scanned);
        const segments = new Map();
        for (let index = 0; index < Math.floor(scanned / SEGMENT_BYTES); index += 1) {
          segments.set(index, await digestRange(reader, index * SEGMENT_BYTES, SEGMENT_BYTES));
        }
        return { scanned, windows, segments };
      } finally {
        await reader.close();
      }
    };
    for (let round = 0; round < 40; round += 1) {
      const before = await snapshot();
      const operation = Math.floor(next() * 4);
      let expectDetected = true;
      if (operation === 0) {
        appendFileSync(file, randomBytes(1 + Math.floor(next() * 5000)));
        expectDetected = false;
      } else if (operation === 1) {
        const writer = openSync(file, "r+");
        const position = Math.floor(next() * before.scanned);
        const original = Buffer.alloc(1);
        const probe = await open(file, "r");
        await probe.read(original, 0, 1, position);
        await probe.close();
        writeSync(writer, Buffer.from([original[0] ^ 0x5a]), 0, 1, position);
        closeSync(writer);
      } else if (operation === 2) {
        const cut = before.scanned - 1 - Math.floor(next() * 2000);
        writeFileSync(file, Buffer.from(await (async () => {
          const reader = await open(file, "r");
          const buffer = Buffer.allocUnsafe(cut);
          await reader.read(buffer, 0, cut, 0);
          await reader.close();
          return buffer;
        })()));
      } else {
        appendFileSync(file, randomBytes(100));
        const probe = await open(file, "r");
        const original = Buffer.alloc(1);
        await probe.read(original, 0, 1, 3);
        await probe.close();
        const writer = openSync(file, "r+");
        writeSync(writer, Buffer.from([original[0] ^ 0xff]), 0, 1, 3);
        closeSync(writer);
      }
      const reader = await open(file, "r");
      try {
        const stat = await reader.stat();
        const row = {
          scanned_bytes: before.scanned,
          head_digest: before.windows.head,
          boundary_digest: before.windows.boundary,
          tail_digest: before.windows.tail,
        };
        const detected = stat.size < before.scanned
          || !(await windowsMatch(reader, row))
          || (await verifySegments(reader, before.segments, Math.min(before.scanned, stat.size))) !== -1;
        assert.equal(detected, expectDetected, `round ${round} operation ${operation}`);
      } finally {
        await reader.close();
      }
    }
  });
});
