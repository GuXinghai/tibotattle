import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createBackgroundRepository, createBackgroundImagePicker, createDesktopBackgroundController, inspectBackgroundImage, validateWindowBackgroundPatch, createWindowsBackgroundRepository, readSelectedBackground } from "../desktop-background.js";
import { createDesktopRequest } from "../desktop-contract.js";
import { createDesktopCommand } from "../desktop-command.js";

function png(extra = 0) {
  const chunk = (name, bytes) => {
    const type = Buffer.from(name), data = Buffer.concat([type, bytes]); let crc = 0xffffffff;
    for (const b of data) { crc ^= b; for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1)); }
    const length = Buffer.alloc(4), end = Buffer.alloc(4); length.writeUInt32BE(bytes.length); end.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, data, end]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", header), chunk("tEXt", Buffer.concat([Buffer.from("fixture\0"), Buffer.alloc(extra, 65)])), chunk("IDAT", deflateSync(Buffer.from([0,32,64,128,255]))), chunk("IEND", Buffer.alloc(0))]);
}
function fixture() {
  const records = new Map(), chunks = new Map(); let failure = null, failCreate = false;
  const storage = {
    async readJson(name) { return structuredClone(records.get(name) ?? null); },
    async writeJson(name, value) {
      if (name === "window-background-v1.json" && failure) { const f = failure; failure = null; if (f === "after") records.set(name, structuredClone(value)); throw Error("synthetic failure"); }
      records.set(name, structuredClone(value));
    },
    async read(name) { if (!chunks.has(name)) throw Error("missing"); return Buffer.from(chunks.get(name)); },
    async create(name, bytes) { if (failCreate) { failCreate = false; throw Error("synthetic create failure"); } assert.ok(bytes.length <= 1024 * 1024); assert.ok(!chunks.has(name)); chunks.set(name, Buffer.from(bytes)); },
    async remove(name) { chunks.delete(name); },
  };
  const repository = createBackgroundRepository({ storage });
  return { records, chunks, storage, repository, failure(value) { failure = value; }, failCreate() { failCreate = true; } };
}

async function pickerFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "usagemonitor-picker-"));
  t.after(async () => {
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith("usagemonitor-picker-"));
    await rm(directory, { recursive: true, force: true });
  });
  const path = join(directory, "background.png");
  await writeFile(path, png());
  const f = fixture(), calls = [];
  let selection = { canceled: false, filePaths: [path] };
  const options = {
    dialog: { async showOpenDialog(value) { calls.push(value); return selection; } },
    nativeImage: { createFromBuffer: () => ({ isEmpty: () => false }) },
  };
  return { ...f, directory, path, calls, options, select(value) { selection = value; } };
}

test("image picker remembers the selected folder across repository restart and cancellation", async t => {
  const f = await pickerFixture(t);
  const source = await createBackgroundImagePicker({ ...f.options, repository: f.repository })();
  await source.close();
  assert.ok(!Object.hasOwn(f.calls[0], "defaultPath"));
  const restarted = createBackgroundRepository({ storage: f.storage });
  assert.equal(await restarted.loadPickerDirectory(), f.directory);
  f.select({ canceled: true, filePaths: [] });
  assert.equal(await createBackgroundImagePicker({ ...f.options, repository: restarted })(), null);
  assert.equal(f.calls[1].defaultPath, f.directory);
  assert.deepEqual(f.calls[1].filters[0].extensions, ["png", "jpg", "jpeg", "webp"]);
  assert.equal(await restarted.loadPickerDirectory(), f.directory);
  // The private path must never appear in the renderer's background response.
  const controller = createDesktopBackgroundController({ repository: restarted });
  assert.ok(!JSON.stringify(await controller.handlers.getWindowBackground()).includes(f.directory));
});

test("unavailable folders fall back and newer picker records are never overwritten", async t => {
  const f = await pickerFixture(t);
  await f.repository.savePickerDirectory(join(f.directory, "removed-folder"));
  const source = await createBackgroundImagePicker({ ...f.options, repository: f.repository })();
  await source.close();
  assert.ok(!Object.hasOwn(f.calls[0], "defaultPath"));
  assert.equal(await f.repository.loadPickerDirectory(), f.directory);
  const future = { schemaVersion: "usagemonitor-window-background-picker-v99", directory: f.directory };
  f.records.set("window-background-picker-v1.json", future);
  const next = await createBackgroundImagePicker({ ...f.options, repository: f.repository })();
  await next.close();
  assert.ok(!Object.hasOwn(f.calls[1], "defaultPath"));
  assert.deepEqual(f.records.get("window-background-picker-v1.json"), future);
  await assert.rejects(f.repository.savePickerDirectory("relative-folder"));
  await assert.rejects(f.repository.savePickerDirectory(`${f.directory}\0invalid`));
});

test("preference write failure does not block image import and invalid images retain the background", async t => {
  const f = await pickerFixture(t);
  const repository = createBackgroundRepository({ storage: { ...f.storage,
    async writeJson(name, value) {
      if (name === "window-background-picker-v1.json") throw Error("synthetic preference failure");
      return f.storage.writeJson(name, value);
    },
  } });
  const controller = createDesktopBackgroundController({ repository,
    chooseImage: createBackgroundImagePicker({ ...f.options, repository }) });
  const initial = await controller.handlers.chooseWindowBackground();
  assert.equal(initial.status, "ready");
  await writeFile(f.path, Buffer.from("not an image"));
  await assert.rejects(controller.handlers.chooseWindowBackground());
  assert.deepEqual(await controller.handlers.getWindowBackground(), initial);
});
test("original images larger than 1 MB survive independent protected chunks and restart byte for byte", async () => {
  const f = fixture(), bytes = png(2 * 1024 * 1024), initial = await f.repository.load();
  const state = await f.repository.commit(initial, bytes);
  assert.equal(f.chunks.size, 3);
  assert.equal(state.image.bytes, bytes.length);
  assert.equal(state.image.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.ok(JSON.stringify(f.records.get("window-background-v1.json")).length < 1024);
  const next = createBackgroundRepository({ storage: {
    async readJson(name) { return f.records.get(name) ?? null; },
    async read(name) { return f.chunks.get(name); },
    async remove() { throw Error("must retain selected image"); },
    async writeJson() {},
  } });
  const opened = await next.openImage((await next.load()).image);
  assert.deepEqual(Buffer.from(await new Response(opened.stream).arrayBuffer()), bytes);
});
test("partial import, failed config save and successful replacement recover only unreferenced owned resources", async () => {
  const f = fixture(); const first = await f.repository.commit(await f.repository.load(), png());
  f.chunks.set("unrelated.bin", Buffer.from("keep"));
  f.failCreate(); await assert.rejects(f.repository.commit(first, png(1)));
  assert.deepEqual(await f.repository.load(), first);
  f.failure("before"); await assert.rejects(f.repository.commit(first, png(2)));
  assert.equal(f.chunks.size, 2);
  const second = await f.repository.commit(first, png(3));
  assert.notEqual(second.image.id, first.image.id);
  assert.equal(f.chunks.size, 2);
  f.failure("after"); await assert.rejects(f.repository.commit(second, png(4)));
  const durable = await f.repository.load(); assert.notEqual(durable.image.id, second.image.id);
  assert.ok(await f.repository.verifyImage(durable.image).then(() => true));
  await f.repository.commit({ ...durable, image: null, color: null });
  assert.deepEqual([...f.chunks.keys()], ["unrelated.bin"]);
});
test("interruption journal resumes cleanup without deleting the currently selected image", async () => {
  const f = fixture(); const state = await f.repository.commit(await f.repository.load(), png());
  const abandoned = { ...state.image, id: "12345678-1234-4234-8234-123456789abc" };
  f.chunks.set(`background-${abandoned.id}-0.bin`, png());
  f.records.set("window-background-import-v1.json", { schemaVersion: state.schemaVersion, images: [state.image, abandoned] });
  await f.repository.recover(state);
  assert.equal(f.chunks.size, 1); assert.ok(await f.repository.verifyImage(state.image).then(() => true));
});
test("malformed references, corruption and unsafe requests fail closed without arbitrary raster limits", async () => {
  const f = fixture(), state = await f.repository.commit(await f.repository.load(), png());
  f.chunks.values().next().value[20] ^= 1;
  await assert.rejects(f.repository.verifyImage(state.image));
  for (const bytes of [Buffer.from("not an image"), png().subarray(0, 30)]) assert.throws(() => inspectBackgroundImage(bytes));
  const bomb = png(); bomb.writeUInt32BE(16384, 16); bomb.writeUInt32BE(16384, 20); assert.deepEqual(inspectBackgroundImage(bomb), { mime: "image/png", width: 16384, height: 16384 });
  for (const patch of [{ color: "url(file:///x)", mask: 35, removeImage: false }, { color: "#FFFFFF", mask: 91, removeImage: false }, { color: "#FFFFFF", mask: 35, removeImage: false, path: "private" }]) {
    assert.throws(() => validateWindowBackgroundPatch(patch));
    assert.throws(() => createDesktopRequest("setWindowBackground", { value: patch }));
  }
  assert.throws(() => createDesktopRequest("chooseWindowBackground", { path: "private" }));
  assert.throws(() => createWindowsBackgroundRepository({}));
  assert.deepEqual(createDesktopCommand("windowBackground"), { command: "windowBackground" });
});
test("controller serializes changes, retains image on color edits and emits no success for cancel or failure", async () => {
  const f = fixture(); let notifications = 0, selection = png();
  const controller = createDesktopBackgroundController({ repository: f.repository, chooseImage: async () => selection, notify: () => notifications++ });
  await controller.handlers.chooseWindowBackground();
  const image = (await f.repository.load()).image;
  await Promise.all([controller.handlers.setWindowBackground({ value: { color: "#FFFBEB", mask: 42, removeImage: false } }), controller.handlers.setWindowBackground({ value: { color: "#F0F9FF", mask: 43, removeImage: false } })]);
  assert.deepEqual((await f.repository.load()).image, image);
  assert.equal((await f.repository.load()).color, "#F0F9FF");
  selection = null; const cancelled = await controller.handlers.chooseWindowBackground(); assert.equal(cancelled.status, "cancelled"); assert.equal(notifications, 3);
  f.failure("before"); await assert.rejects(controller.handlers.setWindowBackground({ value: { color: "#FFFFFF", mask: 43, removeImage: true } })); assert.equal(notifications, 3);
  await controller.handlers.restoreWindowBackground(); assert.equal(f.chunks.size, 0);
});

test("100 MB selected originals stream through protected chunks and resource responses across restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usagemonitor-background-test-"));
  try {
    const path = join(directory, "original.png"), bytes = png(100 * 1024 * 1024);
    const expected = createHash("sha256").update(bytes).digest("hex");
    await writeFile(path, bytes);
    const source = await readSelectedBackground(path);
    await source.validateDecode(input => assert.equal(inspectBackgroundImage(input).mime, "image/png"));
    const f = fixture();
    const state = await f.repository.commit(await f.repository.load(), source);
    assert.equal(state.image.sha256, expected);
    assert.equal(state.image.bytes, bytes.length);
    const restarted = createBackgroundRepository({ storage: f.storage });
    const controller = createDesktopBackgroundController({ repository: restarted });
    const result = await controller.handlers.getWindowBackground();
    assert.ok(JSON.stringify(result).length < 300);
    assert.ok(!Object.hasOwn(result.background, "imageData"));
    const response = await controller.handleResource({ url: result.background.imageUrl, method: "GET" });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-length"), String(bytes.length));
    const hash = createHash("sha256"); let total = 0;
    for await (const chunk of response.body) { assert.ok(chunk.length <= 1024 * 1024); total += chunk.length; hash.update(chunk); }
    assert.equal(total, bytes.length);
    assert.equal(hash.digest("hex"), expected);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("resource URLs reject other images, paths and methods and detect corrupted chunks", async () => {
  const f = fixture(), controller = createDesktopBackgroundController({ repository: f.repository, chooseImage: async () => png() });
  const result = await controller.handlers.chooseWindowBackground(), url = result.background.imageUrl;
  for (const invalid of ["file:///private.png", "https://invalid/image.png", `${url}?path=private`, `${url}#x`, `${url}/../private`, url.replace("//image/", "//other/"), "usagemonitor-background://image/12345678-1234-4234-8234-123456789abc"]) {
    assert.equal((await controller.handleResource({ url: invalid, method: "GET" })).status, 404);
  }
  assert.equal((await controller.handleResource({ url, method: "POST" })).status, 405);
  const head = await controller.handleResource({ url, method: "HEAD" });
  assert.equal(head.status, 200); assert.equal(head.body, null);
  f.chunks.values().next().value[0] ^= 1;
  assert.equal((await controller.handleResource({ url, method: "GET" })).status, 404);
});

test("in-flight resource retains its owned chunks through replacement, then cleans them on recovery", async () => {
  const f = fixture(), controller = createDesktopBackgroundController({ repository: f.repository, chooseImage: async () => png(2 * 1024 * 1024) });
  const initial = await controller.handlers.chooseWindowBackground();
  const first = await controller.handleResource({ url: initial.background.imageUrl, method: "GET" });
  await controller.handlers.chooseWindowBackground();
  await controller.handlers.chooseWindowBackground();
  const hash = createHash("sha256");
  for await (const chunk of first.body) hash.update(chunk);
  assert.equal(hash.digest("hex"), createHash("sha256").update(png(2 * 1024 * 1024)).digest("hex"));
  await controller.handlers.getWindowBackground();
  assert.equal(f.chunks.size, 3);
  assert.equal((await controller.handleResource({ url: initial.background.imageUrl, method: "GET" })).status, 404);
});

test("legacy metadata moves forward and future schemas never downgrade", async () => {
  const f = fixture(), initial = await f.repository.commit(await f.repository.load(), png());
  f.records.set("window-background-v1.json", { ...initial, schemaVersion: "usagemonitor-window-background-v1" });
  const migrated = await f.repository.load();
  assert.equal(migrated.schemaVersion, "usagemonitor-window-background-v2");
  assert.deepEqual(migrated.image, initial.image);
  assert.deepEqual(f.records.get("window-background-v1.json"), migrated);
  f.records.set("window-background-v1.json", { ...initial, schemaVersion: "usagemonitor-window-background-v99" });
  await assert.rejects(f.repository.load());
  assert.equal(f.records.get("window-background-v1.json").schemaVersion, "usagemonitor-window-background-v99");
});

test("file changed after native validation fails import without replacing the durable background", async () => {
  const directory = await mkdtemp(join(tmpdir(), "usagemonitor-background-race-"));
  try {
    const path = join(directory, "selected.png");
    await writeFile(path, png(10));
    const source = await readSelectedBackground(path);
    await source.validateDecode(() => {});
    const changed = png(10); changed[50] ^= 1; await writeFile(path, changed);
    const f = fixture(), before = await f.repository.commit(await f.repository.load(), png());
    await assert.rejects(f.repository.commit(before, source));
    assert.deepEqual(await f.repository.load(), before);
    assert.equal(f.chunks.size, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
