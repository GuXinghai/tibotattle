---
title: X cache validity and reply boundary investigation
date: 2026-10-20
type: review
status: complete
---

# Scope and evidence boundary

Source snapshot: `94cc26f3`, Windows x64. Owner authorized a bounded real
Chrome test using clearly labelled disposable public posts and replies, plus
isolated pagination tests. No app packaging, deployment or production-code
change is part of this investigation. No authentication payload, Cookie,
request header, private account identifier or actual response fixture is saved.
The existing application is not retargeted to the owner's account.

## Live Chrome observations

- A single labelled temporary root post was successfully published and read
  through the normal X detail page. Creation and detail returned HTTP 200.
- The Edit menu opened a Plus-upgrade dialog. A real edit cannot be exercised
  with the current account entitlement. The creation result nevertheless had
  `edit_control.is_edit_eligible: true`, five edits remaining and one edit ID;
  this field alone does not establish entitlement to edit.
- With zero replies, the same conversation instruction list contained a
  nonempty Bottom cursor, a Top terminator and a Bottom
  `TimelineTerminateTimeline`. The current projector returns `exhausted: false`
  for this combination. This is a real terminal-conversation sample, not a
  test of traversing a multi-page conversation to its final page.
- One self-reply was successfully published through the normal composer, with
  HTTP 200 and a verified parent relation. A fresh detail request rendered the
  reply and returned the same combination: a nonempty Bottom cursor and explicit
  Top/Bottom terminators. Normal scrolling to the page bottom did not issue a
  further TweetDetail response during the observation window. This qualifies a
  one-page nonempty terminal sample, not multi-page traversal.
- An earlier inline reply attempt remained spinning; a separate fresh detail
  page still showed zero replies. It was closed before using the modal path;
  the later detail showed exactly one reply. No bulk reply creation was used.
- After explicit action-time owner confirmation, only the one temporary root
  and its one temporary reply were deleted. The normal UI confirmed root
  deletion, and fresh visits to both exact links displayed the page-not-found
  message. Both post-deletion TweetDetail and TweetResultByRestId responses
  returned HTTP 200 with no GraphQL errors. No DeleteTweet response body was
  retained, so deletion is established by UI outcome and subsequent fresh reads.
- The root's post-deletion conversation retained a `tweet-<id>` entry whose
  TimelineTweet `tweet_results` object was empty, a nonempty Bottom cursor,
  TimelineClearCache, and Top/Bottom terminators. The root's and reply's
  TweetResultByRestId result was `{data:{tweetResult:{}}}`. There was no explicit
  deletion-specific tombstone or reason code in the captured root results.
  Empty lookup alone therefore cannot distinguish deletion from every other
  unavailability reason. In this controlled experiment, the preceding confirmed
  delete action establishes the cause.

## Isolated characterization

A disposable, content-free fixture copied the existing service test harness
and imported current production modules. Six diagnostics reproduced:

1. A complete same-ID edit is accepted on detail revalidation, but a reopen
   within sixty seconds keeps the old version. A partial newer text preserves
   the older complete text.
2. A successful detail result containing only a reply leaves the old cached
   root present and incorrectly reports the detail outcome as live. The
   response contains no reply continuation or exhaustion contract.
3. An adapter `parser_changed` failure retains readable cache and reports a
   failed outcome; there is no deleted state.
4. Bottom termination plus a nonempty Bottom cursor is currently classified
   as not exhausted, matching the live structural observation above.
5. A synthetic tombstone has no projected deletion status and is unrecognized
   when it is the only result.

6. A minimal synthetic reconstruction of the observed deleted-detail structure
   yields no posts, recognized=true, exhausted=false and no availability status.
   The reconstruction contains no real ID, body, cursor or account data.

All six characterization assertions passed: this records existing defects,
not a claim that the desired behavior has been implemented.

Six existing focused tests also passed: missing cursor evidence, bounded
no-progress reads, detail revalidation, retryable continuation, network/auth
failure retention, and stable anchors when head posts arrive. These establish
existing timeline-list behavior, not reply-pagination completeness.

Runtime: Node.js 26.2.0. Commands:

```powershell
& ./.release-build/toolchains/node-v26.2.0-win-x64/node.exe --test .release-build/x-cache-validity-20261020/characterization.test.mjs
& ./.release-build/toolchains/node-v26.2.0-win-x64/node.exe --test --test-name-pattern='missing cursor|load more without progress|pagination retries|pagination keeps|pagination anchors|successful detail cache' apps/electron/test/desktop-x-page-adapter.test.mjs apps/electron/test/desktop-x-service.test.mjs
```

## Repair constraints suggested by evidence

- Track validated edit-chain identity separately from a concrete revision;
  never let partial/full-text preference silently select an older revision.
- Revalidation must prove the requested root was freshly observed. Replies or
  unrelated tweets cannot make an absent cached root live.
- Distinguish explicit deletion, access restriction and unknown availability;
  absence, network failure or parser failure must not erase stored evidence.
  A display invalidation is separate from a cache-retention deletion.
- Parse continuation and termination within the relevant conversation and
  instruction scope. A nonempty cursor cannot universally override an explicit
  terminal instruction. Nested module continuations need independent treatment.
- Expose reply continuation and terminal/unknown state to the reader. Empty or
  duplicate pages without terminal evidence remain retryable; timeouts and
  repeated cursors must stay bounded. A visible end means only that currently
  accessible replies are exhausted, not that every reply in X exists locally.

Real revision-chain evolution, traversal of a multi-page conversation to its
final page and new packaged Electron behavior remain separate acceptance gates.
Post-deletion behavior was observed only in Chrome; no claim is made that a
packaged TiboTattle reader now invalidates deleted cached content.

## Completion and remaining work

The bounded investigation and cleanup are complete. Production code is
unchanged and nothing was repackaged or committed. Documentation governance
and preflight passed after the initial report; the completed report is checked
again before handoff. The isolated characterization is diagnostic-only evidence,
not a passing regression gate for the missing edit/delete/reply contracts.
