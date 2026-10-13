---
title: Verify a TiboTattle release
date: 2026-09-07
type: guide
status: current
---

# Verify a TiboTattle release

This guide explains how to verify a TiboTattle artifact downloaded from the
official website, the GitHub release, or the Microsoft Store listing. TiboTattle
supports Windows x64 only. The checks answer different questions:

- a checksum proves that the bytes you received match the published bytes;
- a platform signature proves that the operating system or package channel
  accepted the publisher signature;
- a GitHub artifact attestation, when the release actually publishes one,
  constrains the source repository, source ref/digest, and signer workflow;
- an SBOM records the dependency inventory that was published for that exact
  artifact.

Together these checks provide useful release evidence. None proves that the
software is vulnerability-free or universally “safe.”

## Current availability boundary

Consult [current status](./current-status.md) and
[platform support](./reference/platform-support.md) for the published release,
platform matrix and qualification limits. Select the exact Windows x64 installer or package listed in that release's
manifest. Verify the selected artifact's own manifest entry and checksum. Endpoint availability does not prove its
native signature or other platform assurances; perform the checks in Section 3.

Source, plans, contract tests and simulated qualification do not establish
that a candidate is an official supported release.
For releases published under the v1 policy, treat the release page and its
release manifest as the source of truth: if a platform, architecture, format,
channel, native assurance, or digest is not listed there, do not download or
describe that artifact as an official TiboTattle release. Evidence fields may
be explicitly `null`; that means the release makes no claim for that evidence,
not that the artifact is unofficial.

### Important: pre-v1 releases

Releases published before the v1 evidence policy and repository release
immutability, such as `v0.1.12`, may fail the release-level verification
commands below. Do not interpret that failure alone as evidence that a published
asset changed. Verify such a release with its published SHA-256 and the Windows
checks in Section 3. The immutable-release setting is not retroactive.

GitHub artifact provenance is also release-specific. The commands below apply
only when this artifact's v1 manifest entry publishes non-null provenance and
`sbom.attestation` bundles. A native/checksum-only artifact may have explicit
`null` evidence fields and is still an official v1 artifact; in that case there
is no source-to-binary claim to verify. Never infer one from the source tree,
plan, or checksum.

For a published v1 release, the GitHub release is canonical for
`release-manifest.json`, any non-null SPDX SBOM, and any non-null artifact-named
provenance or SBOM-attestation bundles. The website exposes availability and
the installer digest; its `release-site-manifest.json` is not a replacement for
those release assets.

## 1. Identify the exact artifact

Use the download link from the official website or the GitHub release for the
same version. Before running verification, record these values from the release
manifest:

| Field | Why it matters |
| --- | --- |
| Channel (transport) | `direct` and `store` artifacts can be different final bytes. |
| Platform and architecture | The Windows x64 installer is the only supported subject. |
| Format | The direct EXE or MSIX installer and a Microsoft Store package have different native checks. |
| Release tag and source commit | The source identity the build is expected to use. |
| Final artifact SHA-256 | The exact bytes whose signature and provenance are being checked. |
| SBOM digest | The dependency inventory for this final artifact, when `sbom` is non-null; `null` means it was not published. |
| `sbom.attestation` reference | The SBOM attestation, when non-null; `null` means it was not published. |
| Provenance reference | The build claim, when non-null; `null` means this release makes no provenance claim. |
| Platform assurance | Authenticode or Store acceptance as applicable. |

Do not substitute a checksum from another architecture, an older release, or a
Store submission for the direct-download entry.

## 2. Verify the common GitHub evidence

Install a current GitHub CLI and authenticate only if the release requires API
access. Replace the artifact path and source commit with the values recorded
from the release manifest.

~~~bash
REPO="adamallcock/tibotattle"
VERSION="vX.Y.Z"
ARTIFACT="./TiboTattle-X.Y.Z-platform-arch.ext"
COMMIT="<40-character source commit from the release manifest>"
SIGNER_WORKFLOW="<signer workflow path from the release manifest>"
SIGNER_DIGEST="<trusted signer-workflow commit from the release manifest>"
PROVENANCE_BUNDLE="./<artifact-filename>.provenance.bundle.json"
SBOM_BUNDLE="./<artifact-filename>.sbom.bundle.json"

gh release verify "$VERSION" --repo "$REPO"
gh release verify-asset "$VERSION" "$ARTIFACT" --repo "$REPO"
~~~

For a v1 release, download every published asset into a fresh directory and
then validate the local manifest, artifact bytes, and checksum file without
any further network access:

~~~bash
VERIFY_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tibotattle-release-verify.XXXXXX")"
gh release download "$VERSION" --repo "$REPO" \
  --dir "$VERIFY_DIR" --pattern "*" --clobber
npm run release:evidence:validate -- \
  --manifest "$VERIFY_DIR/release-manifest.json" \
  --artifacts-dir "$VERIFY_DIR" \
  --sha256sums "$VERIFY_DIR/SHA256SUMS"
~~~

The `gh release download` step is the only network operation in this sequence;
the `release:evidence:validate` command reads the fresh directory only.

Current artifact validation qualifies Windows subjects only. The published v1
JSON Schema retains historical macOS and Linux shapes for structural reading;
that compatibility does not restore platform support or qualify those artifacts
with current tooling. See [schema compatibility](./reference/schema-contracts.md#ownership-map).

For releases published after repository release immutability was enabled,
these checks verify the immutable release and that the local file is one of
its published assets. A release-level or asset-level GitHub attestation is an
additional assurance, not a prerequisite for a native/checksum-only v1
artifact whose manifest evidence fields are explicitly `null`.

When this artifact's manifest entry has non-null provenance and
`sbom.attestation`, verify both bundles with all of the recorded identity
constraints. These are two separate commands:

~~~bash
gh attestation verify "$ARTIFACT" \
  --bundle "$PROVENANCE_BUNDLE" \
  --repo "$REPO" \
  --predicate-type "https://slsa.dev/provenance/v1" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$VERSION" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners

gh attestation verify "$ARTIFACT" \
  --bundle "$SBOM_BUNDLE" \
  --repo "$REPO" \
  --predicate-type "https://spdx.dev/Document/v2.3" \
  --signer-workflow "$SIGNER_WORKFLOW" \
  --signer-digest "$SIGNER_DIGEST" \
  --source-ref "refs/tags/$VERSION" \
  --source-digest "$COMMIT" \
  --deny-self-hosted-runners
~~~

The first command verifies the SLSA provenance bundle; the second verifies the
SPDX attestation bundle. The repository, signer workflow, and signer digest must
be the values chosen by the release policy, not a workflow guessed from the
current default branch. The source ref must be the exact protected release tag,
and the source digest must be the exact commit recorded in this release's
manifest. If a reusable workflow produced the attestation, verify the reusable
workflow's repository and path instead of treating the caller workflow as the
signer. Append `--format json` to either command when saving the verified
certificate and transparency-log details for review. If either non-null bundle
fails verification, fail closed on the corresponding attested claim.

The workflow controls much of each attestation predicate. The certificate
identity and transparency-log/timestamp evidence are the parts that are not
simply free-form text supplied by the workflow. A trusted, isolated release
workflow is therefore part of the security boundary.

## 3. Verify the platform artifact

Run the commands for the Windows artifact you actually downloaded. Replace
the example path with your file.

### Windows direct installer or MSIX

Compare the installer with the manifest and inspect its Authenticode signer
and timestamp in PowerShell:

~~~powershell
Get-FileHash .\TiboTattle-Setup.exe -Algorithm SHA256
Get-AuthenticodeSignature .\TiboTattle-Setup.exe |
  Format-List Status,SignerCertificate,TimeStamperCertificate
signtool verify /pa /all /v .\TiboTattle-Setup.exe
~~~

Use the same checks for the final MSIX path when the release publishes MSIX.
The signature must cover the final installer/package bytes and include a
trusted SHA-256 timestamp. SmartScreen reputation is separate from signature
validity: a new correctly signed direct-download binary may still display a
reputation warning while its reputation is established.

A Microsoft Store package is a separate `store` channel subject. Microsoft may
re-sign it, so compare it with the Store release entry and its `distribution`
value, not with a direct EXE or MSIX digest.

## 4. Direct downloads and Stores are separate subjects

The release manifest should contain one entry for every final downloadable
subject. For example:

| Distribution (channel) | Evidence to use | What not to assume |
| --- | --- | --- |
| `github-release` (`direct`) | Final digest, GitHub release/asset verification, a release-specific artifact attestation when published, native platform signature | A checksum alone proves source provenance. |
| Microsoft Store: `microsoft-store` (`store`) | Store publisher identity plus a `store-delivery-receipt-v1` for the final retrieved subject | The Store package has the same bytes as an EXE/MSIX direct artifact, or an upload candidate is the delivered subject. |

For every `store` subject, inspect the full `store-delivery-receipt-v1` release
asset as well as the normalized `artifact.store.receipt` manifest metadata. The
receipt must bind the provider, listing, source version/tag/commit/repository,
final artifact filename, bytes, and SHA-256, and must state
`subjectKind: store-retrieved`, `deliveryState: final`, and
`uploadCandidate: false`. The manifest metadata records the receipt filename,
bytes, SHA-256, and artifact `subjectSha256`; `SHA256SUMS` includes the receipt
filename and digest. If the receipt is missing, mismatched, non-final, or marks
an upload candidate, reject that Store subject.

The update channel is another subject. A Windows update manifest must be verified
against its own key and final bytes. Do not use the initial installer checksum as an update-feed
signature.

## 5. What the evidence does and does not mean

A SHA-256 checksum proves integrity: your local file has the same bytes as the
published file. It does not prove safety, publisher intent, source provenance,
or absence of vulnerabilities.

A platform signature proves that the platform signer accepted the final bytes
under its policy. Windows Authenticode and Microsoft Store acceptance establish different trust
boundaries; neither is a universal safety guarantee.

A GitHub/Sigstore attestation, when independently verified with the repository,
source ref/digest, signer workflow, signer digest, runner policy, and the
artifact's own bundle, provides evidence about the claimed build relationship.
It does not turn a build into a guarantee of vulnerability-free software. The
complete non-null set of `sbom`, `sbom.attestation`, and `provenance` is the
attested v1 profile/path. If any of those fields is `null`, the release makes no
corresponding source/build claim; say that the source is public and the artifact
is signed/checksummed where applicable, but do not say that the binary is
cryptographically proven to come from that source. That provenance claim is
valid only when a trusted hosted workflow generated/finalized and
cryptographically verified the exact final bytes.

## 6. Maintainer release invariants

Every official artifact must have a v1 manifest entry. For each non-null
evidence field, the release pipeline must:

1. Build each platform and architecture on a native, controlled path.
2. Start from a protected, exact release tag and committed dependency lockfile.
3. Generate the final platform artifact before computing its published digest.
4. Ensure signing, packaging, compression, and timestamp
   operations are complete before the final artifact is attested.
5. For an artifact claiming the attested v1 profile/path, publish one SPDX SBOM,
   one provenance subject, and one `sbom.attestation` subject, plus their
   artifact-specific bundles, for that final artifact. For a
   native/checksum-only artifact, write explicit `null` values instead.
6. Keep direct-download and Store outputs as separate manifest entries.
7. Verify installation, upgrade, updater, rollback, and uninstall on clean native
   machines before publication.
8. Create a draft release, re-download and verify every asset, then publish an
   immutable release.
9. Pin production actions to immutable commit SHAs and keep signing credentials
   in protected environments.
10. Publish only the claims that the release's manifest and verification output
    actually support.

## Authoritative references

- [GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations)
- [GitHub gh attestation verify](https://cli.github.com/manual/gh_attestation_verify)
- [GitHub immutable releases](https://docs.github.com/en/code-security/concepts/supply-chain-security/immutable-releases)
- [GitHub release-integrity verification](https://docs.github.com/en/code-security/how-tos/secure-your-supply-chain/secure-your-dependencies/verify-release-integrity)
- [SLSA build provenance](https://slsa.dev/spec/v1.2/build-provenance)
- [Microsoft code-signing options](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)
- [Microsoft SmartScreen reputation](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)
