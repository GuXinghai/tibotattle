import {
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  writeSync,
} from "node:fs";
import { dirname } from "node:path";

function nodeIdentity(stats) {
  return {
    volumeSerialNumber: BigInt(stats.dev).toString(16).padStart(16, "0"),
    fileId: BigInt(stats.ino).toString(16).padStart(32, "0"),
    linkCount: Number(stats.nlink),
  };
}

function objectKey(identity) {
  return identity.volumeSerialNumber + ":" + identity.fileId;
}

function asNativeStats(stats) {
  const identity = nodeIdentity(stats);
  return {
    dev: identity.volumeSerialNumber,
    ino: identity.fileId,
    size: Number(stats.size),
    nlink: identity.linkCount,
    uid: typeof process.getuid === "function" ? process.getuid() : undefined,
    mode: Number(stats.mode),
    isFile: () => stats.isFile() || stats.isSymbolicLink(),
    isSymbolicLink: () => stats.isSymbolicLink(),
  };
}

function isOwnerOnly(acl) {
  return acl.ownerMatches === true
    && acl.nullDacl === false
    && acl.broadAccess === false
    && acl.nonOwnerAllow === false
    && acl.unrecognizedAce === false;
}

// Test-only contract adapter over caller-owned temporary fixtures. Its ACL
// facts are synthetic and do not qualify the installed Windows native binding.
export function createSyntheticWindowsExportProtection() {
  const aclByIdentity = new Map();
  const counters = { directoryEnsures: 0, fileCreates: 0, opens: 0, reads: 0 };

  function inspectPath(path) {
    const stats = lstatSync(path, { bigint: true });
    const identity = nodeIdentity(stats);
    const link = stats.isSymbolicLink();
    const acl = aclByIdentity.get(objectKey(identity)) ?? {
      ownerMatches: true,
      nullDacl: false,
      daclProtected: !link,
      broadAccess: false,
      nonOwnerAllow: false,
      unrecognizedAce: false,
    };
    return Object.freeze({
      identity,
      isDirectory: stats.isDirectory(),
      isRegularFile: stats.isFile() || link,
      isReparsePoint: link,
      ...acl,
      finalPathResolved: true,
    });
  }

  function rememberPrivate(path) {
    const metadata = inspectPath(path);
    aclByIdentity.set(objectKey(metadata.identity), {
      ownerMatches: true,
      nullDacl: false,
      daclProtected: true,
      broadAccess: false,
      nonOwnerAllow: false,
      unrecognizedAce: false,
    });
    return metadata.identity;
  }

  const filesystem = Object.freeze({
    inspectPath,
    ensureDirectory(path) {
      counters.directoryEnsures += 1;
      let existing = null;
      try { existing = inspectPath(path); }
      catch (error) { if (error?.code !== "ENOENT") throw error; }
      if (existing) {
        if (!existing.isDirectory || existing.isReparsePoint || !isOwnerOnly(existing)) {
          throw new Error("synthetic_acl_rejected_existing_directory");
        }
        return existing.identity;
      }
      mkdirSync(path, { recursive: true, mode: 0o700 });
      return rememberPrivate(path);
    },
    createFile(path, bytes) {
      counters.fileCreates += 1;
      const parent = inspectPath(dirname(path));
      if (!parent.isDirectory || parent.isReparsePoint || !isOwnerOnly(parent)) {
        throw new Error("synthetic_acl_rejected_parent");
      }
      const descriptor = openSync(path, "wx", 0o600);
      try {
        if (bytes.byteLength > 0) writeSync(descriptor, bytes);
      } finally {
        closeSync(descriptor);
      }
      return rememberPrivate(path);
    },
  });

  const sourceAccess = Object.freeze({
    contractVersion: "windows-source-read-v1",
    inspectPath,
    async open(path) {
      const metadata = inspectPath(path);
      if (!metadata.isRegularFile || metadata.isReparsePoint
          || metadata.identity.linkCount !== 1 || metadata.ownerMatches !== true) {
        throw new Error("synthetic_source_lease_rejected");
      }
      counters.opens += 1;
      const descriptor = openSync(path, "r");
      let closed = false;
      return Object.freeze({
        async stat() {
          if (closed) throw new Error("synthetic_source_lease_closed");
          return asNativeStats(fstatSync(descriptor, { bigint: true }));
        },
        async read(buffer, offset, length, position) {
          if (closed) throw new Error("synthetic_source_lease_closed");
          counters.reads += 1;
          const bytesRead = readSync(descriptor, buffer, offset, length, position);
          return { bytesRead, buffer };
        },
        async close() {
          if (closed) return;
          closed = true;
          closeSync(descriptor);
        },
      });
    },
  });

  return Object.freeze({
    filesystem,
    sourceAccess,
    counters,
    grantEveryoneRead(path) {
      const metadata = inspectPath(path);
      const existing = aclByIdentity.get(objectKey(metadata.identity)) ?? metadata;
      aclByIdentity.set(objectKey(metadata.identity), {
        ownerMatches: existing.ownerMatches,
        nullDacl: existing.nullDacl,
        daclProtected: existing.daclProtected,
        broadAccess: true,
        nonOwnerAllow: true,
        unrecognizedAce: existing.unrecognizedAce,
      });
    },
    grantOwnerOnly(path) {
      rememberPrivate(path);
    },
    inspectPath,
  });
}
