import { win32 } from 'node:path';
import { X_IMPORT_HOST } from './contract.js';

// Explicit configure writes only this fixed per-user Chrome host. Routine
// approved upgrades use verify(), which never writes the registry.
export function createXImportRegistration({ rootPath, windowsDirectory, run }) {
  const registry = win32.join(windowsDirectory, 'System32', 'reg.exe');
  const key = `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${X_IMPORT_HOST}`;
  const expected = win32.join(rootPath, 'native-host.json');
  const options = { windowsHide: true, timeout: 10000, maxBuffer: 16384 };
  async function matches(view) {
    try {
      const { stdout } = await run(registry, ['QUERY', key, '/ve', `/reg:${view}`], options);
      const values = String(stdout).split(/\r?\n/u).flatMap(line => {
        const m = line.match(/^\s*.+?\s+REG_SZ\s+(.+?)\s*$/u); return m ? [m[1]] : [];
      });
      return values.length === 1 && win32.normalize(values[0]).toLowerCase() === win32.normalize(expected).toLowerCase();
    } catch { throw new Error('x_import_registration_unavailable'); }
  }
  return Object.freeze({
    async verify() { return await matches('32') && await matches('64'); },
    async register() {
      for (const view of ['32', '64']) {
        await run(registry, ['ADD', key, '/ve', '/t', 'REG_SZ', '/d', expected, '/f', `/reg:${view}`], options);
        if (!await matches(view)) throw new Error('x_import_registration_unavailable');
      }
    },
  });
}
