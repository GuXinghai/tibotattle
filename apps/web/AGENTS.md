# Web surface guidance

Scope: all files under `apps/web/`. Apply the repository root guidance first.

## Presentation boundary

- Web code presents validated companion or hosted-service contracts. It does not
  parse raw provider logs, calculate an independent ledger, infer identity, or
  redefine schema semantics.
- The only active web surface is the local dashboard. The cloud site and
  operator pages are retired; do not recreate hosted entrypoints implicitly.
- Local/offline rendering must not require a CDN, analytics, telemetry, remote
  font, or hosted API. Any permitted hosted request belongs to an explicit
  capability with a truthful unavailable state.

## Evidence UX

- Render unknown, unavailable, stale, partial, unattributed, indexing, connecting,
  cancelled, and failed data distinctly. Do not use zero, blank space, a smooth
  continuation, or synthetic values to conceal a coverage gap.
- Preserve source, coverage, freshness, account scope, pricing basis, uncertainty,
  and platform availability when those qualify a value or claim.
- Never ship dummy production data. Fixtures and state labs stay visibly isolated
  from runtime data paths.
- Keep interaction state stable across tabs, refreshes, retries, and responsive
  layouts. Avoid layout movement that changes comparison baselines or implies a
  data change.
- Maintain keyboard access, focus order, semantics, reduced-motion behavior,
  contrast, localization expansion, regional formatting, and narrow-screen
  readability as product requirements.
- Use the canonical i18n and telemetry mirrors. Edit their source and regenerate;
  do not patch checked-in browser mirrors directly.

## Safety and validation

- Escape untrusted text and prefer DOM APIs that do not interpret HTML. Keep
  credentials, opaque capabilities, identifiers, paths, and raw errors out of
  markup, URLs, storage, clipboard text, and screenshots.
  The owner-approved cache-drop **Thread name** links and Projects & threads
  display (2026-09-08) are narrow exceptions
  for transient local UI names, project basenames and canonical Codex UUID links;
  the owner additionally approved bounded Codex title fallbacks exclusively for
  Projects & threads local display on 2026-09-08. Render them as text only;
  project/worktree join handles remain process-local and content-free. Never propagate
  them to accounting DTOs, reports, diagnostics, or contributions.
- Preserve restrictive network and content-security assumptions. A local preview
  convenience must not weaken the packaged or public surface.
- Electron is the main app and uses the shared dashboard. Preserve its existing collection and Settings through their current owners. Desktop community sharing was removed on 2026-10-13 ([decision](../../docs/decisions/2026-10-13-desktop-sharing-removal.md)).
  Preserve saved sharing opt-outs and owner-only hosted erasure; retired social
  sign-in and disconnect flows belong to legacy backend contracts, not this UI.
- Run the narrow `apps/web/test/*.test.mjs` files while iterating, then
  `pnpm run product:ui:test` and the relevant local gate for API changes.
- Inspect the rendered result at representative widths and in the actual target
  surface using real-system data. Validate loading, sparse, error, retry,
  localization, and accessibility states, not only the populated happy path.
- Browser QA does not establish WKWebView/native readiness, an installed bundle,
  or a public deployment. Report those gates separately.
