# Rhetrion support

Rhetrion is unpublished. No external support, download or private reporting
channel is configured. Former project services are not support endpoints for
this product. See the [current status](docs/current-status.md).

For local troubleshooting, record the app/source version, Windows version and
architecture, the action, expected behavior and fixed failure code. Review
**Settings → General → Local tools → Show diagnostics** and copy only its
content-free report. The app does not open an external issue form. Native crash
reports may contain private data; do not share them as ordinary diagnostics.

From a source checkout, `pnpm run diagnose:dashboard` inspects dashboard state.
Review output before sharing. Never publish prompts, responses, credentials,
account identifiers, private repository names, session paths or raw local files.
Screenshots also need review for private data.

Preserve original state on an indexing, SQLite, AppData or credential failure.
Do not delete the only database, wipe AppData, downgrade a schema, reset salts,
rotate credentials or revoke devices to make an error disappear.
Use [safe local recovery](docs/runbooks/local-index-recovery.md).

The supported product scope is Windows x64. Local analysis works offline;
source, native, GUI, packaged, installed and signed-release evidence remain
separate. Missing or unqualified prerequisites are reported explicitly.
Codex is the only supported usage provider. Existing immutable legacy records
may appear as historical readback; Claude integrations and new collection are
not supported. Existing Claude profiles, settings and credentials are outside
the product's cleanup or uninstall scope.
Provider billing and authoritative quota questions belong with the provider;
this app reports observations and estimates.
