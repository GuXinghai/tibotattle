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

Browser profiles use a separate native current-owner policy with inheritable
child access, rather than the non-inheriting protected-record policy. Before
Chromium opens a profile, a bounded handle-bound migration checks ownership,
ACL principals, links and reparse points; accepted descendants receive the
current owner's access without changing stored content. Unsafe or inaccessible
state stops restoration with a visible local error. Generic record-store ACLs
remain unchanged.

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

Detail reads wait for the matching detail response or verified reply relations;
a cached main card alone cannot establish that comments finished loading.
Successful detail reads are reused for up to one minute, then revalidated on
the next opening. Loading, failed reads and confirmed empty replies have
separate reader states, with retry available after failure. The detail return
control stays outside the scrolling content, without a repeated page heading.

The local dashboard cannot request arbitrary remote media. It receives opaque
`tibotattle-x-media://resource/<UUID>` references associated with validated posts.
Only an opted-in trusted dashboard main frame may request these references as
image, media or XHR using GET/HEAD. Native media handling validates the scope,
post association, approved media host and response type; playlists are rewritten
to opaque resource references. No arbitrary URL or filesystem relay is added.
MSE blob URLs are restricted to media from that same main frame and origin.
HLS uses the locally packaged player with workers disabled; remote scripts,
blob workers, child frames and new-window navigation remain denied.

X requests use the system proxy or an explicitly selected loopback proxy port.
This does not alter system proxy settings or usage-analysis networking.
Normal authenticated webpage activity and associated media requests reach X
and its assets; no usage data accompanies them. X can apply its own access,
retention and session controls.

## Refresh and acceptance

The reader has its own main-process interval, defaulting to five minutes.
`-1` disables periodic requests; page opening and manual refresh remain usable.
There is no extra heartbeat or artificial cookie-expiry extension. Network,
parsing, rate-limit and authentication failures remain distinct and retain
available cached content.

Notifications are opt-in and concern only Tibo's new posts or replies. First
observations establish a baseline; subsequent checks deduplicate by post ID.
Notification availability still depends on the existing Windows identity and
permission gates. Synthetic contract tests do not prove system delivery.

Verification keeps source tests, actual X parsing, Electron media playback,
protected Windows storage, package cookie encryption and installed notification
delivery separate. A successful Chrome import does not prove all of those gates.
