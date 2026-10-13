import test from 'node:test';
import assert from 'node:assert/strict';
import { parseWindowsLegacyStateCopyArguments, runWindowsLegacyStateCopy } from '../scripts/copy-windows-legacy-state.mjs';

test('legacy state CLI defaults to dry run and requires exact explicit roots and a single mutation mode', () => {
  const args = ['--source-root', 'C:\\synthetic\\old', '--destination-root', 'C:\\synthetic\\new'];
  assert.equal(parseWindowsLegacyStateCopyArguments(args).mode, 'dry-run');
  assert.equal(parseWindowsLegacyStateCopyArguments([...args, '--copy']).mode, 'copy');
  assert.equal(parseWindowsLegacyStateCopyArguments([...args, '--resume']).mode, 'resume');
  for (const invalid of [[], ['--source-root'], [...args, '--copy', '--resume'],
    [...args, '--source-root', 'C:\\other'], [...args, '--publish']]) {
    assert.throws(() => parseWindowsLegacyStateCopyArguments(invalid));
  }
});

test('legacy state CLI emits fixed bounded failures and never prints native private error context', () => {
  const output = [];
  assert.equal(runWindowsLegacyStateCopy([], { loadBinding() { throw new Error('must not load'); },
    write: line => output.push(line) }), 1);
  assert.deepEqual(output, ['legacy_state_copy_arguments']);
  output.length = 0;
  assert.equal(runWindowsLegacyStateCopy(['--source-root', 'C:\\synthetic\\old', '--destination-root', 'C:\\synthetic\\new'],
    { loadBinding() { throw new Error('private SID and path'); }, write: line => output.push(line) }), 1);
  assert.deepEqual(output, ['legacy_state_copy_unavailable']);
});
