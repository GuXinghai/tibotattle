import { exportSetChunkBasenames } from "./set-schema.js";

/**
 * Runtime-neutral names shared by the deletion planner and durable owner.
 * These values deliberately contain no paths supplied by callers.
 */
export const EXPORT_DELETION_JOURNAL_BASENAME = ".app-usagemonitor-deletion-journal.json";
export const EXPORT_DELETION_COMMIT_MARKER_BASENAME = ".app-usagemonitor-deletion-commit.json";
export const EXPORT_DELETION_RECEIPT_BASENAME = "local-export-deletion-receipt.json";

export const EXPORT_DELETION_WORKSPACE_LOCK_BASENAME = ".app-usagemonitor-export-workspace.lock";
export const EXPORT_DELETION_DESTINATION_LOCK_BASENAME = ".app-usagemonitor-export.lock";
export const EXPORT_DELETION_DESTINATION_TRANSACTION_BASENAME = ".app-usagemonitor-export-transactions";
export const EXPORT_DELETION_QUARANTINE_PREFIX = ".app-usagemonitor-deletion-quarantine-";

/** Filename resolution only for a validated, already-committed deletion journal.
 * This does not validate, read, resume or convert a predecessor export payload.
 */
export function exportDeletionJournalChunkBasenames(index, manifestVersion) {
  const names = exportSetChunkBasenames(index);
  if (manifestVersion === "usage-export-set-manifest-v0.1") {
    return Object.freeze({ ...names, bundle: names.bundle.slice(0, -3) });
  }
  if (["usage-export-set-manifest-v0.2", "usage-export-set-manifest-v0.3"].includes(manifestVersion)) {
    return names;
  }
  return exportSetChunkBasenames(index, manifestVersion);
}
