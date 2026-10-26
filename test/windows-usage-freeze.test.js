import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { readFile, rm, mkdir, writeFile, appendFile, link, symlink } from "node:fs/promises";
import { execFileSync, spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import { resolve, join, relative } from "node:path";
import test from "node:test";
const require = createRequire(import.meta.url);
const TAG = Buffer.alloc(16, 7);
const enabled = process.env.USAGE_MONITOR_USAGE_FREEZE_QUALIFICATION === "1";
const gate = { skip: enabled ? false : "explicit isolated usage-freeze native qualification required" };
let native;
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
function binding() {
  if (native) return native;
  const root = resolve(".release-build/usage-freeze-native-v1"), receipt = require(join(root, "source-binding.json"));
  const path = join(root, "native/windows-filesystem/build/Release/windows_filesystem.node");
  const bytes = require("node:fs").readFileSync(path);
  assert.equal(sha(bytes), receipt.bindingSha256);
  for (const source of receipt.sources) assert.equal(sha(require("node:fs").readFileSync(source.path)), source.sha256);
  native = require(path);
  assert.equal(native.usageFreezeQualificationContractVersion, "windows-usage-directory-freeze-qualification-v1");
  assert.equal(native.productionSafe, false); assert.equal(native.pathWalkRaceSafe, false);
  return native;
}
async function fixture(t, { inherited = false } = {}) {
  const api = binding(), root = resolve(".release-build", `usage-freeze-test-${randomUUID()}`), source = join(root, "source");
  api.ensureDirectory(root); api.ensureDirectory(source);
  if (inherited) {
    const sid = execFileSync("whoami.exe", ["/user", "/fo", "csv", "/nh"], { encoding: "utf8", windowsHide: true }).match(/S-1-[0-9-]+/u)[0];
    execFileSync("icacls.exe", [source, "/grant:r", `*${sid}:(OI)(CI)(F)`], { stdio: "pipe", windowsHide: true });
  }
  api.ensureDirectory(join(source, "unselected-child"));
  if (inherited) await writeFile(join(source, "selected.bin"), "synthetic");
  else api.createFile(join(source, "selected.bin"), Buffer.from("synthetic"));
  const selectedIdentity = api.inspectPath(join(source, "selected.bin")).identity;
  t.after(async () => {
    const child = relative(resolve(".release-build"), root);
    assert.ok(child && !child.startsWith("..") && !child.includes(":"));
    await rm(root, { recursive: true, force: true });
  });
  return { api, root, source, selectedIdentity };
}
function probe(source) {
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import {writeFileSync,mkdirSync} from 'node:fs'; import{join}from'node:path';
    const root=process.argv[1],out={};
    for(const[name,run]of[['append',()=>writeFileSync(join(root,'selected.bin'),'x',{flag:'a'})],
      ['create',()=>writeFileSync(join(root,'new.bin'),'x',{flag:'wx'})],['directory',()=>mkdirSync(join(root,'new-dir'))]]){
      try{run();out[name]='allowed';}catch{out[name]='refused';}}
    process.stdout.write(JSON.stringify(out));
  `, source], { encoding: "utf8", windowsHide: true, timeout: 10000 });
  assert.equal(child.status, 0, "synthetic writer probe unavailable"); return JSON.parse(child.stdout);
}

test("usage-freeze qualification is opt-in and never enables general production policy", () => {
  const manifest = require("../native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json");
  assert.equal(manifest.approvedPolicy.productionSafe, false); assert.equal(manifest.approvedPolicy.pathWalkRaceSafe, false);
});

for (const persistent of [false, true]) test(`atomic operation-record rename handles an external reader; persistent=${persistent}`, gate, async t => {
  const { api, root } = await fixture(t), directory = join(root, "operation"); api.ensureDirectory(directory);
  const guard = api.acquireProtectedDirectoryGuard(directory);
  const before = api.createProtectedChild(directory, guard.identity, "operation.json", Buffer.from("before"));
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import{openSync,closeSync}from'node:fs';const handle=openSync(process.argv[1],'r');
    process.stdout.write('held');setTimeout(()=>{closeSync(handle)},Number(process.argv[2]));
  `, join(directory, "operation.json"), persistent ? "2000" : "80"], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stderr.resume(); const closed = once(child, "close"); let timer;
  try {
    await Promise.race([once(child.stdout, "data"), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("synthetic_reader_timeout")), 10000); })]);
    clearTimeout(timer);
    if (persistent) {
      assert.throws(() => api.replaceProtectedChild(directory, guard.identity, "operation.json", before, Buffer.from("after")), { code: "WINDOWS_FILESYSTEM_ACCESS_DENIED" });
      assert.equal((await readFile(join(directory, "operation.json"))).toString(), "before");
      assert.deepEqual(api.inspectPath(join(directory, "operation.json")).identity, before);
    } else {
      api.replaceProtectedChild(directory, guard.identity, "operation.json", before, Buffer.from("after"));
      assert.equal((await readFile(join(directory, "operation.json"))).toString(), "after");
    }
  } finally { clearTimeout(timer); child.kill(); await closed; api.releaseProtectedDirectoryGuard(guard.guard); }
});

for (const principal of ["S-1-1-0", "S-1-5-18"]) test(`broad or foreign source grant ${principal} is refused without ACL repair`, gate, async t => {
  const { api, source } = await fixture(t);
  execFileSync("icacls.exe", [source, "/grant", `*${principal}:R`], { stdio: "pipe", windowsHide: true });
  const before = api.inspectPath(source);
  assert.equal(before.nonOwnerAllow, true);
  assert.throws(() => api.openUsageFreezeDirectory(source, TAG), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_SECURITY" });
  assert.deepEqual(api.inspectPath(source), before);
  await appendFile(join(source, "selected.bin"), "owner-source-unchanged");
});

test("necessary parent freeze closes DELETE_CHILD root-rename bypass after every lease is released", gate, async t => {
  const { api, root: parent, source, selectedIdentity } = await fixture(t);
  await mkdir(join(parent, "unselected-sibling")); await writeFile(join(parent, "unselected-sibling", "owner.bin"), "retained");
  const root = api.openUsageFreezeParentDirectory(parent, TAG);
  let sourceLease, file;
  try {
    const before = api.readUsageChildSecurity(root.lease, "source"), sibling = api.readUsageChildSecurity(root.lease, "unselected-sibling");
    api.applyUsageDirectoryFreeze(root.lease); api.sealUsageFreezeParentDirectory(root.lease);
    assert.deepEqual(api.readUsageChildSecurity(root.lease, "source"), before);
    assert.deepEqual(api.readUsageChildSecurity(root.lease, "unselected-sibling"), sibling);
    await appendFile(join(parent, "unselected-sibling", "owner.bin"), "-owner-write");
    sourceLease = api.openUsageFreezeChildDirectory(root.lease, "source", api.inspectPath(source).identity);
    api.applyUsageDirectoryFreeze(sourceLease.lease);
    file = api.openUsageFreezeChildFile(sourceLease.lease, "selected.bin", selectedIdentity); api.applyUsageDirectoryFreeze(file.lease);
    api.closeUsageFreezeDirectory(file.lease); api.closeUsageFreezeDirectory(sourceLease.lease); api.closeUsageFreezeDirectory(root.lease);
    const attempted = spawnSync(process.execPath, ["--input-type=module", "-e",
      "import{renameSync}from'node:fs';try{renameSync(process.argv[1],process.argv[2]);process.exit(3)}catch{process.exit(0)}", source, join(parent, "moved")], { windowsHide: true, timeout: 10000 });
    assert.equal(attempted.status, 0);
  } finally {
    const p = api.reopenUsageFreezeParentDirectory(parent, root.identity, root.originalSecurity, TAG);
    api.sealUsageFreezeParentDirectory(p.lease);
    const s = api.reopenUsageFreezeChildDirectory(p.lease, "source", sourceLease.identity, sourceLease.originalSecurity);
    const f = api.reopenUsageFreezeChildFile(s.lease, "selected.bin", file.identity, file.originalSecurity);
    api.restoreUsageDirectoryFreeze(f.lease); api.closeUsageFreezeDirectory(f.lease);
    api.restoreUsageDirectoryFreeze(s.lease); api.closeUsageFreezeDirectory(s.lease);
    api.restoreUsageDirectoryFreeze(p.lease); api.closeUsageFreezeDirectory(p.lease);
  }
});

for (const inherited of [false, true]) test(`native ACL freeze/restore preserves child ACL and bytes; inheritable parent=${inherited}`, gate, async t => {
  const { api, source, selectedIdentity } = await fixture(t, { inherited });
  const root = api.openUsageFreezeDirectory(source, TAG); let file;
  try {
    const before = api.readUsageChildSecurity(root.lease, "unselected-child");
    api.applyUsageDirectoryFreeze(root.lease);
    assert.deepEqual(api.readUsageChildSecurity(root.lease, "unselected-child"), before);
    const entries = api.listUsageFreezeChildren(root.lease);
    assert.deepEqual(entries.map(row => row.name).sort(), ["selected.bin", "unselected-child"]);
    assert.equal(entries.find(row => row.name === "selected.bin").identity.fileId, selectedIdentity.fileId);
    file = api.openUsageFreezeChildFile(root.lease, "selected.bin", selectedIdentity);
    api.applyUsageDirectoryFreeze(file.lease);
    assert.deepEqual(probe(source), { append: "refused", create: "refused", directory: "refused" });
    const borrowed = api.borrowUsageFrozenObjectFile(file.lease);
    try {
      assert.equal(api.readSourceFile(borrowed, 0, 9).toString(), "synthetic");
      assert.throws(() => api.restoreUsageDirectoryFreeze(file.lease), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_BORROWERS_ACTIVE" });
      assert.throws(() => api.restoreUsageDirectoryFreeze(root.lease), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_DESCENDANTS_ACTIVE" });
    } finally { api.closeSourceFile(borrowed); }
    api.restoreUsageDirectoryFreeze(file.lease); api.closeUsageFreezeDirectory(file.lease); file = null;
    api.restoreUsageDirectoryFreeze(root.lease);
    assert.deepEqual(api.readUsageChildSecurity(root.lease, "unselected-child"), before);
  } finally {
    if (file) { api.restoreUsageDirectoryFreeze(file.lease); api.closeUsageFreezeDirectory(file.lease); }
    api.restoreUsageDirectoryFreeze(root.lease); api.closeUsageFreezeDirectory(root.lease);
  }
  const reopened = api.openUsageFreezeDirectory(source, TAG);
  try { assert.deepEqual(reopened.originalSecurity, root.originalSecurity); } finally { api.closeUsageFreezeDirectory(reopened.lease); }
  assert.equal(await readFile(join(source, "selected.bin"), "utf8"), "synthetic");
});

test("closing frozen native leases leaves persistent write denial until exact recovery", gate, async t => {
  const { api, source, selectedIdentity } = await fixture(t);
  const root = api.openUsageFreezeDirectory(source, TAG); api.applyUsageDirectoryFreeze(root.lease);
  const file = api.openUsageFreezeChildFile(root.lease, "selected.bin", selectedIdentity); api.applyUsageDirectoryFreeze(file.lease);
  api.closeUsageFreezeDirectory(file.lease); api.closeUsageFreezeDirectory(root.lease);
  assert.deepEqual(probe(source), { append: "refused", create: "refused", directory: "refused" });
  assert.throws(() => api.openUsageFreezeDirectory(source, TAG), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_RESUME_REQUIRED" });
  const recovered = api.reopenUsageFreezeDirectory(source, root.identity, root.originalSecurity, TAG);
  try {
    const leaf = api.reopenUsageFreezeChildFile(recovered.lease, "selected.bin", file.identity, file.originalSecurity);
    try { api.restoreUsageDirectoryFreeze(leaf.lease); } finally { api.closeUsageFreezeDirectory(leaf.lease); }
    api.restoreUsageDirectoryFreeze(recovered.lease);
  } finally { api.closeUsageFreezeDirectory(recovered.lease); }
  await appendFile(join(source, "selected.bin"), "x");
});

test("malformed recovery descriptors, wrong IDs and stale tokens refuse before mutation", gate, async t => {
  const { api, source } = await fixture(t), root = api.openUsageFreezeDirectory(source, TAG);
  api.closeUsageFreezeDirectory(root.lease);
  for (const sd of [Buffer.alloc(0), Buffer.alloc(20), Buffer.from(root.originalSecurity.map((value, i) => i === 4 ? 255 : value))]) {
    assert.throws(() => api.reopenUsageFreezeDirectory(source, root.identity, sd, TAG));
  }
  assert.throws(() => api.reopenUsageFreezeDirectory(source, { ...root.identity, fileId: "f".repeat(32) }, root.originalSecurity, TAG));
  assert.throws(() => api.applyUsageDirectoryFreeze(root.lease));
  const current = api.openUsageFreezeDirectory(source, TAG);
  try { assert.deepEqual(current.originalSecurity, root.originalSecurity); } finally { api.closeUsageFreezeDirectory(current.lease); }
});

test("a child with granted pre-existing write access prevents freeze acquisition", gate, async t => {
  const { api, source, selectedIdentity } = await fixture(t), root = api.openUsageFreezeDirectory(source, TAG);
  api.applyUsageDirectoryFreeze(root.lease);
  const handle = require("node:fs").openSync(join(source, "selected.bin"), "a");
  try { assert.throws(() => api.openUsageFreezeChildFile(root.lease, "selected.bin", selectedIdentity)); }
  finally { require("node:fs").closeSync(handle); api.restoreUsageDirectoryFreeze(root.lease); api.closeUsageFreezeDirectory(root.lease); }
});

test("native child acquisition and reverse restoration remain bound to held parent identities", gate, async t => {
  const { api, source } = await fixture(t), root = api.openUsageFreezeDirectory(source, TAG); let child;
  try {
    api.applyUsageDirectoryFreeze(root.lease);
    const entry = api.listUsageFreezeChildren(root.lease).find(row => row.name === "unselected-child");
    child = api.openUsageFreezeChildDirectory(root.lease, entry.name, entry.identity);
    api.applyUsageDirectoryFreeze(child.lease);
    assert.deepEqual(api.listUsageFreezeChildren(child.lease), []);
    assert.throws(() => api.openUsageFreezeChildDirectory(root.lease, "../outside", entry.identity));
    api.restoreUsageDirectoryFreeze(child.lease); api.closeUsageFreezeDirectory(child.lease); child = null;
    api.restoreUsageDirectoryFreeze(root.lease);
  } finally {
    if (child) { api.restoreUsageDirectoryFreeze(child.lease); api.closeUsageFreezeDirectory(child.lease); }
    api.restoreUsageDirectoryFreeze(root.lease); api.closeUsageFreezeDirectory(root.lease);
  }
});

test("hard links, junction roots and wrong child identities refuse without rewriting object ACLs", gate, async t => {
  const { api, source, root: fixtureRoot, selectedIdentity } = await fixture(t);
  await link(join(source, "selected.bin"), join(source, "alias.bin"));
  await symlink(source, join(fixtureRoot, "redirect"), "junction");
  assert.throws(() => api.openUsageFreezeDirectory(join(fixtureRoot, "redirect"), TAG));
  const root = api.openUsageFreezeDirectory(source, TAG);
  try {
    api.applyUsageDirectoryFreeze(root.lease);
    assert.throws(() => api.openUsageFreezeChildFile(root.lease, "selected.bin", selectedIdentity));
    assert.throws(() => api.openUsageFreezeChildFile(root.lease, "selected.bin", { ...selectedIdentity, fileId: "e".repeat(32) }));
    api.restoreUsageDirectoryFreeze(root.lease);
  } finally { api.restoreUsageDirectoryFreeze(root.lease); api.closeUsageFreezeDirectory(root.lease); }
});

test("owned process death leaves directories AND existing files protected until journal-bound recovery", { ...gate, timeout: 25000 }, async t => {
  const { api, source, root: fixtureRoot } = await fixture(t);
  const binary = resolve(".release-build/usage-freeze-native-v1/native/windows-filesystem/build/Release/windows_filesystem.node");
  const receiptPath = join(fixtureRoot, "recovery.json");
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {createRequire}from'node:module';import{join}from'node:path';
    const api=createRequire(import.meta.url)(process.argv[1]),source=process.argv[2],receipt=process.argv[3];
    const root=api.openUsageFreezeDirectory(source,Buffer.alloc(16,7));
    const packed=item=>({identity:item.identity,originalSecurity:item.originalSecurity.toString('base64')});
    let data={root:packed(root),file:null};
    let receiptID=api.createFile(receipt,Buffer.from(JSON.stringify(data)));
    api.applyUsageDirectoryFreeze(root.lease);
    const entry=api.listUsageFreezeChildren(root.lease).find(item=>item.name==='selected.bin');
    const file=api.openUsageFreezeChildFile(root.lease,entry.name,entry.identity);
    data.file=packed(file);api.replaceFile(receipt,receiptID,Buffer.from(JSON.stringify(data)));
    api.applyUsageDirectoryFreeze(file.lease);
    process.stdout.write('ready\\n');setInterval(()=>{},1000);
  `, binary, source, receiptPath], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  child.stderr.resume();
  let recovered;
  try {
    await new Promise((done, reject) => {
      const timer = setTimeout(() => reject(new Error("Synthetic freeze child timeout")), 12000);
      const failed = () => { clearTimeout(timer); reject(new Error("Synthetic freeze child unavailable")); };
      child.once("error", failed); child.once("exit", failed);
      let text = "";
      child.stdout.setEncoding("utf8"); child.stdout.on("data", chunk => { text += chunk; if (text.includes("ready\n")) { clearTimeout(timer); done(); } });
    });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    assert.deepEqual(probe(source), { append: "refused", create: "refused", directory: "refused" });
    const record = JSON.parse((api.readFile(receiptPath)).data.toString("utf8"));
    recovered = api.reopenUsageFreezeDirectory(source, record.root.identity, Buffer.from(record.root.originalSecurity, "base64"), TAG);
    const file = api.reopenUsageFreezeChildFile(recovered.lease, "selected.bin", record.file.identity, Buffer.from(record.file.originalSecurity, "base64"));
    try { api.restoreUsageDirectoryFreeze(file.lease); } finally { api.closeUsageFreezeDirectory(file.lease); }
    api.restoreUsageDirectoryFreeze(recovered.lease); api.closeUsageFreezeDirectory(recovered.lease); recovered = null;
    await appendFile(join(source, "selected.bin"), "x");
  } finally {
    if (child.exitCode === null && child.signalCode === null) { const exit = once(child, "exit"); child.kill("SIGKILL"); await exit; }
    if (recovered) { api.restoreUsageDirectoryFreeze(recovered.lease); api.closeUsageFreezeDirectory(recovered.lease); }
  }
});

test("a valid journal from an earlier operation cannot thaw a later operation", gate, async t => {
  const { api, source } = await fixture(t);
  const first = api.openUsageFreezeDirectory(source, TAG);
  api.applyUsageDirectoryFreeze(first.lease); api.restoreUsageDirectoryFreeze(first.lease); api.closeUsageFreezeDirectory(first.lease);
  const laterTag = Buffer.alloc(16, 8), later = api.openUsageFreezeDirectory(source, laterTag);
  api.applyUsageDirectoryFreeze(later.lease); api.closeUsageFreezeDirectory(later.lease);
  assert.throws(() => api.reopenUsageFreezeDirectory(source, first.identity, first.originalSecurity, TAG), { code: "WINDOWS_FILESYSTEM_USAGE_FREEZE_ACL_MISMATCH" });
  const recovery = api.reopenUsageFreezeDirectory(source, later.identity, later.originalSecurity, laterTag);
  try { api.restoreUsageDirectoryFreeze(recovery.lease); } finally { api.closeUsageFreezeDirectory(recovery.lease); }
});
