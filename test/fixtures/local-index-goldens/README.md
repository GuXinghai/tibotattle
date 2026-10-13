# Local index golden views

`views.json` holds figures the shipping (v1) unified index produced at commit
`cf94e9a8` for one synthetic, content-free corpus: the companion report at two
clocks (with a declared-speed ledger), the work breakdown at the same clocks,
the replay-safe calibration layer with and without the ledger, and the
contribution day digests and record identities.

`test/local-index-goldens.test.js` builds the successor store from the same
corpus and requires every figure to match. Integers, strings and identities are
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
