import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { connect } from 'node:net';
import { spawn, execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { isWindowsProtectedStateStore, isWindowsProtectedStateStoreError } from '../../src/platform/index.js';
import { normalizeXImportCookies, encodeXImportFrame, createXImportFrameReader, X_IMPORT_HOST, X_IMPORT_ORIGIN, X_IMPORT_EXTENSION_ID } from './x-import/contract.js';
import { createXImportSetup, X_IMPORT_ASSETS } from './x-import/setup.js';
import { createXImportRegistration } from './x-import/registration.js';

const execFile = promisify(execFileCallback);
const SOURCE = fileURLToPath(new URL('./x-import/', import.meta.url));
const reply = (code, extra = {}) => ({ ok: ['bridge_ready', 'import_ready', 'imported', 'verification_pending'].includes(code), code, ...extra });
const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.slice().sort().join(',');

/** Credential-bearing requests stay exclusively in the main process. */
export function createXImportRequestGate({ onImport, now = Date.now, token = () => randomBytes(32).toString('hex') }) {
  let generation = 0, pending = null, disposed = false, failure = null;
  const cancel = () => { generation++; pending = null; failure = null; };
  const current = candidate => !disposed && pending === candidate && generation === candidate.generation && now() < candidate.expiresAt;
  return Object.freeze({
    begin() { if (disposed) return reply('bridge_unavailable'); cancel(); pending = { generation, expiresAt: now() + 120000, ticket: null, busy: false }; return reply('import_ready'); },
    cancel,
    status() { return { pending: Boolean(pending && current(pending)), importing: Boolean(pending && current(pending) && pending.busy), failure }; },
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
      candidate.ticket = null; candidate.busy = true; failure = null;
      let cookies = [];
      try {
        cookies = normalizeXImportCookies(message.cookies);
        const result = await onImport(cookies, Object.freeze({ generation: candidate.generation, isCurrent: () => current(candidate) }));
        if (!current(candidate)) return reply('import_expired');
        if (result === false || result?.ok === false) return reply('import_failed');
        pending = null; return reply(result?.code === 'verification_pending' ? 'verification_pending' : 'imported');
      } catch (error) {
        const code = ['invalid_import', 'no_logged_in_session'].includes(error?.message) ? error.message : 'import_failed';
        if (current(candidate)) failure = code;
        return reply(code);
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

export function createDesktopXImport({ protectedStore, onImport, sourceDirectory = SOURCE, revealFolder }) {
  return createDesktopXImportWithRegistration({ protectedStore, onImport, sourceDirectory, revealFolder });
}

// Synthetic native transport tests retain genuine protected storage and the
// real broker. Only registry I/O is replaced; this never qualifies Chrome/X.
export function createDesktopXImportForTest(options, registration) {
  if (!exactKeys(registration, ['register', 'verify']) || typeof registration.register !== 'function' || typeof registration.verify !== 'function') throw new Error('x_import_unavailable');
  return createDesktopXImportWithRegistration(options, registration);
}

function createDesktopXImportWithRegistration({ protectedStore, onImport, sourceDirectory = SOURCE, revealFolder }, registrationOverride) {
  if (process.platform !== 'win32' || process.arch !== 'x64' || !isWindowsProtectedStateStore(protectedStore) || protectedStore.maxBytes < 1048576 || typeof onImport !== 'function') throw new Error('x_import_unavailable');
  const gate = createXImportRequestGate({ onImport });
  let child = null, channel = null, starting = null, exiting = Promise.resolve(), configured = false, disposed = false, actionGeneration = 0, code = 'not_configured', configuring = null, setupPromise = null;
  const hostPath = join(protectedStore.rootPath, 'UsageMonitorXImport.exe');
  const registration = registrationOverride ?? createXImportRegistration({ rootPath: protectedStore.rootPath, windowsDirectory: process.env.SystemRoot, run: execFile });
  async function setup() {
    if (!setupPromise) setupPromise = (async () => {
      const assets = Object.fromEntries(await Promise.all(X_IMPORT_ASSETS.filter(name => name !== 'native-host.json')
        .map(async name => [name, await readFile(join(sourceDirectory, name))])));
      assets['native-host.json'] = Buffer.from(JSON.stringify({ name: X_IMPORT_HOST, description: 'Rhetrion X session import', path: hostPath, type: 'stdio', allowed_origins: [X_IMPORT_ORIGIN] }));
      return createXImportSetup({ store: protectedStore, assets,
        isMissing: error => isWindowsProtectedStateStoreError(error) && error.code === 'windows_protected_state_store_missing',
        registerHost: () => registration.register(), verifyHost: () => registration.verify() });
    })().catch(error => { setupPromise = null; throw error; });
    return setupPromise;
  }
  const stop = () => {
    channel?.destroy(); channel = null;
    const old = child; child = null; starting = null;
    if (old?.pid && old.exitCode === null) {
      exiting = new Promise(resolve => { old.once('exit', resolve); old.once('error', resolve); });
      old.kill();
    }
  };
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
      protectedStore.inspect('UsageMonitorXImport.exe');
      const expected = await readFile(join(sourceDirectory, 'UsageMonitorXImport.exe'));
      const installed = protectedStore.read('UsageMonitorXImport.exe').data;
      if (!Buffer.from(installed).equals(expected)) throw new Error('x_import_unavailable');
      const pipe = `UsageMonitor.XControl.${randomBytes(16).toString('hex')}`;
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
        channel.on('error', cause => { clearTimeout(timeout); reject(new Error('x_import_unavailable', { cause })); });
        channel.once('close', () => { clearTimeout(timeout); reject(new Error('x_import_unavailable')); });
      });
    })().catch(cause => { stop(); code = 'bridge_unavailable'; throw new Error('x_import_unavailable', { cause }); });
    return starting;
  }
  function status() { return Object.freeze({ configured, code, ...gate.status(), extensionId: X_IMPORT_EXTENSION_ID, extensionDirectory: configured ? protectedStore.rootPath : null }); }
  return Object.freeze({
    async configure() {
      if (disposed) return status();
      if (configuring) return configuring;
      const action = ++actionGeneration; gate.cancel(); stop(); configured = false; code = 'not_configured';
      configuring = (async () => {
        try {
          await exiting;
          const prepared = await (await setup()).prepare({ explicit: true, isCurrent: () => action === actionGeneration && !disposed });
          if (!prepared.ready || action !== actionGeneration || disposed) return status();
          configured = true; await start();
        } catch { if (action === actionGeneration && !disposed) { configured = false; code = 'bridge_unavailable'; stop(); } }
        return status();
      })().finally(() => { configuring = null; });
      return configuring;
    },
    async begin() {
      // A setup completion may re-arm the still-selected login through IPC.
      // Never create a late permit after waiting for an independently cancelled
      // setup operation.
      if (configuring || disposed) return status();
      const action = ++actionGeneration;
      try {
        const prepared = await (await setup()).prepare({ isCurrent: () => action === actionGeneration && !disposed });
        if (action !== actionGeneration || disposed) return status();
        if (!prepared.ready) { configured = false; code = prepared.code; return status(); }
        await start(); if (action === actionGeneration && !disposed) { gate.begin(); code = 'import_ready'; }
      }
      catch { if (action === actionGeneration && !disposed) code = 'bridge_unavailable'; }
      return status();
    },
    async reveal() {
      if (disposed || typeof revealFolder !== 'function' || !(await setup()).verify()) throw new Error('x_import_unavailable');
      await revealFolder(join(protectedStore.rootPath, 'manifest.json'));
      return { ok: true };
    },
    cancel() { actionGeneration++; gate.cancel(); if (configured) code = 'bridge_ready'; return status(); },
    status,
    dispose() { disposed = true; actionGeneration++; gate.dispose(); stop(); },
  });
}
