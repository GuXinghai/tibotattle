import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, linkSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  copyWindowsLegacyState, createWindowsFilesystemAdapter,
  createWindowsProtectedStateStore,
  loadWindowsLegacyStateReadBinding, classifyWindowsLegacyStateMigrationFailure,
} from '../src/platform/index.js';
import { refreshLocalIndex } from '../src/local-index-refresh.js';
import { createWorkspace, v2Facts } from './helpers/local-index-facts.js';
import { grantSyntheticEveryoneRead, assertWindowsOwnerOnly } from './helpers/windows-owner-only-fixture.js';
import { createDesktopSharingCoordinator, createDesktopSharingBackend } from '../apps/electron/desktop-sharing.js';

test('native ACL recovery copies a real closed v2 store, original salt and persisted opt-out to protected state',
  { skip: process.platform !== 'win32' || process.arch !== 'x64' ? 'native Windows x64 only' : false }, async () => {
    const binding = loadWindowsLegacyStateReadBinding();
    const workspace = createWorkspace({ files: 2, events: 30 });
    const adapter = createWindowsFilesystemAdapter();
    const target = join(workspace.root, 'recovered');
    const store = join(workspace.state, 'local-index-store-v1.sqlite');
    try {
      await refreshLocalIndex({ codexHome: workspace.codexHome, indexFile: store,
        secretFile: workspace.secretFile, workerCount: 1 });
      const facts = v2Facts(store), salt = readFileSync(workspace.secretFile);
      // Close the synthetic writer after the read-only fact query: a read-only
      // WAL connection can leave coordination sidecars that must be refused.
      const db = new DatabaseSync(store); db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); db.close();
      const participant = join(workspace.state, 'export-participant-secret');
      writeFileSync(participant, Buffer.alloc(32, 73).toString('base64url'));
      const settings = join(workspace.state, 'desktop-settings'); adapter.ensureDirectory(settings);
      let text;
      const coordinator = createDesktopSharingCoordinator({ destinationOrigin: 'https://example.test',
        installationState: 'fresh', backend: { load: async () => text ?? null, save: async value => { text = value; } },
        now: () => new Date('2026-10-13T00:00:00.000Z') });
      await coordinator.initialize(); await coordinator.setEnabled(false); coordinator.dispose();
      const preference = join(settings, 'accountless-sharing-v1.json'); writeFileSync(preference, text);
      for (const file of [workspace.state, store, workspace.secretFile, participant, preference]) grantSyntheticEveryoneRead(file);
      const originalAcl = adapter.inspectPath(workspace.secretFile);
      adapter.ensureDirectory(target);
      assert.equal(copyWindowsLegacyState({ sourceRoot: workspace.state, destinationRoot: target, binding }).status, 'planned');
      let interrupted = false;
      assert.throws(() => copyWindowsLegacyState({ sourceRoot: workspace.state, destinationRoot: target, binding,
        mode: 'copy', onCopied() { if (!interrupted) { interrupted = true; throw new Error('synthetic interruption'); } } }));
      assert.equal(copyWindowsLegacyState({ sourceRoot: workspace.state, destinationRoot: target, binding, mode: 'resume' }).status, 'copied');
      assert.deepEqual(readFileSync(join(target, 'local-unified-index-device-salt-v1')), salt);
      assert.deepEqual(readFileSync(join(target, 'export-participant-secret')), readFileSync(participant));
      assert.deepEqual(adapter.inspectPath(workspace.secretFile), originalAcl);
      assertWindowsOwnerOnly(join(target, 'local-index-store-v1.sqlite'));
      assertWindowsOwnerOnly(join(target, 'local-unified-index-device-salt-v1'));
      assert.deepEqual(v2Facts(join(target, 'local-index-store-v1.sqlite')), facts);
      const recovered = createDesktopSharingCoordinator({ destinationOrigin: 'https://example.test', installationState: 'fresh',
        backend: createDesktopSharingBackend({ rootPath: join(target, 'desktop-settings'),
          windowsProtectedStateStore: createWindowsProtectedStateStore({ adapter, rootPath: join(target, 'desktop-settings') }) }),
        now: () => new Date('2026-10-13T00:00:00.000Z') });
      assert.equal((await recovered.initialize()).enabled, false); recovered.dispose();
      assert.deepEqual(readFileSync(workspace.secretFile), salt);
      const linkedTarget = join(workspace.root, 'linked-target'); adapter.ensureDirectory(linkedTarget);
      linkSync(workspace.secretFile, join(workspace.root, 'synthetic-hardlink'));
      assert.throws(() => copyWindowsLegacyState({ sourceRoot: workspace.state, destinationRoot: linkedTarget, binding }),
        error => classifyWindowsLegacyStateMigrationFailure(error) === 'legacy_state_copy_unavailable');
    } finally { workspace.cleanup(); }
  });
