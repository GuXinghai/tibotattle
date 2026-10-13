import { readCodexLocalThreadMetadata } from "./platform/index.js";

/**
 * Display enrichment for a work-usage snapshot: thread names and Codex links
 * for thread rows, and the project or worktree labels for the other rows. It
 * reads only the snapshot it is given and the shared local thread metadata, so
 * it is independent of the index store.
 */
export async function enrichWorkUsageRows({ result, rows, codexHome, purpose }) {
  const ids = rows
    .filter((r) => r.kind === "thread")
    .map((r) => result.display.threads[r.id]?.uuid)
    .filter(Boolean);
  const names = await readCodexLocalThreadMetadata(codexHome, ids, {
    allowTitleFallback: true,
    forNameSearch: purpose === "search",
  });
  const display = {};
  for (const row of rows) {
    if (row.kind === "thread") {
      const uuid = result.display.threads[row.id]?.uuid;
      display[row.id] = {
        name: names.get(uuid)?.name ?? names.get(uuid)?.nickname ?? null,
        thread: uuid
          ? (names.get(uuid) ?? {
              id: uuid,
              name: null,
              nickname: null,
              parent: null,
            })
          : null,
        shortId: result.display.threads[row.id]?.shortId ?? row.id.slice(-10),
        codexUrl: uuid ? `codex://threads/${uuid}` : null,
      };
    } else
      display[row.id] =
        result.display[row.kind === "project" ? "projects" : "worktrees"][
          row.id
        ] ?? {};
  }
  return display;
}
