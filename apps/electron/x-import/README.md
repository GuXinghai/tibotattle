# Chrome X session import

This owner-initiated bridge is separate from X webpage authentication. The
extension has no background worker and reads only authorized X cookies after
an active, normal `https://x.com` tab and an application import preflight.
It never uses files, clipboard, extension storage or logging for credentials.

The packaged `RhetrionXImport.exe` is built from `NativeHost.cs` with the
Windows x64 .NET Framework compiler by `buildDesktopXImportNative`. Generate
the binary in the candidate source tree before packaging; do not compile at
application startup or package a binary from a Downloads/prototype directory.

`createDesktopXImport` requires a dedicated branded Windows protected store
with at least 1 MiB per file. Only an explicit `configure()` copies reviewed
assets into that stable store and registers the exact extension origin under
the current user's 32-bit and 64-bit Chrome Native Messaging registry views.
This does not load the unpacked extension into Chrome automatically.

`begin()` starts a two-minute request. The preflight returns a one-use permit;
`cancel()` and `dispose()` invalidate pending and in-flight generations. The
injected `onImport(cookies, permit)` receives Electron cookie setter objects,
and must check `permit.isCurrent()` immediately before committing an accepted
candidate session. It must reject authentication failure or return `false`.
Cookie persistence, authentication validation and candidate replacement belong
to the X session service, not the transport. The service may acknowledge
delivery with `{ ok: true, code: 'verification_pending' }`; the extension must
then say that X verification is still pending rather than claim a login.

The native relay never starts Electron or accepts executable paths from Chrome.
It connects to the running application's broker using owner-and-SYSTEM-only
named pipes. Both pipes reject remote clients and require their first instance;
the private pipe verifies the application PID, while the public connection
verifies the native executable path in both directions. Frames are limited to
512 KiB. The broker process exits with its owning application. Runtime status
contains only fixed codes and trusted-settings extension location metadata.

Portable gate tests, Windows native transport tests, real Chrome import,
authenticated X acceptance and packaged-artifact validation are separate gates.
