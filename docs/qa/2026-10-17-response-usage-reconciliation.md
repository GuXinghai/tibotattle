---
title: Codex response usage reconciliation validation
date: 2026-10-17
type: qa
status: validated-local
---

# Scope and evidence boundary

This receipt covers Codex response accounting, replay-safe source replacement,
public partial-coverage reporting, and a real-data refresh of a protected local
index copy. It does not qualify an installed application, packaged release, or
all upstream Codex record versions. The original local index was not opened for
writing by these checks; read-only source enumeration and copy-only rehearsal
are distinct from any concurrent application activity.

The fixed comparison cutoff was `2026-10-16T14:25:27.830Z`. The protected copy
originated from original index commit sequence 6,184. This final two-pass run
resumed the copy at sequence 10,410, so 10,410 identifies the rehearsal's
starting state, not the original index.

# Reconciliation result

The repaired extractor processed 501 selected sources successfully. It matched
22,341 distinct modern response identities and the frozen component vector:

| Component | Tokens |
|---|---:|
| Input context | 2,897,560,337 |
| Cached input | 2,808,539,392 |
| Cache write | 0 |
| Combined output | 13,489,200 |
| Reasoning output | 6,270,511 |
| Input plus combined output | 2,911,049,537 |

The exact extractor audit identified 166 missing compaction responses and two
missing ordinary responses. It retained 33 responses with unknown model
attribution. All turns in this 501-source extraction had complete chains. The
separate full 2,855-source copy refresh found one first response after a valid
nonzero cumulative prefix; its exact raw usage remains counted, while earlier
coverage is reported as unverified. No inferred prefix amount is charged.

The protected-copy refresh completed both passes with parser stamp
`local-index-rollout-typed-v2+unified-rollout-typed-v21`. Pass one rescanned
2,855 of 2,855 discovered sources; pass two rescanned three. The copy then had
2,855 sources at the current parser, nine retained v19 sources, and zero
quarantined sources. Integrity, foreign-key, usage-rollup, work-rollup, and
pairing audits each had zero failures or differences.

At the same cutoff the copy contained 22,141 modern rows and 200 positive legacy
rows. Those legacy rows belong to eight v19 sources omitted by the fixed-cutoff
discovery; the ninth retained v19 source had no positive legacy row in this
range. Modern response digests were unique within the range (22,141 rows and
22,141 distinct digests). Modern plus retained legacy records matched the frozen
vector exactly. The 501-source identity audit matched all 22,141 modern digests
to exact six-component quantities. It also matched all 200 retained positive
legacy rows to their own same-turn standalone response and verified each stored
legacy row against its physical source offset. None of those 200 response
digests is present in the modern copy, so the retained legacy rows do not
duplicate indexed modern spend.

The audit represented all 168 target responses in the copied index with exact
quantities and no ambiguous or unrepresented target. For 140 targets, identity
was available directly: 138 compactions had a bounded checkpoint payload with
the response ID, and two ordinary responses had standalone response IDs. The
remaining 28 compaction payloads exceeded the bounded parser limit. For those,
the audit used bounded structural linkage: in the same stable source, the
immediately preceding standalone response was a unique match for the target's
full six-component vector and its actual payload thread and response identity;
the checkpoint header time followed that response by 25–63 ms, with no
intervening token-usage record. The resulting identities were present in the
copy with exact quantities. This is structural evidence for those 28 responses,
not direct identity evidence from
their opaque checkpoint payloads. The audit used the provider payload thread ID
rather than the containing session ID. One source's size, modification time,
and change time differed from stored metadata; its file identity remained stable
and it was read once through the stable-source wrapper. This does not exclude
unrelated concurrent application activity.

# Validation

- `node --test test/codex-response-usage.test.js`: 11 passed, including changed
  response identity rejection and duplicate ownership through rescan,
  replacement, pruning, and replay.
- Focused public history coverage test: passed. It verifies that a known
  positive-prefix diagnostic remains visible alongside an older unparsed
  source, and that all-old sources remain unknown rather than reporting zero.
- `node --test apps/web/test/lib.test.mjs apps/web/test/evidence-warning-localization.test.mjs`:
  198 passed.
- `npm run telemetry:generate`: generated the compatibility manifest and field
  dictionary from their canonical source.
- `npm run product:local:test`: 304 passed, one skipped, zero failed in the
  normal Windows context.
- Architecture check: 580 files scanned, 2,316 checks, zero boundary debt.
- Documentation preflight: 20/20 checks passed; governance scanned 282 Markdown
  documents and 968 files, with root hygiene and diff whitespace checks clean.

No app packaging or startup/GUI check was requested.
