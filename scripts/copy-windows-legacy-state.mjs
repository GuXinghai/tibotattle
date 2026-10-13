import { pathToFileURL } from 'node:url';
import {
  copyWindowsLegacyState, classifyWindowsLegacyStateMigrationFailure,
  loadWindowsLegacyStateReadBinding,
} from '../src/platform/index.js';

export function parseWindowsLegacyStateCopyArguments(args) {
  const result = { mode: 'dry-run' };
  const keys = new Map([['--source-root', 'sourceRoot'], ['--destination-root', 'destinationRoot']]);
  for (let index = 0; index < args.length; index += 1) {
    const key = keys.get(args[index]);
    if (key && !Object.hasOwn(result, key) && args[index + 1] && !args[index + 1].startsWith('--')) {
      result[key] = args[++index];
    } else if (['--copy', '--resume'].includes(args[index]) && result.mode === 'dry-run') {
      result.mode = args[index].slice(2);
    } else throw new Error('legacy_state_copy_arguments');
  }
  if (!result.sourceRoot || !result.destinationRoot) throw new Error('legacy_state_copy_arguments');
  return result;
}

export function runWindowsLegacyStateCopy(args, { loadBinding = loadWindowsLegacyStateReadBinding,
  write = text => process.stdout.write(`${text}\n`) } = {}) {
  let options;
  try { options = parseWindowsLegacyStateCopyArguments(args); }
  catch { write('legacy_state_copy_arguments'); return 1; }
  try {
    const result = copyWindowsLegacyState({ ...options, binding: loadBinding() });
    write(JSON.stringify(result)); return 0;
  } catch (error) {
    write(classifyWindowsLegacyStateMigrationFailure(error)); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = runWindowsLegacyStateCopy(process.argv.slice(2));
}
