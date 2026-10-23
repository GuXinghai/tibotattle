---
title: Optional X reader and isolated session import
date: 2026-10-20
type: decision-record
status: accepted
---

# Optional X reader

The owner approved an optional desktop reader for Tibo's public X posts,
replies, reposts and media. This adds a separate network feature; local usage
analysis remains available offline and does not send usage data. It does not
restore community sharing, contribution upload or TiboTattle hosted sign-in.
This decision governs source behavior, not installed or published release proof.

## Login and session ownership

Before the first status response and while saved state is being read, the
reader reports checking login instead of showing a disconnected login chooser.
The chooser appears only after absence of a session or a restoration failure
is established. Cached reading and main-window display do not wait for recovery.

The reader offers an isolated X webpage login or a user-initiated Chrome
session import. A Chrome extension uses the official cookies and Native
Messaging interfaces only after the user chooses import. The app does not
read Chrome's encrypted cookie database, save a password, automate a login
submission, or continuously synchronize Chrome's session.

Import uses an exact extension origin, current-user bridge registration and
an owner-protected local transport with a short-lived import authorization.
Cookies remain in the native host and main-process authentication boundary;
they never enter the dashboard bridge, clipboard, ordinary files, diagnostics
or test fixtures. Connection checks do not request cookies.

A candidate session is accepted only after authenticated X content is observed.
Failure, cancellation or choosing another login method preserves the previous
session. Accepted sessions use separate owner-protected Electron session
directories. Candidate packaging must enable and verify Electron's
`EnableCookieEncryption` fuse before storing persistent imported cookies;
enabling it is a one-way cookie-storage migration, not a portable backup or
session-acceptance guarantee.

Login failures also preserve the previous authentication state: a failed new
attempt cannot relabel an expired or challenged session as connected. Returning
to the login chooser invalidates pending results, including results delivered
after asynchronous candidate cleanup. Reader and settings expose failures even
when no posts are cached; webpage timeout and generic login failure are distinct
from session import failure.

Session login exposes closed, content-free progress steps: local bridge check,
waiting for Chrome import, input validation, candidate preparation, Cookie write
and readback, X connection, authenticated-page verification, saving and success.
Steps advance at their actual operation boundaries without artificial delays or
percentages. Fast steps may finish between UI polls. Failure keeps the failed
step alongside its safe reason, including validation rejected by the authorized
Chrome import gate; unrelated or unpermitted bridge requests cannot change that
failure state. Expired import authorization has a separate prompt. Verification
challenges retain the candidate and offer an explicit action to open its X
window. Reader and settings consume the same progress; cancellation clears it
and late results cannot restore it. These transient fields do not persist in
settings or contain Cookie values, upstream responses or account information.

Local X error diagnostics are kept separately in the owner-protected
`x-diagnostics/x-errors-v1.json` record, bounded to the latest 16 errors and
64 KiB across application restarts. They preserve original
platform error codes, numeric errno, recognized native error messages, bounded
cause chains and source basenames with line/column locations. Arbitrary upstream
messages, authentication responses, URLs, absolute paths, credentials and post
content are omitted rather than guessed safe. These records never enter the
reader IPC or clipboard diagnostics. Recording failures cannot change login state.

Browser profiles use a separate native current-owner policy with inheritable
child access, rather than the non-inheriting protected-record policy. Before
Chromium opens a profile, a bounded handle-bound migration checks ownership,
ACL principals, links and reparse points; accepted descendants receive the
current owner's access without changing stored content. Unsafe or inaccessible
state stops restoration with a visible local error. Generic record-store ACLs
remain unchanged.

If the 4096-entry inspection bound is exceeded, the profile capability v2 may
prune only `Cache`, `Code Cache` and `Service Worker/CacheStorage`. Each operation
retains handle-bound owner, ACL, hardlink and reparse checks. A pass has an 8192
operation budget and can resume; the complete remaining tree must still pass
the original inspection before Chromium opens it. Partial disposable-cache
cleanup may precede a later failure. Cookies, durable site state and cached
posts are excluded. Overflow or unfinished cleanup has its own visible error,
not a misleading permissions diagnosis.

Read, write, persistence, decryption-unavailable, restore, permission and clear
failures have fixed content-free reader/settings messages. A candidate flushes
and checks local storage before replacing the previous login. An encrypted
synthetic Cookie on a reserved `.invalid` domain and a separately protected
digest checkpoint detect silent restoration failures before X navigation;
neither is an authentication credential. Missing or mismatched checkpoints do
not establish decryption failure or upstream logout. Legacy profiles require
their authentication Cookies to be readable before a checkpoint is established.
Local failures pause automatic fetching and remain visible until a successful
health retry, replacement login or completed logout. Normal quit waits for
session writes and shows a native error if the final flush fails. These source
contracts still require separate installed-artifact acceptance.

Logout stops this app's X requests and clears its own login state. It does not
log Chrome out. Cache clearing is a separate explicit action. Server revocation
or account verification may still require the user to reconnect.

An owner-protected, bounded session registry records candidates before Chromium
opens them and retains explicit cleanup intent across interruptions. Startup
cleans registered abandoned sessions; explicit logout also works when restoring
the active session failed. Cleanup is acknowledged only after local clearing
and the saved active pointer are reconciled. An unreadable initial repository
blocks mutation until a successful reload; defaults cannot replace unread state.

## Reader, cache and network boundary

The X adapter projects normal webpage data into a validated post model. It does
not render upstream HTML inside the trusted dashboard. Public post text, public
author metadata, exact publication timestamps and associated media references
are permitted only in the protected X cache and reader. This is an explicit
public-content exception; coding-agent prompts, responses and private session
content remain prohibited. X content and credentials never enter accounting,
usage exports, contribution schemas, analytics or diagnostics.

The X cache is separate from the usage database. Atomic chunk generations and
a recovery journal preserve the last committed state after interruption. A new
login scope archives the previous scope's cached posts without showing them as
the new scope. Explicit cache clearing removes current and archived post
payloads while retaining settings, login metadata and notification baselines.
Display windows do not delete accumulated cached content.

Post details support explicit reply continuation through the existing trusted
detail IPC with an optional bounded opaque cursor. Handles are process-local,
scoped to the parent post and invalidated by session/task cancellation or cache
clearing; at most 64 detail continuation states are retained. The most recently
completed handle can be replayed without another fetch. Source continuation
uses the normal X page's bounded scrolling, including reopening the parent
after another detail has used the source window. No arbitrary upstream cursor,
URL or request parameters are accepted from the renderer.

Only direct replies belong to a detail's main list. Clicking a reply opens
that reply's discussion with independent continuation and termination; Back
restores the parent detail and scroll position. Root timeline instructions and
nested conversation-module instructions are parsed separately. An explicit
Bottom termination wins over a residual cursor in that same scope. A branch
ending cannot terminate the parent list. Missing metadata, repeated results or
no progress remain retryable and never imply completion; displayed completion
means only the replies currently visible to the authenticated account. Retrieved
replies merge by post ID without deleting accumulated cache. Source/fixture
validation does not qualify traversal of a real multi-page X conversation or
the packaged reader.

Reply continuation starts automatically when the reader reaches the reserved
footer space. Normal paging has no load-more button; each current reply request
shows one loading message. A failed continuation pauses automatic retries and
offers a retry button. The footer space remains present while idle, loading or
finished, and service continuation handles remain the sole paging authority.

Cache snapshots and envelopes use version 2, with forward-only reads of version
1. Scope archives avoid repeating an identical disconnected snapshot; differing
history remains retained. Incomplete fresh text cannot replace complete text,
but validated fresh author and media data can still update that post.

Detail reads wait for the matching detail response or verified reply relations;
a cached main card alone cannot establish that comments finished loading.
Successful detail reads are reused for up to one minute, then revalidated on
the next opening. Loading, failed reads and confirmed empty replies have
separate reader states, with retry available after failure. The detail return
control stays outside the scrolling content, without a repeated page heading.
Detail freshness/failure is specific to that read; unrelated list failures do
not turn readable cached replies into a failed comments request.

The local dashboard cannot request arbitrary remote media. It receives opaque
`tibotattle-x-media://resource/<UUID>` references associated with validated posts.
Only an opted-in trusted dashboard main frame may request these references as
image, media or XHR using GET/HEAD. Native media handling validates the scope,
post association, approved media host and response type; playlists are rewritten
to opaque resource references. No arbitrary URL or filesystem relay is added.
MSE blob URLs are restricted to media from that same main frame and origin.
HLS uses the locally packaged player with workers disabled; remote scripts,
blob workers, child frames and new-window navigation remain denied.

Media renewal matches stable upstream asset IDs across URL changes and reorders.
Legacy positional IDs remain readable but cannot automatically rebind a different
asset. Transient renewal permits up to three attempts per resource per minute,
with concurrent renewal shared. Both GET and HEAD enforce the media type
allowlist; range failures retain only validated unsatisfied-range metadata.

X requests use the system proxy or an explicitly selected loopback proxy port.
This does not alter system proxy settings or usage-analysis networking.
Normal authenticated webpage activity and associated media requests reach X
and its assets; no usage data accompanies them. X can apply its own access,
retention and session controls.

## Refresh and acceptance

Manual refresh targets only the selected tab or focal discussion. Detail refresh
bypasses the 60-second reuse window, replaces that discussion's displayed order
and continuation on success, and retains the old view on failure. Replies follow
X's returned timeline order, not a local time/like sort; continuation appends
unique IDs. Ordered reply lists are stored per discussion in cache schema v3.
Legacy caches retain content without inventing an authoritative reply order;
the next successful detail read establishes it. Old cached posts are retained
even when absent from a fresh ordered list. There is no detail polling or
background "new replies" check. The existing posts/replies scheduler remains
independent of the current view and is not postponed by successful manual reads.
Focused validation covers order replacement/append, migration, forced reads,
scoped IPC, failures and navigation races; no full suite or packaging is required
for this source change, and real X/Electron acceptance remains outstanding.

Timeline tabs and detail replies reserve at least 200 CSS pixels at the end,
including after the final page. Continuation requests start when the beginning
of this space enters the scrollport, including filling a short viewport.
Loading, retry and end controls occupy that same reserved space rather than
adding a new row below the content when loading begins.
The continuation control announces loading and remains available as a keyboard
and manual fallback. Requests remain single-flight. Failed or duplicate-only
pages pause automatic continuation until an explicit retry or fresh read;
they never imply the end of the list. Hidden readers cannot auto-page, and
disposing the reader removes its scroll, media-load and resize listeners.
Focused synthetic reader tests cover these boundaries; actual Electron scrolling
and real X multi-page reads remain separate runtime acceptance gates.

The reader has its own main-process interval, defaulting to five minutes.
`-1` disables periodic requests; page opening and manual refresh remain usable.
There is no extra heartbeat or artificial cookie-expiry extension. Network,
parsing, rate-limit and authentication failures remain distinct and retain
available cached content.

Notifications are opt-in and concern only Tibo's new posts or replies. First
observations establish a baseline; subsequent checks deduplicate by post ID.
Each notification category has an independent initial floor and up to 1024
recent seen IDs. Late arrivals above that floor remain eligible; evicting old
IDs advances the floor, so older history never replays. Version 1 baselines
migrate conservatively to their category maximum without replaying history.
Notification availability still depends on the existing Windows identity and
permission gates. Synthetic contract tests do not prove system delivery.

Verification keeps source tests, actual X parsing, Electron media playback,
protected Windows storage, package cookie encryption and installed notification
delivery separate. A successful Chrome import does not prove all of those gates.
