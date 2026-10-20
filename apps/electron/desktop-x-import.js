import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { connect } from 'node:net';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError } from '../../src/platform/index.js';
import { normalizeXImportCookies, encodeXImportFrame, createXImportFrameReader, X_IMPORT_HOST, X_IMPORT_ORIGIN, X_IMPORT_EXTENSION_ID } from './x-import/contract.js';

const execFile = promisify(execFileCallback);
const SOURCE = fileURLToPath(new URL('./x-import/', import.meta.url));
const FILES = ['manifest.json', 'popup.html', 'popup.js', 'TiboTattleXImport.exe'];
const reply = (code, extra = {}) => ({ ok: ['bridge_ready', 'import_ready', 'imported', 'verification_pending'].includes(code), code, ...extra });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

/** Credential-bearing requests stay exclusively in the main process. */
export function createXImportRequestGate({ onImport, now = Date.now, token = () => randomBytes(32).toString('hex') }) {
  let generation = 0, pending = null, disposed = false;
  const cancel = () => { generation++; pending = null; };
  const current = candidate => !disposed && pending === candidate && generation === candidate.generation && now() < candidate.expiresAt;
  return Object.freeze({
    begin() { if (disposed) return reply('bridge_unavailable'); cancel(); pending = { generation, expiresAt: now() + 120000, ticket: null, busy: false }; return reply('import_ready'); },
    cancel,
    status() { return { pending: Boolean(pending && current(pending)), importing: Boolean(pending && current(pending) && pending.busy) }; },
    dispose() { disposed = true; cancel(); },
    async handle(message) {
      if (disposed || !message || message.version !== 1) return reply('invalid_import');
      if (exactKeys(message, ['version', 'type']) && message.type === 'bridge-check') return reply('bridge_ready');
      if (exactKeys(message, ['version', 'type']) && message.type === 'import-preflight') {
        if (!pending || !current(pending) || pending.busy) return reply('import_not_pending');
        pending.ticket = token(); return reply('import_ready', { permit: pending.ticket });
      }
      if (!exactKeys(message, ['version', 'type', 'permit', 'cookies']) || message.type !== 'x-cookie-import' || typeof message.permit !== 'string' || !/^[a-f0-9]{64}$/.test(message.permit)) return reply('invalid_import');
      const candidate = pending;
      if (!candidate || !current(candidate) || candidate.busy || candidate.ticket !== message.permit) return reply('import_expired');
      candidate.ticket = null; candidate.busy = true;
      let cookies = [];
      try {
        cookies = normalizeXImportCookies(message.cookies);
        const result = await onImport(cookies, Object.freeze({ generation: candidate.generation, isCurrent: () => current(candidate) }));
        if (!current(candidate)) return reply('import_expired');
        if (result === false || result?.ok === false) return reply('import_failed');
        pending = null; return reply(result?.code === 'verification_pending' ? 'verification_pending' : 'imported');
      } catch (error) {
        return reply(['invalid_import', 'no_logged_in_session'].includes(error?.message) ? error.message : 'import_failed');
      } finally {
        cookies.length = 0;
        if (Array.isArray(message.cookies)) message.cookies.length = 0;
        if (pending === candidate) { candidate.busy = false; candidate.ticket = null; }
      }
    },
  });
}

/** Build-time only: package the resulting binary beside this reviewed source. */
export async function buildDesktopXImportNative({ sourceDirectory = SOURCE, outputPath, windowsDirectory = process.env.SystemRoot }) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !outputPath || !windowsDirectory) throw new Error('x_import_build_unavailable');
  const compiler = join(windowsDirectory, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  try { await execFile(compiler, ['/nologo', '/target:exe', '/platform:x64', `/out:${outputPath}`, join(sourceDirectory, 'NativeHost.cs')], { windowsHide: true, timeout: 30000, maxBuffer: 16384 }); }
  catch { throw new Error('x_import_build_failed'); }
}

export function createDesktopXImport({ protectedStore, onImport, sourceDirectory = SOURCE }) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isWindowsProtectedStateStore(protectedStore) || protectedStore.maxBytes < 1048576 || typeof onImport !== 'function') throw new Error('x_import_unavailable');
  const gate = createXImportRequestGate({ onImport });
  let child = null, channel = null, starting = null, exiting = Promise.resolve(), configured = false, disposed = false, actionGeneration = 0, code = 'not_configured';
  const hostPath = join(protectedStore.rootPath, 'TiboTattleXImport.exe');
  const stop = () => {
    channel?.destroy(); channel = null;
    const old = child; child = null; starting = null;
    if (old?.pid && old.exitCode === null) {
      exiting = new Promise(resolve => { old.once('exit', resolve); old.once('error', resolve); });
      old.kill();
    }
  };
  async function upsert(name, bytes) {
    let previous;
    try { previous = protectedStore.read(name); }
    catch (error) { if (!isWindowsProtectedStateStoreError(error) || error.code !== 'windows_protected_state_store_missing') throw error; }
    if (previous) protectedStore.replace(name, previous.identity, bytes); else protectedStore.create(name, bytes);
  }
  async function openControl(name) {
    const deadline = Date.now() + 8000;
    while (!disposed && child && Date.now() < deadline) {
      try {
        return await new Promise((resolve, reject) => {
          const socket = connect(`\\\\.\\pipe\\${name}`);
          socket.once('connect', () => { socket.removeListener('error', reject); resolve(socket); });
          socket.once('error', reject);
        });
      } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    throw new Error('x_import_unavailable');
  }
  async function start() {
    if (disposed) throw new Error('x_import_unavailable');
    if (channel && !channel.destroyed) return;
    if (starting) return starting;
    starting = (async () => {
      await exiting;
      if (disposed) throw new Error('x_import_unavailable');
      protectedStore.inspect('TiboTattleXImport.exe');
      const expected = await readFile(join(sourceDirectory, 'TiboTattleXImport.exe'));
      const installed = protectedStore.read('TiboTattleXImport.exe').data;
      if (!Buffer.from(installed).equals(expected)) throw new Error('x_import_unavailable');
      const pipe = `TiboTattle.XControl.${randomBytes(16).toString('hex')}`;
      const owned = spawn(hostPath, ['--broker', pipe, String(process.pid)], { windowsHide: true, stdio: 'ignore', env: { SystemRoot: process.env.SystemRoot } });
      child = owned;
      owned.once('error', () => { if (child === owned) { code = 'bridge_unavailable'; channel?.destroy(); } });
      owned.once('exit', () => { if (child === owned) { channel?.destroy(); channel = null; child = null; starting = null; gate.cancel(); code = 'bridge_unavailable'; } });
      channel = await openControl(pipe);
      await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { channel?.destroy(); reject(new Error('x_import_unavailable')); }, 5000);
        const reader = createXImportFrameReader(message => {
          if (exactKeys(message, ['version', 'type']) && message.version === 1 && message.type === 'broker-ready') { clearTimeout(timeout); configured = true; code = 'bridge_ready'; resolve(); return; }
          void gate.handle(message).then(response => {
            if (response.code === 'verification_pending' || response.code === 'imported') code = response.code;
            if (channel && !channel.destroyed) channel.write(encodeXImportFrame(response));
          }).catch(() => channel?.destroy());
        }, () => { clearTimeout(timeout); channel?.destroy(); reject(new Error('x_import_unavailable')); });
        channel.on('data', reader);
        channel.on('error', () => { clearTimeout(timeout); reject(new Error('x_import_unavailable')); });
        channel.once('close', () => { clearTimeout(timeout); reject(new Error('x_import_unavailable')); });
      });
    })().catch(() => { stop(); code = 'bridge_unavailable'; throw new Error('x_import_unavailable'); });
    return starting;
  }
  function status() { return Object.freeze({ configured, code, ...gate.status(), extensionId: X_IMPORT_EXTENSION_ID, extensionDirectory: configured ? protectedStore.rootPath : null }); }
  return Object.freeze({
    async configure() {
      if (disposed) return status();
      actionGeneration++; gate.cancel(); stop();
      try {
        protectedStore.ensureProtectedDirectory();
        for (const name of FILES) await upsert(name, await readFile(join(sourceDirectory, name)));
        await upsert('native-host.json', Buffer.from(JSON.stringify({ name: X_IMPORT_HOST, description: 'TiboTattle X session import', path: hostPath, type: 'stdio', allowed_origins: [X_IMPORT_ORIGIN] })));
        const registry = join(process.env.SystemRoot, 'System32', 'reg.exe');
        for (const view of ['32', '64']) await execFile(registry, ['ADD', `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${X_IMPORT_HOST}`, '/ve', '/t', 'REG_SZ', '/d', join(protectedStore.rootPath, 'native-host.json'), '/f', `/reg:${view}`], { windowsHide: true, timeout: 10000, maxBuffer: 4096 });
        configured = true; await start();
      } catch { configured = false; code = 'bridge_unavailable'; stop(); }
      return status();
    },
    async begin() {
      const action = ++actionGeneration;
      try { await start(); if (action === actionGeneration && !disposed) { gate.begin(); code = 'import_ready'; } }
      catch { code = 'bridge_unavailable'; }
      return status();
    },
    cancel() { actionGeneration++; gate.cancel(); if (configured) code = 'bridge_ready'; return status(); },
    status,
    dispose() { disposed = true; actionGeneration++; gate.dispose(); stop(); },
  });
}
