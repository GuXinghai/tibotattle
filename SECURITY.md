# Security Policy

## Reporting a vulnerability

Please report vulnerabilities privately through
[GitHub Security Advisories on this repository](https://github.com/adamallcock/tibotattle/security/advisories/new).
Do not open a public issue for a security problem.

You should receive an acknowledgement within a few days. There is **no bounty
program**; reports are handled on a best-effort basis by the maintainer.

## Supported versions

Security fixes target the latest published stable release and current source.
Older releases may be investigated, but users should expect to upgrade to the
latest stable build for a fix. Development and preview builds are test
artifacts, not supported distribution channels. The current release and
platform availability are recorded on the
[GitHub Releases page](https://github.com/adamallcock/tibotattle/releases) and
in the [current status matrix](docs/current-status.md).

## Scope

Two distinct surfaces share this repository:

- **Local Windows app** (`apps/electron`, `apps/local`, `apps/web`, `src/`,
  `packages/`): runs entirely on your machine, binds to loopback only, and
  works fully offline. Issues that break the privacy model — unintended network transmission of usage data, prompts/responses/paths entering derived
  artifacts, loopback exposure — are in scope and treated as high priority.
- **Hosted contribution service** (`apps/worker`, served at
  [tibotattle.com](https://tibotattle.com)): operated by the maintainer.
  Issues affecting the hosted aggregates, contributor pseudonymity, or the
  upload, disconnect, private owner-erasure, or deletion-safe restore boundaries
  are in scope. Please do not run disruptive
  testing (load, enumeration, or exhaustion) against the live service.

Current source retires self-service `DELETE /api/v1/me`: it must return
`404 NOT_FOUND` without participant mutation. Private participant erasure is
confined to the existing Access-owner and CSRF-protected admin maintenance
boundary. Ordinary maintenance must not start erasure without its explicit
target and confirmation. A bypass of either boundary, raw identifiers in the
audit, or resurrection after restore is a security issue. This source contract
does not establish deployment or a new privacy-request reporting channel.

The local refresh reads selected Codex session folders, local Codex
configuration and lineage state, the installed Codex app-server account/quota
methods, and owner-only derived state. Undisclosed source access, retention of prompt/response content, unsafe derived artifacts, or unintended network transmission is in scope.

The desktop app is local-only and sends no usage data. Community sharing, contribution upload, and hosted sign-in were removed on 2026-10-13 ([decision](docs/decisions/2026-10-13-desktop-sharing-removal.md)). The earlier [accountless Electron sharing policy](docs/decisions/2026-09-04-accountless-sharing-policy.md) is historical.

The interactive local cache-drop tables also resolve explicit display names,
worker nicknames, and parent links from bounded read-only Codex thread metadata
and `session_index.jsonl`. This is a separate, same-origin, non-persisted lookup;
names and raw thread IDs are excluded from accounting caches, reports,
diagnostics, and contributions. It never uses the prompt-bearing `threads.title`
as a display-name fallback. A clicked canonical Codex deep link stays a local
application handoff.

The owner-approved Projects & threads view (2026-09-08) also reads the explicit
working directory from bounded, retained session metadata, turn-context records
and applied thread settings. It uses the
existing discovery and stable-source reader, then local read-only Git resolution.
The owner also approved bounded Codex `threads.title` fallbacks for this view
on 2026-09-08 when explicit names are missing. Titles can contain opening-message
text, so they are read only for displayed rows and their parents, rendered as
text, and never exported or uploaded. Ancestry-only reads and cache-drop tables
retain their title-free contract.
Directory basenames and thread display labels are transient metadata. Names and
project handles are excluded from persisted accounting, exports, diagnostics,
contributions and browser storage. Under the accepted
[local index v2 decision](docs/decisions/2026-10-12-local-index-v2-and-local-paths.md)
current source uses the owner-only v2 local store to retain source paths and
working directories. Those paths never enter exports, diagnostics, contributions
or browser storage and never leave the machine. Source cutover does not prove an
installed release has adopted v2. Repository grouping describes
last-observed local workspace mappings, not verified historical ownership.
Transient metadata uses the approved native source reader's current-owner,
single-link and reparse-point checks.
Existing SQLite files are held through connection close; metadata never changes
source permissions or journal mode. Selected rollout-head reads use the same
boundary and never read titles. Closed databases
without sidecars use immutable reads with file-state revalidation; live WAL
reads require existing WAL/SHM files and may update SHM coordination bytes.
Missing or unsafe native access preserves
anonymous fallback labels. A saved, unambiguous Codex repository origin may
supply project grouping when Git is absent from the app's executable search
path; a current Git rejection is not overridden by that historical observation.
The new POST query route requires the local header and existing Origin/Host
checks. Interactive reports are bounded process-local snapshots;
publication/scope/filter identity and opaque cursors prevent mixing totals across
reads. A separate owner-only saved snapshot retains usage figures with anonymous,
snapshot-local aliases. It excludes names, raw thread IDs, source paths and
original project/worktree/thread join handles. Restored figures are read-only and
dated until fresh enrichment completes; they never become a name-search index.

## Do not include session content in reports

TiboTattle's whole purpose is keeping coding-agent session content private.
**Never include prompts, model responses, or real file paths from Codex
sessions in a security report.** Reproduce with redacted or synthetic data;
if the issue genuinely requires real session evidence, say so in the private
advisory and the maintainer will arrange a safe way to verify.

## Verify a release

For a specific published release, its checksum, platform signature, SBOM, and
any build attestation establish different parts of the distribution chain.
Follow [Verify a TiboTattle release](docs/verify-release.md) for the exact
commands and the current Windows availability boundary. The
GitHub release is canonical for the v1 manifest, any non-null SBOM, and any
non-null attestation bundles; the website exposes download availability and
digest. A v1 artifact may explicitly set `sbom`, `sbom.attestation`, or
`provenance` to `null`, meaning that evidence was not published. A checksum
confirms exact bytes; it is not, by itself, a safety or source-provenance claim.
Source-to-binary provenance is claimed only when a trusted hosted workflow
generated/finalized and cryptographically verified the exact final bytes for
that release.

For non-security troubleshooting, use [SUPPORT.md](SUPPORT.md). Security
Advisories are the only private reporting channel documented by this project;
do not send secrets or private session material through public issues.
