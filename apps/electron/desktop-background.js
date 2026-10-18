import { createHash, randomUUID } from "node:crypto";
import { open, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError } from "../../src/platform/index.js";

export const BACKGROUND_SCHEMA = "tibotattle-window-background-v2";
const LEGACY_SCHEMA = "tibotattle-window-background-v1";
export const BACKGROUND_CHUNK_BYTES = 1024 * 1024;
const CONFIG = "window-background-v1.json";
const JOURNAL = "window-background-import-v1.json";
const PICKER_CONFIG = "window-background-picker-v1.json";
const PICKER_SCHEMA = "tibotattle-window-background-picker-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DEFAULT = Object.freeze({ schemaVersion: BACKGROUND_SCHEMA, color: null, mask: 35, image: null });
const digest = bytes => createHash("sha256").update(bytes).digest("hex");
const exact = (value, keys) => value !== null && typeof value === "object"
  && Object.getPrototypeOf(value) === Object.prototype
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
function invalid() { throw new TypeError("Window background is invalid"); }
function validatePickerDirectory(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) invalid();
  return value;
}
function validateImage(value) {
  if (!exact(value, ["id", "bytes", "sha256", "mime"])
      || !UUID.test(value.id) || !Number.isSafeInteger(value.bytes)
      || value.bytes < 1
      || !/^[a-f0-9]{64}$/u.test(value.sha256)
      || !["image/png", "image/jpeg", "image/webp"].includes(value.mime)) invalid();
  return Object.freeze({ ...value });
}
export function validateWindowBackground(value) {
  if (!exact(value, ["schemaVersion", "color", "mask", "image"])
      || value.schemaVersion !== BACKGROUND_SCHEMA
      || !(value.color === null || /^#[0-9A-F]{6}$/u.test(value.color))
      || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 90) invalid();
  return Object.freeze({ ...value, image: value.image === null ? null : validateImage(value.image) });
}
export function validateWindowBackgroundPatch(value) {
  if (!exact(value, ["color", "mask", "removeImage"])
      || !(value.color === null || /^#[0-9A-F]{6}$/u.test(value.color))
      || !Number.isInteger(value.mask) || value.mask < 0 || value.mask > 90
      || typeof value.removeImage !== "boolean") invalid();
  return Object.freeze({ ...value });
}

/** Parse dimensions before native decoding; only static raster formats. */
export function inspectBackgroundImage(bytes) {
  if (!Buffer.isBuffer(bytes) || !bytes.length) invalid();
  let width, height, mime;
  if (bytes.length >= 33 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) {
    mime = "image/png";
    if (bytes.toString("ascii",12,16) !== "IHDR" || bytes.readUInt32BE(8) !== 13) invalid();
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    for (let p = 8; p < bytes.length;) {
      if (p + 12 > bytes.length) invalid();
      const size = bytes.readUInt32BE(p), kind = bytes.toString("ascii", p + 4, p + 8);
      if (kind === "acTL" || p + size + 12 > bytes.length) invalid();
      p += size + 12;
    }
  } else if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216) {
    mime = "image/jpeg";
    for (let p = 2; p + 3 < bytes.length;) {
      if (bytes[p++] !== 255) invalid();
      while (bytes[p] === 255) p++;
      const marker = bytes[p++];
      if (marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (p + 2 > bytes.length) invalid();
      const size = bytes.readUInt16BE(p);
      if (size < 2 || p + size > bytes.length) invalid();
      if ([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        if (size < 8) invalid();
        height = bytes.readUInt16BE(p + 3); width = bytes.readUInt16BE(p + 5); break;
      }
      p += size;
    }
  } else if (bytes.length >= 30 && bytes.toString("ascii",0,4) === "RIFF" && bytes.toString("ascii",8,12) === "WEBP") {
    mime = "image/webp";
    if (bytes.readUInt32LE(4) + 8 !== bytes.length) invalid();
    for (let p = 12; p + 8 <= bytes.length;) {
      const kind = bytes.toString("ascii", p, p + 4), size = bytes.readUInt32LE(p + 4), d = p + 8;
      if (d + size > bytes.length || kind === "ANIM" || kind === "ANMF") invalid();
      if (kind === "VP8X") {
        if (size < 10 || bytes[d] & 2) invalid();
        width = bytes.readUIntLE(d + 4, 3) + 1; height = bytes.readUIntLE(d + 7, 3) + 1;
      } else if (kind === "VP8 " && width === undefined) {
        if (size < 10 || !bytes.subarray(d + 3, d + 6).equals(Buffer.from([157,1,42]))) invalid();
        width = bytes.readUInt16LE(d + 6) & 0x3fff; height = bytes.readUInt16LE(d + 8) & 0x3fff;
      } else if (kind === "VP8L" && width === undefined) {
        if (size < 5 || bytes[d] !== 47) invalid();
        const bits = bytes.readUInt32LE(d + 1);
        width = (bits & 0x3fff) + 1; height = ((bits >>> 14) & 0x3fff) + 1;
      }
      p = d + size + (size % 2);
    }
  }
  if (!mime || !Number.isInteger(width) || !Number.isInteger(height)
      || width < 1 || height < 1 || !Number.isSafeInteger(width * height)) invalid();
  return Object.freeze({ mime, width, height });
}

/** Keep the selected handle bound until import. Decode and imported bytes must
 * have the same digest even if another process edits the selected file. */
export async function readSelectedBackground(path) {
  const handle = await open(path, "r");
  let closed = false, expectedDigest = null;
  const close = async () => { if (!closed) { closed = true; await handle.close(); } };
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || !Number.isSafeInteger(stat.size) || stat.size < 1) invalid();
    async function* chunks() {
      for (let offset = 0; offset < stat.size;) {
        const bytes = Buffer.alloc(Math.min(BACKGROUND_CHUNK_BYTES, stat.size - offset));
        let read = 0;
        while (read < bytes.length) {
          const part = await handle.read(bytes, read, bytes.length - read, offset + read);
          if (!part.bytesRead) invalid();
          read += part.bytesRead;
        }
        offset += bytes.length;
        yield bytes;
      }
      const end = Buffer.alloc(1);
      if ((await handle.read(end, 0, 1, stat.size)).bytesRead) invalid();
    }
    let info = null;
    return Object.freeze({
      bytes: stat.size,
      async validateDecode(decode) {
        try {
          // Native decoders require a contiguous input. This allocation exists
          // only in main during validation, never in IPC or protected storage.
          const bytes = Buffer.alloc(stat.size);
          let offset = 0;
          for await (const chunk of chunks()) { bytes.set(chunk, offset); offset += chunk.length; }
          info = inspectBackgroundImage(bytes);
          await decode(bytes);
          expectedDigest = digest(bytes);
        } catch (error) { await close(); throw error; }
      },
      get info() { if (!info || !expectedDigest) invalid(); return info; },
      get sha256() { if (!expectedDigest) invalid(); return expectedDigest; },
      chunks,
      close,
    });
  } catch (error) { await close(); throw error; }
}

/** Main-process preference only: never expose the source directory to IPC. */
export function createBackgroundImagePicker({ repository, dialog, nativeImage }) {
  return async () => {
    let defaultPath;
    try {
      const saved = await repository.loadPickerDirectory();
      if (saved !== null && (await stat(saved)).isDirectory()) defaultPath = saved;
    } catch { /* An unavailable preference or directory falls back to the OS. */ }
    const selection = await dialog.showOpenDialog({
      ...(defaultPath === undefined ? {} : { defaultPath }),
      properties: ["openFile"],
      filters: [{ name: "PNG / JPEG / WebP", extensions: ["png", "jpg", "jpeg", "webp"] }],
    });
    if (selection.canceled || selection.filePaths?.length !== 1) return null;
    const path = validatePickerDirectory(selection.filePaths[0]);
    // Remember a confirmed selection even if the image cannot be imported.
    // Preference failures must not prevent importing an otherwise valid image.
    await repository.savePickerDirectory(dirname(path)).catch(() => {});
    const source = await readSelectedBackground(path);
    await source.validateDecode(bytes => {
      if (nativeImage.createFromBuffer(bytes).isEmpty()) throw new Error("Background image cannot be decoded");
    });
    return source;
  };
}

/** Injectable storage port; production only composes it with the branded store below. */
export function createBackgroundRepository({ storage, idFactory = randomUUID }) {
  const leases = new Map();
  const pendingCleanup = new Map();
  const chunkName = (image, index) => `background-${image.id}-${index}.bin`;
  const count = image => Math.ceil(image.bytes / BACKGROUND_CHUNK_BYTES);
  async function loadPickerDirectory() {
    const saved = await storage.readJson(PICKER_CONFIG);
    if (saved === null) return null;
    if (!exact(saved, ["schemaVersion", "directory"]) || saved.schemaVersion !== PICKER_SCHEMA) invalid();
    return validatePickerDirectory(saved.directory);
  }
  async function savePickerDirectory(directory) {
    validatePickerDirectory(directory);
    // Do not overwrite malformed or newer preference contracts.
    await loadPickerDirectory();
    await storage.writeJson(PICKER_CONFIG, { schemaVersion: PICKER_SCHEMA, directory });
  }
  async function load() {
    const saved = await storage.readJson(CONFIG);
    if (saved?.schemaVersion === LEGACY_SCHEMA) {
      const journal = await storage.readJson(JOURNAL);
      if (journal !== null && ![BACKGROUND_SCHEMA, LEGACY_SCHEMA].includes(journal.schemaVersion)) invalid();
      const migrated = validateWindowBackground({ ...saved, schemaVersion: BACKGROUND_SCHEMA });
      // Write the successor into the existing pointer so an older reader fails
      // closed rather than continuing to mutate a stale legacy selection.
      await storage.writeJson(CONFIG, migrated);
      return migrated;
    }
    return validateWindowBackground(saved ?? DEFAULT);
  }
  async function recover(current) {
    const journal = await storage.readJson(JOURNAL);
    if (journal === null) return;
    if (!exact(journal, ["schemaVersion", "images"]) || ![BACKGROUND_SCHEMA, LEGACY_SCHEMA].includes(journal.schemaVersion)
        || !Array.isArray(journal.images)) invalid();
    const retained = [];
    for (const raw of journal.images) {
      const image = validateImage(raw);
      if (image.id === current.image?.id) continue;
      if (leases.has(image.id)) { retained.push(image); pendingCleanup.set(image.id, image); continue; }
      for (let i = 0; i < count(image); i++) await storage.remove(chunkName(image, i));
      pendingCleanup.delete(image.id);
    }
    await storage.writeJson(JOURNAL, { schemaVersion: BACKGROUND_SCHEMA, images: retained });
  }
  async function readChunk(image, index) {
    const bytes = await storage.read(chunkName(image, index));
    if (!(bytes instanceof Uint8Array) || bytes.length !== Math.min(BACKGROUND_CHUNK_BYTES, image.bytes - index * BACKGROUND_CHUNK_BYTES)) invalid();
    return bytes;
  }
  async function verifyImage(image) {
    validateImage(image);
    const hash = createHash("sha256");
    for (let i = 0; i < count(image); i++) {
      hash.update(await readChunk(image, i));
    }
    if (hash.digest("hex") !== image.sha256) invalid();
  }
  async function openImage(image) {
    validateImage(image);
    leases.set(image.id, (leases.get(image.id) ?? 0) + 1);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      const remaining = leases.get(image.id) - 1;
      if (remaining) leases.set(image.id, remaining); else leases.delete(image.id);
    };
    try { await verifyImage(image); } catch (error) { release(); throw error; }
    let index = 0;
    return {
      stream: new ReadableStream({
        async pull(controller) {
          try {
            if (index === count(image)) { release(); controller.close(); return; }
            controller.enqueue(await readChunk(image, index++));
          } catch (error) { release(); controller.error(error); }
        },
        cancel: release,
      }, { highWaterMark: 0 }),
      release,
    };
  }
  async function commit(next, bytes = null) {
    const current = await load();
    await recover(current);
    let selected = next;
    if (bytes !== null) {
      const info = Buffer.isBuffer(bytes) ? inspectBackgroundImage(bytes) : bytes.info;
      selected = { ...next, image: { id: idFactory(), bytes: Buffer.isBuffer(bytes) ? bytes.length : bytes.bytes, sha256: Buffer.isBuffer(bytes) ? digest(bytes) : bytes.sha256, mime: info.mime } };
    }
    selected = validateWindowBackground(selected);
    const images = [...new Map([...pendingCleanup.values(), current.image, bytes === null ? null : selected.image].filter(Boolean).map(image => [image.id, image])).values()];
    await storage.writeJson(JOURNAL, { schemaVersion: BACKGROUND_SCHEMA, images });
    try {
      if (bytes !== null) {
        const hash = createHash("sha256");
        if (Buffer.isBuffer(bytes)) {
          for (let i = 0; i < count(selected.image); i++) {
            const chunk = bytes.subarray(i * BACKGROUND_CHUNK_BYTES, (i + 1) * BACKGROUND_CHUNK_BYTES);
            hash.update(chunk); await storage.create(chunkName(selected.image, i), chunk);
          }
        } else {
          let index = 0, total = 0;
          for await (const chunk of bytes.chunks()) {
            if (!Buffer.isBuffer(chunk) || chunk.length !== Math.min(BACKGROUND_CHUNK_BYTES, selected.image.bytes - total)) invalid();
            total += chunk.length; hash.update(chunk);
            await storage.create(chunkName(selected.image, index++), chunk);
          }
          if (total !== selected.image.bytes) invalid();
        }
        if (hash.digest("hex") !== selected.image.sha256) invalid();
      }
      await storage.writeJson(CONFIG, selected);
    } catch (error) {
      // Read the durable pointer again: a storage error may occur after commit.
      await recover(await load());
      throw error;
    } finally {
      if (bytes !== null && !Buffer.isBuffer(bytes)) await bytes.close();
    }
    // Cleanup may be retried on the next read; a successful durable selection
    // must not be reported as a failed save because old resource cleanup failed.
    await recover(selected).catch(() => {});
    return selected;
  }
  return Object.freeze({ load, recover, verifyImage, openImage, commit, loadPickerDirectory, savePickerDirectory });
}

export function createWindowsBackgroundRepository(store) {
  if (!isWindowsProtectedStateStore(store) || store.maxBytes < BACKGROUND_CHUNK_BYTES) invalid();
  const missing = error => isWindowsProtectedStateStoreError(error) && error.code === "windows_protected_state_store_missing";
  async function record(name) { try { return await store.read(name); } catch (error) { if (missing(error)) return null; throw error; } }
  return createBackgroundRepository({ storage: {
    async readJson(name) {
      const result = await record(name);
      if (result === null) return null;
      if (result.data.length > 4096) invalid();
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.data));
    },
    async writeJson(name, value) {
      if (Buffer.byteLength(JSON.stringify(value)) > 4096) invalid();
      const existing = await record(name);
      if (existing) await store.replaceJson(name, existing.identity, value);
      else await store.createJson(name, value);
    },
    async create(name, bytes) { await store.create(name, bytes); },
    async read(name) { const result = await record(name); if (!result) invalid(); return result.data; },
    async remove(name) { const result = await record(name); if (result) await store.delete(name, result.identity); },
  } });
}

export function createDesktopBackgroundController({ repository, chooseImage, notify = () => {} }) {
  let tail = Promise.resolve();
  const enqueue = operation => { const result = tail.then(operation); tail = result.catch(() => {}); return result; };
  const response = async (state, status = "ready") => ({ status, background: { color: state.color, mask: state.mask, imageUrl: state.image ? `tibotattle-background://image/${state.image.id}` : null } });
  const available = () => { if (!repository) throw new Error("Background storage unavailable"); };
  const changed = async state => { notify(); return response(state); };
  return Object.freeze({
    handlers: {
      getWindowBackground: () => enqueue(async () => { available(); const state = await repository.load(); await repository.recover(state); return response(state); }),
      setWindowBackground: ({ value }) => enqueue(async () => {
        available(); const patch = validateWindowBackgroundPatch(value), state = await repository.load();
        return changed(await repository.commit({ ...state, color: patch.color, mask: patch.mask, image: patch.removeImage ? null : state.image }));
      }),
      chooseWindowBackground: () => enqueue(async () => {
        available(); const bytes = await chooseImage();
        try {
          const state = await repository.load();
          if (bytes === null) return response(state, "cancelled");
          return changed(await repository.commit(state, bytes));
        } finally { if (bytes !== null && !Buffer.isBuffer(bytes)) await bytes.close(); }
      }),
      restoreWindowBackground: () => enqueue(async () => { available(); return changed(await repository.commit(DEFAULT)); }),
    },
    handleResource: request => enqueue(async () => {
      const notFound = () => new Response(null, { status: 404 });
      if (!["GET", "HEAD"].includes(request.method)) return new Response(null, { status: 405, headers: { Allow: "GET, HEAD" } });
      const match = /^tibotattle-background:\/\/image\/([0-9a-f-]+)$/u.exec(request.url);
      if (!match || !UUID.test(match[1]) || !repository) return notFound();
      const state = await repository.load();
      if (!state.image || state.image.id !== match[1]) return notFound();
      try {
        const headers = { "Content-Type": state.image.mime, "Content-Length": String(state.image.bytes), "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'" };
        if (request.method === "HEAD") { await repository.verifyImage(state.image); return new Response(null, { headers }); }
        const opened = await repository.openImage(state.image);
        return new Response(opened.stream, { headers });
      } catch { return notFound(); }
    }),
    drain: () => tail,
  });
}
