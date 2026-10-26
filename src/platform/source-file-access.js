import {
  loadWindowsSourceReadBinding,
  WINDOWS_SOURCE_READ_CONTRACT,
} from './windows-filesystem.js';

const NATIVE_READ_BYTES = 64 * 1024;
const safe = (ok, code) => { if (!ok) throw new Error(code); };

// Common source-handle port for positional readers. Native implementation
// details do not change buffer sizes or parser behavior in its consumers.
export function createSourceFileAccess({ platform = process.platform,
  loadWindowsBinding = loadWindowsSourceReadBinding } = {}) {
  safe(platform === 'win32', 'unsupported_platform');
  const native = loadWindowsBinding();
  return Object.freeze({
    contractVersion: WINDOWS_SOURCE_READ_CONTRACT,
    inspectPath(path) {
      safe(typeof native.inspectPath === 'function', 'source_metadata_unavailable');
      return native.inspectPath(path);
    },
    async open(path) {
      const lease = native.openSourceFile(path);
      let closed = false;
      return Object.freeze({
        async stat() {
          safe(!closed, 'source_file_closed');
          const stat = native.statSourceFile(lease);
          // isFile matches FileHandle consumers. Native code validates owner,
          // regular-file type and link count on this exact held handle.
          return { ...stat, isFile: () => true, isSymbolicLink: () => false };
        },
        async read(buffer, offset, length, position) {
          safe(!closed, 'source_file_closed');
          safe(buffer instanceof Uint8Array && Number.isSafeInteger(offset) && offset >= 0
            && Number.isSafeInteger(length) && length >= 0 && offset + length <= buffer.length
            && Number.isSafeInteger(position) && position >= 0
            && Number.isSafeInteger(position + length), 'invalid_source_read');
          let bytesRead = 0;
          while (bytesRead < length) {
            const requested = Math.min(NATIVE_READ_BYTES, length - bytesRead);
            const data = native.readSourceFile(lease, position + bytesRead, requested);
            safe(Buffer.isBuffer(data) && data.length <= requested, 'invalid_source_read');
            buffer.set(data, offset + bytesRead); bytesRead += data.length;
            if (data.length < requested) break;
          }
          return { bytesRead, buffer };
        },
        async close() { if (!closed) { closed = true; native.closeSourceFile(lease); } },
      });
    },
    // The native lease pins the source and its ancestors until close.
    namedStat: (_path, handle) => handle.stat(),
  });
}
