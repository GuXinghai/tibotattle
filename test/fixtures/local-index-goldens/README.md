# Local index golden views

`views.json` holds figures the shipping (v1) unified index produced at commit
`cf94e9a8` for one synthetic, content-free corpus: the companion report at two
clocks (with a declared-speed ledger), the work breakdown at the same clocks,
and the replay-safe calibration layer with and without the ledger.

`test/local-index-goldens.test.js` builds the successor store from the same
corpus. The frozen Standard report and calibration still match; historical work
cells are reconstructed by per-event Standard pricing against the same frozen
fixture. Only the five explicitly named additive speed-pricing fields leave the
historical report projection. Current speed-tier report fields and full work-cell
digests are checked separately against an independent per-event public-ledger
oracle, including unknown speeds and unavailable tier/context prices. No current
pricing values are regenerated into the frozen fixture.

Integers, strings and identities are
exact; the only sanctioned difference is binary-float rounding of money
(deviation N1 in the redesign plan). Large cache-impact breakdowns are held as
digests because one shared analyzer produces them from the same rows.

The corpus parameters live in `test/helpers/local-index-goldens.js`. Nothing
here is derived from a real Codex home.

## Regenerating

There is no generator. The shipping (v1) implementation that produced these
views has been removed, and the successor is never a source for them. The
fixture is the specification: change it only when a documented, intended
difference in meaning is accepted, say why in the commit, and never regenerate
it from the successor.
