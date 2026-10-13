import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import * as pathApi from 'node:path';
import { loadWindowsSourceReadBinding } from './windows-filesystem.js';
import { createSourceFileAccess } from './source-file-access.js';
import { acquireProtectedSqliteFiles } from './windows-protected-sqlite.js';

const safe = (ok, code) => { if (!ok) throw new Error(code); };

// The injected loader is for portable/native qualification tests. Production
// always uses the manifest-verified, approved Windows capability loader.
export function createTimingFilesystem({ platform = process.platform,
  loadWindowsBinding = loadWindowsSourceReadBinding } = {}) {
  safe(platform === 'win32', 'unsupported_platform');
  const native = loadWindowsBinding();
  const sources = createSourceFileAccess({ platform, loadWindowsBinding: () => native });
  return {
    openSource: path => sources.open(path),
    namedStat: sources.namedStat,
    async prepare(directory) {
      const dir = resolve(directory), file = join(dir, 'timing-experiment.sqlite');
      const lease = acquireProtectedSqliteFiles({ native, path: file, pathApi });
      const { created } = lease;
      try {
        for (const suffix of ['-wal', '-shm']) {
          let missing = false;
          try { native.inspectPath(`${file}${suffix}`); } catch (e) {
            if (e.code !== 'WINDOWS_FILESYSTEM_NOT_FOUND' && e.code !== 'ENOENT') throw e;
            missing = true;
          }
          safe(missing, 'unsafe_journal_mode');
        }
        if (!created) {
          // The guarded name cannot be replaced during this bounded header read.
          const h = await open(file, constants.O_RDONLY);
          try {
            const header = Buffer.alloc(20);
            const { bytesRead } = await h.read(header, 0, 20, 0);
            safe(bytesRead === 20 && header.subarray(0, 16).toString() === 'SQLite format 3\0'
              && header[18] === 1 && header[19] === 1, 'incompatible_database');
          } finally { await h.close(); }
        }
      } catch (e) {
        try { lease.release(); } catch { /* Keep the validation failure. */ }
        throw e;
      }
      return { file, created, persistentJournal: true, release: lease.release };
    },
  };
}
