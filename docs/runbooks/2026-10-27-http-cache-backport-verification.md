---
title: HTTP cache downstream backport verification
date: 2026-10-27
type: runbook
status: maintained
---

# HTTP cache downstream backport verification

This replaces the expired [0.1.27 advisory exception](../decisions/2026-10-03-v0-1-27-http-cache-advisory-exception.md).
It grants no vulnerability suppression, publication or release qualification.
The former exception expired on 2026-10-10; its expiry is not renewed.

The root pnpm build chain now resolves `cacheable-request@7.0.4` to
`http-cache-semantics@4.3.0` with a narrowly scoped downstream backport of
[upstream commit 14a8c2ad](https://github.com/kornelski/http-cache-semantics/commit/14a8c2ad51740dc39bf3e8f1a11c845a5003f217).
The [published 4.3.0 source](https://github.com/kornelski/http-cache-semantics/blob/b1d4bd682fbab0252985de45219f4e7497c0067c/index.js)
does not contain this mitigation. Neither its version number nor the range in
[GHSA-ch52-4w7c-c8xp](https://github.com/advisories/GHSA-ch52-4w7c-c8xp)
establishes that the upstream release fixed the behavior.

## Exact source boundary

`config/patches/http-cache-semantics@4.3.0.patch` changes only the response-reuse
restriction gate and its shared helper. It retains 4.3.0's Vary normalization
and response-status behavior. Patch files must have LF line endings before
installation: pnpm normalizes the patch hash but can insert the patch's actual
line endings, so a mixed-line-ending installation is not the reviewed artifact.

The reviewed LF patch SHA-256 and pnpm patch hash are both
`94ecd9492e12512d8de3feef07eb3f98fbf82d55c6c0332612f2f1b919bec2ae`.
The actual installed consumer `index.js` SHA-256 is
`59d8952163820dc7ed24a1839eae7ee372ecb1a85d909fdad67b7cdac95f8a67`.
The canonical pins live in `scripts/check-http-cache-backport.mjs`.

## Verification and failure behavior

Use the repository-pinned pnpm version with the root lockfile. For dependency
inspection, install in a disposable source snapshot with a fresh isolated
store, `--frozen-lockfile --ignore-scripts`, and no inherited user configuration.
Do not reuse a store populated from a differently encoded patch to establish
the exact installed-byte proof.

`node scripts/check-http-cache-backport.mjs` performs no network operation. It
checks the root lock/config/patch bindings, follows the real
`electron-builder → app-builder-lib → @electron/get → got → cacheable-request`
resolution chain, checks the installed source bytes and downloader cache default,
and runs content-free policy regressions. The owning tests additionally cover
loopback-only consumer reuse/revalidation, allowed cache paths, Vary matching,
tampered inputs, and scanner shell failure propagation. Run them through
`scripts/run-isolated-tests.mjs`, not against real account or provider data.

Restricted shared-cookie, proxy-revalidate, no-cache, no-store and private
responses must not be reused through a client max-stale request. Must-revalidate
remains a hard refusal. Ordinary fresh/stale, explicit public-cookie and private
cache behavior remain covered separately. Vary mismatch and whitespace-padded
Vary-star must still refuse a hit.

`osv-scanner.toml` has no ignored vulnerabilities or package overrides. The OSV
workflow keeps its checksum-pinned scanner binary and direct invocation, so
download, checksum, operational and vulnerability failures remain failures.
The backport guard does not turn a future scanner finding into an exception.
Local synthetic proof is distinct from an actual OSV scan, hosted CI, packaging,
installed Windows, signing, updater and release evidence.
