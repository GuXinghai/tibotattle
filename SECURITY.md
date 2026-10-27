# Security Policy

This unpublished local product has no configured private vulnerability-reporting
channel. Do not use former project contacts or post private evidence publicly.
Do not send credentials, raw account identifiers, prompts, responses or session
paths. Use synthetic, content-free reproductions and preserve original state.

## Scope

The local Windows x64 app, loopback companion, dashboard, packages and native
filesystem/credential boundary are in scope. Local analysis must work offline.
Unintended network transmission, non-loopback exposure, unsafe paths/ACLs,
credential prompts, schema downgrades and private content entering derived
artifacts are security failures.

There is no cloud project, public download, signing account or update feed
configured here. This source change does not administer or erase former remote
services. Saved consent, opt-outs, salts, identities and receipts remain intact.
The optional X reader has its own protected browser session and does not transmit
local usage evidence.

Ordinary validation uses the isolated test runner with disposable synthetic
home, application-state, and Codex directories. It removes inherited native
credential qualification from test children. Environment isolation is not a
sandbox for arbitrary test code: direct native credential operations belong only
to a separately authorized hosted qualification gate. Never inspect or roll back
real user state to validate a test-isolation repair.

The local refresh reads selected Codex session folders, local Codex
configuration and lineage state, the installed Codex app-server account/quota
methods, and owner-only derived state. Undisclosed source access, retention of prompt/response content, unsafe derived artifacts, or unintended network transmission is in scope.

Codex is the only supported usage provider. Claude Code/Desktop collection,
transcript ingestion, callbacks, pricing and related UI are retired. This source
change does not inspect or modify existing Claude profiles, settings, ledgers,
callback state or credentials; it does not authorize uninstall or cleanup.
Already-retained immutable legacy records may be read back only as historical
evidence, not as active provider support. See the
[Codex-only provider decision](docs/decisions/2026-10-27-codex-only-product.md).

Desktop usage analysis stays local and sends no usage data. Community sharing, contribution upload, and Rhetrion hosted sign-in were removed on 2026-10-13 ([decision](docs/decisions/2026-10-13-desktop-sharing-removal.md)). The optional [X reader](docs/decisions/2026-10-20-optional-x-reader.md) uses a separate authenticated session and protected public-post cache; its network requests do not contain local usage data. The earlier [accountless Electron sharing policy](docs/decisions/2026-09-04-accountless-sharing-policy.md) is historical.

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
installed release has adopted v2. Project grouping follows explicit Codex
assignments and verified collaboration parents, including non-Git projects.
The bounded global-state reader projects only local-projects,
thread-project-assignments and projectless-thread-ids. Missing or conflicting
ownership stays Unassigned. Git may enrich worktree labels; it does not determine
project ownership. These are current observed assignments, not verified
historical ownership. See the
[project-membership decision](docs/decisions/2026-10-27-codex-project-membership.md).
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

## Recovery and evidence

Never wipe application state, rotate identities, relabel database versions or
weaken ACL/credential checks to suppress an error. Backup, copy conversion,
validation, activation and recovery are distinct operations. Brand changes do
not authorize access to another profile or credential target.

Native general production/path-walk qualification remains disabled until its
own physical Windows gates pass. Source tests, sidecar hashes, staging and
unsigned local candidates cannot substitute for those gates. Installed artifacts,
signing and publication need fresh exact-byte evidence.

See [local data and privacy](docs/reference/local-data-and-privacy.md),
[local recovery](docs/runbooks/local-index-recovery.md) and [support](SUPPORT.md).
