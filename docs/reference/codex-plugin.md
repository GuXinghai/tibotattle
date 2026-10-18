---
title: Codex plugin and installed agent interface
date: 2026-09-12
type: reference
status: maintained
---

# Codex plugin and installed agent interface

The repository packages a self-contained Codex plugin at
`plugins/tibotattle`. It contributes one usage-coach skill and a local stdio
MCP server. The plugin never parses Codex sessions or owns a second ledger; it
calls the installed Electron application's versioned, read-only agent interface,
which delegates analysis to the existing local usage explainer.

The public 0.1.23 release includes the agent protocol v1 source contract.
The plugin checks the installed application's protocol handshake before using
it; a version number alone does not establish compatibility. Version 0.1.22
remains incompatible. A successor must pass its own packaged and installed protocol checks.

## Agent data flow

```text
Codex host model
  -> bundled usage-coach skill
  -> local TiboTattle MCP server (stdio)
  -> packaged Electron companion --agent-protocol 1
  -> existing unified index and usage-explainer service (read-only)
```

Only the deterministic explainer reads private local evidence. Its compact
responses remain content-free and preserve unavailable, stale, partial and
unknown states. The host model interprets those facts and proposes measurable
experiments; TiboTattle does not embed or call an LLM.

## Tools

| Tool | Effect |
| --- | --- |
| `tibotattle_status` | Read installation compatibility and local data health. |
| `tibotattle_list_plans` | Read the live plan, pagination and claim contract. |
| `tibotattle_explain_usage` | Run one bounded plan; pass `nextCursor` unchanged to page. |
| `tibotattle_get_evidence` | Resolve one opaque evidence selector. |

The tools above are read-only and do not fetch release metadata. The plugin does
not install or upgrade the app; its legacy Homebrew installation tools have
been removed. Windows x64 is the only supported product platform, but the
plugin's remaining installed-agent discovery still uses the legacy bundle
adapter and returns unsupported on Windows. Windows discovery and packaged
plugin qualification remain open; this document does not claim the current
plugin is usable against an installed Windows app. The legacy adapter does not
establish macOS product support.

When more than one installed copy of the app is present, the plugin verifies each
installed version and selects the latest semantic version before checking agent
compatibility. It never falls back to an older app merely because that copy
exposes the protocol. Status reports the number of detected installations without
returning their filesystem paths.

## Installed Electron protocol v1

The packaged companion entrypoint reserves `--agent-protocol 1` followed by one
of four commands: `status`, `explain-usage-plans`, `explain-usage`, or
`explain-usage-evidence`. It accepts only the plan, period, page limit, opaque
cursor and opaque selector options required by the explainer. It does not expose
arbitrary SQL, filesystem paths, shell commands, refresh, settings or upload.

For maintainers, a production Windows status probe has this shape, where the
placeholders are the installed executable and its packaged `app.asar`:

```text
ELECTRON_RUN_AS_NODE=1 \
  "<installed TiboTattle executable>" \
  "<installed app.asar>/apps/local/server.js" \
  --agent-protocol 1 status
```

Standard output is exactly one bounded JSON record. Expected errors use fixed
content-free codes; unexpected exceptions are not echoed. Normal companion
startup remains unchanged when `--agent-protocol` is absent.

## Local plugin development

The repository marketplace descriptor is `.agents/plugins/marketplace.json`.
After validating the plugin, add this repository as a local marketplace and
install `tibotattle@tibotattle-local` with the Codex plugin commands. Installing
the plugin and installing the desktop app are distinct actions. A new Codex task
is required after plugin installation or update so its skills and tools reload.

Do not publish the plugin, install a production application, or treat a
development bundle as release evidence without the corresponding explicit
authorization and release gates.
