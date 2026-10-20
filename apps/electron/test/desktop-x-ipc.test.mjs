import assert from 'node:assert/strict';
import test from 'node:test';
import { installDesktopXIpc, validateXDesktopRequest, X_IPC_CHANNEL } from '../desktop-x-ipc.js';
import { validateDesktopCommand } from '../desktop-command.js';
import { X_SESSION_ERRORS } from '../desktop-x-contract.js';

test('local session failure categories survive IPC without raw error context', async () => {
  for (const code of [...X_SESSION_ERRORS, 'storage_unavailable']) {
    let handler;
    installDesktopXIpc({ ipcMain: { handle(_name, fn) { handler = fn; } }, authorize: () => true, importBridge: {},
      service: { getStatus() { throw Object.assign(new Error('synthetic private context'), { code }); } } });
    await assert.rejects(handler({}, { action: 'getXStatus', args: {} }), error => error.code === code && error.message === code);
  }
});

test('X IPC rejects foreign frames before validation or service access', async () => {
  let handler; let called = 0;
  const ipcMain = { handle(channel, callback) { assert.equal(channel, X_IPC_CHANNEL); handler = callback; }, removeHandler() {} };
  installDesktopXIpc({ ipcMain, service: { getStatus: () => { called++; return { auth: 'ready' }; } }, importBridge: {}, authorize: event => event.trusted === true });
  for (const event of [{}, { trusted: false, senderFrame: { url: 'https://x.com' } }]) {
    await assert.rejects(handler(event, { action: 'getXStatus', args: {} }), { code: 'x_untrusted_context' });
  }
  assert.equal(called, 0);
  assert.deepEqual(await handler({ trusted: true }, { action: 'getXStatus', args: {} }), { auth: 'ready' });
  assert.equal(called, 1);
});

test('X bridge closed inputs cannot select arbitrary resources or leak failures', async () => {
  for (const request of [
    { action: 'getXPost', args: { id: 'https://x.com' } },
    { action: 'getXPost', args: { id: '123', url: 'file:///private' } },
    { action: 'beginXLogin', args: { method: 'database' } },
    { action: 'refreshX', args: { cookies: [] } },
    { action: 'listXPosts', args: { tab: 'posts', cursor: '../private' } },
    { action: 'getXStatus', args: {}, path: 'private' },
  ]) assert.throws(() => validateXDesktopRequest(request));
  let handler;
  installDesktopXIpc({ ipcMain: { handle(_c, fn) { handler = fn; } }, service: { getPost() { throw new Error('synthetic private token'); } }, importBridge: {}, authorize: () => true });
  await assert.rejects(handler({}, { action: 'getXPost', args: { id: '123' } }), error => error.code === 'x_operation_failed' && !error.message.includes('token'));
  assert.deepEqual(validateDesktopCommand({ command: 'xPost', id: '123' }), { command: 'xPost', id: '123' });
  assert.throws(() => validateDesktopCommand({ command: 'xPost', id: 'https://x.com' }));
  assert.throws(() => validateDesktopCommand({ command: 'xPost', id: '123', url: 'https://x.com' }));
});
