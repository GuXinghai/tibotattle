import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { createReadStream } from 'node:fs';
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createWindowsFilesystemAdapter, loadWindowsLegacyStateReadBinding } from '../src/platform/index.js';

test('process death during native copy leaves no partial payload or source mutation', { timeout: 15_000 }, async () => {
  const parent = await mkdtemp(join(tmpdir(), 'legacy-copy-crash-'));
  const sourceRoot = join(parent, 'source'), destination = join(parent, 'destination');
  const path = join(sourceRoot, 'synthetic.bin'), size = 128 * 1024 * 1024 + 3;
  const adapter = createWindowsFilesystemAdapter();
  adapter.ensureDirectory(sourceRoot); adapter.ensureDirectory(destination);
  adapter.createFile(path, Buffer.alloc(0));
  const handle = await open(path, 'r+');
  try { await handle.truncate(size); } finally { await handle.close(); }
  const original = adapter.inspectPath(path);
  const expected = createHash('sha256'), zeros = Buffer.alloc(65536);
  for (let offset = 0; offset < size; offset += zeros.length) expected.update(zeros.subarray(0, Math.min(zeros.length, size - offset)));
  const expectedDigest = expected.digest('hex');
  const moduleURL = new URL('../src/platform/index.js', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import { loadWindowsLegacyStateReadBinding } from ${JSON.stringify(moduleURL)};
    const native = loadWindowsLegacyStateReadBinding();
    const source = native.openLegacyStateFile(process.argv[1]);
    const target = native.acquireProtectedDirectoryGuard(process.argv[2]);
    process.stdout.write('ready\\n', () => {
      native.copyLegacyStateFile(source, process.argv[2], target.identity, 'copied.bin');
      process.stdout.write('complete\\n');
      setInterval(() => {}, 1000);
    });
  `, path, destination], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let output = '';
  child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; });
  try {
    const deadline = Date.now() + 8_000;
    while (!(await readdir(destination)).includes('copied.bin')) {
      assert.equal(child.exitCode, null, 'copy child remains alive until intentional termination');
      assert.ok(Date.now() < deadline, 'native creation reached bounded deadline');
      await new Promise(resolve => setTimeout(resolve, 2));
    }
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    assert.ok(output.includes('ready\n'), 'native copy was entered');
    const native = loadWindowsLegacyStateReadBinding();
    // Death may race successful settlement. Both absent and completely verified
    // payloads are atomic outcomes; an incomplete retained payload is forbidden.
    if ((await readdir(destination)).includes('copied.bin')) {
      const target = join(destination, 'copied.bin');
      assert.equal(adapter.inspectPath(target).daclProtected, true);
      const lease = native.openLegacyStateFile(target);
      try {
        assert.equal(native.statSourceFile(lease).size, size);
        const actual = createHash('sha256');
        for (let offset = 0; offset < size; offset += 65536) {
          const length = Math.min(65536, size - offset);
          const bytes = native.readSourceFile(lease, offset, length);
          actual.update(bytes); bytes.fill(0);
        }
        assert.equal(actual.digest('hex'), expectedDigest);
      } finally { native.closeSourceFile(lease); }
    }
    const sourceDigest = createHash('sha256');
    for await (const chunk of createReadStream(path, { highWaterMark: 65536 })) sourceDigest.update(chunk);
    assert.equal(sourceDigest.digest('hex'), expectedDigest, 'original bytes remain unchanged');
    assert.deepEqual(adapter.inspectPath(path), original);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    }
    await rm(parent, { recursive: true, force: true });
  }
});
