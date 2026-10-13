---
title: Current product and release status
date: 2026-09-27
type: status
status: current
source_commit: 1114fff4843b81e08637f22ed79bcfda605319a8
observation_date: 2026-09-27
---

# Current product and release status

**Platform scope (2026-10-12): Windows x64 only**, under the
[Windows-only decision](./decisions/2026-10-12-windows-only.md). The macOS and
Linux targets published with 0.1.26 are no longer supported; their evidence
below is historical and does not describe a current support or update path.

[TiboTattle 0.1.26](https://github.com/adamallcock/tibotattle/releases/tag/v0.1.26)
was the published Electron release for macOS Apple silicon, macOS Intel, Windows
x64 and Linux x64 at the observation date. The Windows installer and public
website were published. Its qualification remains platform-specific; the
[platform authority](./reference/platform-support.md) names the limits.

## Signed release

The immutable GitHub release was published on **2026-09-27 at 21:02:49 UTC**.
Its 20 assets and [canonical release manifest](https://github.com/adamallcock/tibotattle/releases/download/v0.1.26/release-manifest.json)
were read back and hash-verified. The manifest SHA-256 is
`be65a83f8c1f060b7c5cf6141b6332c02df730dc1a2aac696442e4e433c123cc`;
the published installers bind to tagged source
`acfc385c95b49b8e1040cedfa857659b49a61d8d`, merged to main in
[PR #238](https://github.com/adamallcock/tibotattle/pull/238).
The manifest leaves SBOM and provenance fields null.

| Published target | Exact final-artifact evidence | Remaining boundary |
|---|---|---|
| Windows x64 | Authenticode signed and timestamped installer; [hosted signed installed journey](https://github.com/adamallcock/tibotattle/actions/runs/36347063769) passed | Existing-install upgrade and every physical desktop integration are not qualified |

Feed metadata, installed updater runs and distribution channels are distinct
evidence; the Windows installer evidence above does not establish any updater
replacement.

## Hosted and website boundary

The [public website](https://tibotattle.com/) serves the 0.1.26 download page. Its [site manifest](https://tibotattle.com/release-site-manifest.json)
has SHA-256
`676ddc42654eb4a44bffd59c3b45862f430a6e9e266f4211dc7610eaeac47c1c`.
The 2026-09-27 website-only follow-up put localized navigation on a full row at
narrow widths; the generated site changed only its stylesheet and manifest.
Cache-busted public readback matched the new stylesheet and manifest, while the
other generated files retained their launch-release bytes. The share image is
PNG at 1200×630. The live Spanish page showed the full Docs link at 390 px,
and the link opened Docs; the rendered page also exposed the published installers
and live community aggregates.

The production Worker health endpoint names web-only source
`ae637aa7c38febf97bd15ae4ad79d020aaa5d3f7`, a descendant of the
previous deployed web-only source `19f2459754a4a5393d3ba0804e7b293dbe7924c8`.
The guarded typed-storage website deploy preserved the live bindings and
qualified all three database roles. The 0.1.26 tag's separate analytics
migration `0027_admin_metrics_history_publications.sql` and its associated
Worker runtime changes are **not deployed**; they remain a separate reviewed
migration and deployment operation. Website publication does not prove hosted
runtime or schema activation.

Local analysis remains independent of hosted availability. Sharing and public
source eligibility follow the maintained
[sharing policy](./decisions/2026-09-04-accountless-sharing-policy.md) and
[public-source decision](./decisions/2026-09-11-public-contribution-sources.md).
An installation or provider-account source is not a verified person. A healthy
Worker is not proof of complete public calculations. The independent
GCP/PostgreSQL experiment is outside this release scope.

## Maintaining this snapshot

Update this authority from exact source, final manifests, installed receipts
and live readback. Do not turn an accepted missing test, an updater feed or a
source merge into a stronger claim. Use the
[platform authority](./reference/platform-support.md),
[artifact verification guide](./verify-release.md) and
[publication runbook](./runbooks/2026-08-18-cross-platform-release-publication.md)
for the continuing boundaries.
