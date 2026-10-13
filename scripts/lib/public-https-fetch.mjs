/** Bounded public HTTPS fetch for release readiness (Windows-only product). */

const MAX_HEALTH_RESPONSE_BYTES = 64 * 1024;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 5_000;

export const PUBLIC_HTTPS_REMOTE_CODES = Object.freeze({
  BODY_TOO_LARGE: "PUBLIC_HTTPS_REMOTE_BODY_TOO_LARGE",
  ARGUMENTS_INVALID: "PUBLIC_HTTPS_REMOTE_ARGUMENTS_INVALID",
  FETCH_FAILED: "PUBLIC_HTTPS_REMOTE_FETCH_FAILED",
  FETCH_REDIRECT: "PUBLIC_HTTPS_REMOTE_FETCH_REDIRECT",
  RESPONSE_INVALID: "PUBLIC_HTTPS_REMOTE_RESPONSE_INVALID",
  TIMEOUT: "PUBLIC_HTTPS_REMOTE_TIMEOUT",
});

const DEFAULT_CLOCK = Object.freeze({
  now: () => Date.now(),
  setTimeout: (callback, delay) => globalThis.setTimeout(callback, delay),
  clearTimeout: (handle) => globalThis.clearTimeout(handle),
});

function remoteError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requiredString(value, label, code = PUBLIC_HTTPS_REMOTE_CODES.ARGUMENTS_INVALID) {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw remoteError(code, `${label} is required`);
  }
  return value;
}

function normalizeTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.ARGUMENTS_INVALID,
      `Timeout must be an integer from 1 to ${MAX_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function publicHttpsURL(value, label) {
  requiredString(value, label, PUBLIC_HTTPS_REMOTE_CODES.RESPONSE_INVALID);
  let selected;
  try {
    selected = new URL(value);
  } catch {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.RESPONSE_INVALID,
      `${label} is not an HTTPS URL`,
    );
  }
  if (selected.protocol !== "https:"
      || selected.username
      || selected.password
      || selected.search
      || selected.hash
      || selected.href !== value) {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.RESPONSE_INVALID,
      `${label} must be an exact credential-free HTTPS URL`,
    );
  }
  return selected.href;
}

function responseHeader(response, name) {
  if (response?.headers && typeof response.headers.get === "function") {
    return response.headers.get(name);
  }
  return null;
}

async function cancelReader(reader) {
  if (typeof reader?.cancel === "function") {
    try {
      await reader.cancel();
    } catch {
      // The request has already failed closed; cancellation is best effort.
    }
  }
}

async function readBoundedResponseText(response, maximumBytes) {
  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    try {
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = Buffer.from(next.value);
        totalBytes += chunk.byteLength;
        if (totalBytes > maximumBytes) {
          await cancelReader(reader);
          throw remoteError(
            PUBLIC_HTTPS_REMOTE_CODES.BODY_TOO_LARGE,
            "Remote response exceeded the bounded body limit",
          );
        }
        chunks.push(chunk);
      }
    } catch (error) {
      await cancelReader(reader);
      throw error;
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  if (typeof response?.text !== "function") return "";
  const text = await response.text();
  if (typeof text !== "string"
      || Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.BODY_TOO_LARGE,
      "Remote response exceeded the bounded body limit",
    );
  }
  return text;
}

function elapsedMilliseconds(clock, start) {
  const finish = clock.now();
  if (!Number.isFinite(start) || !Number.isFinite(finish)) return null;
  return Math.max(0, Math.round(finish - start));
}

function normalizeClock(clock) {
  const selected = clock ?? DEFAULT_CLOCK;
  if (typeof selected.now !== "function"
      || typeof selected.setTimeout !== "function"
      || typeof selected.clearTimeout !== "function") {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.ARGUMENTS_INVALID,
      "A clock with now, setTimeout, and clearTimeout functions is required",
    );
  }
  return selected;
}

function requestFailure(code, status = null) {
  const error = remoteError(code, "Bounded remote request failed");
  error.status = Number.isInteger(status) ? status : null;
  return error;
}

/**
 * Make exactly one credential-free, GET-only HTTPS request. Redirects are
 * deliberately not followed, and both the response body and request time are
 * bounded. The response body is returned only to the caller for local parsing.
 */
export async function fetchBoundedPublicHTTPS(
  url,
  {
    accept = "*/*",
    clock = DEFAULT_CLOCK,
    fetchImpl = globalThis.fetch,
    maximumBytes = MAX_HEALTH_RESPONSE_BYTES,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  const selected = publicHttpsURL(url, "Remote request URL");
  const selectedClock = normalizeClock(clock);
  const boundedTimeout = normalizeTimeout(timeoutMs);
  if (typeof fetchImpl !== "function") {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.FETCH_FAILED,
      "The runtime does not provide a fetch implementation",
    );
  }
  if (!Number.isSafeInteger(maximumBytes) || maximumBytes < 1) {
    throw remoteError(
      PUBLIC_HTTPS_REMOTE_CODES.ARGUMENTS_INVALID,
      "Remote response body limit must be a positive integer",
    );
  }
  const controller = new AbortController();
  const start = selectedClock.now();
  let timedOut = false;
  let timerScheduled = false;
  let timer;
  const operation = (async () => {
    let response;
    try {
      response = await fetchImpl(selected, {
        credentials: "omit",
        headers: { accept },
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
      });
    } catch {
      throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.FETCH_FAILED);
    }
    const status = response?.status;
    if (!Number.isInteger(status) || status < 100 || status > 599) {
      throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.RESPONSE_INVALID);
    }
    if (status >= 300 && status < 400) {
      throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    if (typeof response.url === "string"
        && response.url.length > 0
        && response.url !== selected) {
      throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.FETCH_REDIRECT, status);
    }
    let body;
    try {
      body = await readBoundedResponseText(response, maximumBytes);
    } catch (error) {
      if (!Number.isInteger(error?.status)) error.status = status;
      throw error;
    }
    return Object.freeze({
      body,
      contentType: responseHeader(response, "content-type"),
      durationMs: elapsedMilliseconds(selectedClock, start),
      status,
    });
  })();
  const timeout = new Promise((_, reject) => {
    timer = selectedClock.setTimeout(() => {
      timedOut = true;
      try {
        controller.abort();
      } catch {
        // AbortController is best effort; the race still enforces the bound.
      }
      reject(requestFailure(PUBLIC_HTTPS_REMOTE_CODES.TIMEOUT));
    }, boundedTimeout);
    timerScheduled = true;
  });
  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut || error?.code === PUBLIC_HTTPS_REMOTE_CODES.TIMEOUT) {
      throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.TIMEOUT);
    }
    if (error?.code) throw error;
    throw requestFailure(PUBLIC_HTTPS_REMOTE_CODES.FETCH_FAILED);
  } finally {
    if (timerScheduled) selectedClock.clearTimeout(timer);
  }
}
