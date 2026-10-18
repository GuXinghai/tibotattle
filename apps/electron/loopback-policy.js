import { shellError } from "./errors.js";

export const ELECTRON_LOOPBACK_HOST = "127.0.0.1";

const CODEX_THREAD_URL_PATTERN =
  /^codex:\/\/threads\/[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const CODEX_THREAD_URL_PREFIX = "codex://threads/";

/**
 * Parse the one canonical Codex thread target accepted by the host. This is
 * stricter than generic URL parsing: credentials, ports, query/fragment
 * values, alternate paths, and encoded components are all rejected.
 *
 * @returns {Readonly<{threadId: string, canonicalURL: string}>|null}
 */
export function parseCodexThreadURL(value) {
  if (typeof value !== "string" || !CODEX_THREAD_URL_PATTERN.test(value)) {
    return null;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const threadId = value.slice(CODEX_THREAD_URL_PREFIX.length);
  if (parsed.protocol !== "codex:"
      || parsed.hostname !== "threads"
      || parsed.host !== "threads"
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.port !== ""
      || parsed.pathname !== `/${threadId}`
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.href !== value) {
    return null;
  }
  return Object.freeze({ threadId, canonicalURL: value });
}

// Electron's permission and webRequest handlers belong to a Session, not to
// an individual BrowserWindow.  The dashboard and Settings windows normally
// use the same default session, so installing the policy for the second
// window must not replace the first window's handlers (and removing the
// second window must not remove the first window's filtering).  Keep one
// session-level installation alive until its last window releases it.
const sessionPolicyInstallations = new WeakMap();

function exactLoopbackOrigin(value) {
  if (typeof value !== "string") throw shellError("invalid_loopback_origin");
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw shellError("invalid_loopback_origin");
  }
  if (parsed.protocol !== "http:"
      || parsed.hostname !== ELECTRON_LOOPBACK_HOST
      || !parsed.port
      || parsed.username !== ""
      || parsed.password !== ""
      || parsed.pathname !== "/"
      || parsed.search !== ""
      || parsed.hash !== ""
      || parsed.origin !== value) {
    throw shellError("invalid_loopback_origin");
  }
  const port = Number(parsed.port);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw shellError("invalid_loopback_origin");
  }
  return parsed.origin;
}

export function isExactLoopbackOrigin(value) {
  try {
    exactLoopbackOrigin(value);
    return true;
  } catch {
    return false;
  }
}

export function isAllowedCompanionURL(url, allowedOrigin) {
  let selectedOrigin;
  try {
    selectedOrigin = exactLoopbackOrigin(allowedOrigin);
  } catch {
    return false;
  }
  if (typeof url !== "string") return false;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return parsed.origin === selectedOrigin
    && parsed.protocol === "http:"
    && parsed.hostname === ELECTRON_LOOPBACK_HOST
    && parsed.username === ""
    && parsed.password === "";
}

/**
 * Electron event handlers for the private dashboard. Navigation is allowed
 * only inside the exact companion origin selected from its ready line;
 * permission requests and new windows are denied by default.
 */
export function createLoopbackNavigationPolicy({ origin } = {}) {
  const allowedOrigin = exactLoopbackOrigin(origin);
  const policy = {
    origin: allowedOrigin,
    isAllowedURL(url) {
      return isAllowedCompanionURL(url, allowedOrigin);
    },
    handleWillNavigate(event, url) {
      const allowed = isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillRedirect(event, url) {
      const allowed = isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillFrameNavigate(event, details) {
      const url = typeof details === "string" ? details : details?.url;
      const allowed = details?.isMainFrame === true
        && isAllowedCompanionURL(url, allowedOrigin);
      if (!allowed) event?.preventDefault?.();
      return allowed;
    },
    handleWillAttachWebview(event) {
      event?.preventDefault?.();
      return false;
    },
    handleWindowOpen() {
      return Object.freeze({ action: "deny" });
    },
    handlePermissionRequest({ callback } = {}) {
      callback?.(false);
      return false;
    },
    handlePermissionCheck() {
      return false;
    },
    handleBeforeRequest(details, callback) {
      const allowed = isAllowedCompanionURL(details?.url, allowedOrigin);
      callback?.({ cancel: !allowed });
      return allowed;
    },
  };
  return Object.freeze(policy);
}

export function installLoopbackNavigationPolicy({
  webContents,
  session,
  policy,
  allowNotificationPermission = false,
  allowBackgroundResource = false,
} = {}) {
  if (!webContents || typeof webContents.on !== "function") {
    throw new TypeError("webContents is required");
  }
  if (!policy || typeof policy.isAllowedURL !== "function") {
    throw new TypeError("policy is required");
  }
  const onWillNavigate = (event, url) => policy.handleWillNavigate(event, url);
  const onWillRedirect = (event, url) => policy.handleWillRedirect(event, url);
  const onWillFrameNavigate = (event, details) => (
    policy.handleWillFrameNavigate(event, details)
  );
  const onWillAttachWebview = (event) => policy.handleWillAttachWebview(event);
  webContents.on("will-navigate", onWillNavigate);
  webContents.on("will-redirect", onWillRedirect);
  webContents.on("will-frame-navigate", onWillFrameNavigate);
  webContents.on("will-attach-webview", onWillAttachWebview);
  webContents.setWindowOpenHandler?.(() => policy.handleWindowOpen());

  let sessionInstallation;
  const notificationPermissionWebContentsId = allowNotificationPermission
    && Number.isSafeInteger(webContents.id)
    ? webContents.id
    : null;
  const canTrackSession = session !== null
    && session !== undefined
    && (typeof session === "object" || typeof session === "function");
  if (canTrackSession) {
    sessionInstallation = sessionPolicyInstallations.get(session);
    if (sessionInstallation === undefined) {
      const requestFilter = { urls: ["<all_urls>"] };
      const onPermissionRequest = (contents, permission, callback, details) => {
        const allowed = permission === "notifications"
          && notificationPermissionWebContentsIds.has(contents?.id);
        if (allowed) callback?.(true);
        else policy.handlePermissionRequest({ callback });
      };
      const onPermissionCheck = (contents, permission) => (
        permission === "notifications"
          && notificationPermissionWebContentsIds.has(contents?.id)
      );
      const notificationPermissionWebContentsIds = new Set();
      const backgroundContents = new Map();
      const onBeforeRequest = (details, callback) => {
        if (typeof details?.url === "string" && details.url.startsWith("tibotattle-background:")) {
          const contents = backgroundContents.get(details.webContentsId);
          let allowed = false;
          try {
            const frame = details.frame;
            const source = new URL(frame.url);
            allowed = /^tibotattle-background:\/\/image\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(details.url)
              && details.resourceType === "image" && details.method === "GET"
              && contents?.mainFrame === frame && frame.parent === null
              && source.origin === policy.origin && source.pathname === "/" && source.search === ""
              && source.username === "" && source.password === "";
          } catch { /* Missing/destroyed frames cannot read protected images. */ }
          callback?.({ cancel: !allowed });
          return allowed;
        }
        return policy.handleBeforeRequest(details, callback);
      };
      session.setPermissionRequestHandler?.(onPermissionRequest);
      session.setPermissionCheckHandler?.(onPermissionCheck);
      session.webRequest?.onBeforeRequest?.(requestFilter, onBeforeRequest);
      sessionInstallation = {
        count: 0,
        policyOrigin: policy.origin ?? null,
        requestFilter,
        onPermissionRequest,
        onPermissionCheck,
        onBeforeRequest,
        notificationPermissionWebContentsIds,
        backgroundContents,
      };
      sessionPolicyInstallations.set(session, sessionInstallation);
    } else if (sessionInstallation.policyOrigin !== (policy.origin ?? null)) {
      // A single Electron session cannot safely enforce two different
      // companion origins.  Refuse the second installation rather than
      // silently letting one window broaden or replace the other window's
      // network policy.
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      throw new TypeError("session loopback policy origin conflict");
    }
    sessionInstallation.count += 1;
    if (notificationPermissionWebContentsId !== null) {
      sessionInstallation.notificationPermissionWebContentsIds.add(
        notificationPermissionWebContentsId,
      );
    }
    if (allowBackgroundResource && Number.isSafeInteger(webContents.id)) {
      sessionInstallation.backgroundContents.set(webContents.id, webContents);
    }
  }

  let removed = false;
  return Object.freeze({
    remove() {
      if (removed) return;
      removed = true;
      webContents.off?.("will-navigate", onWillNavigate);
      webContents.off?.("will-redirect", onWillRedirect);
      webContents.off?.("will-frame-navigate", onWillFrameNavigate);
      webContents.off?.("will-attach-webview", onWillAttachWebview);
      if (sessionInstallation === undefined) return;
      if (notificationPermissionWebContentsId !== null) {
        sessionInstallation.notificationPermissionWebContentsIds.delete(
          notificationPermissionWebContentsId,
        );
      }
      sessionInstallation.backgroundContents.delete(webContents.id);
      sessionInstallation.count -= 1;
      if (sessionInstallation.count > 0) return;
      session.setPermissionRequestHandler?.(null);
      session.setPermissionCheckHandler?.(null);
      session.webRequest?.onBeforeRequest?.(sessionInstallation.requestFilter, null);
      sessionPolicyInstallations.delete(session);
    },
  });
}
