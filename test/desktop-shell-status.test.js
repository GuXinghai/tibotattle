import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
  projectDesktopShellStatus,
  validateDesktopShellStatus,
} from "../src/desktop-shell-status.js";

const NOW = Date.parse("2026-09-05T12:00:00.000Z");

function displayEvidence(overrides = {}) {
  const base = {
    evidenceStatus: "available",
    freshness: {
      status: "live",
      staleAfterSeconds: 30 * 60,
    },
    windows: [
      {
        durationMinutes: 300,
        slot: "secondary",
        usedPercent: 58,
        remainingPercent: 42,
        observedAt: "2026-09-05T11:59:00.000Z",
        resetAt: "2026-09-05T12:30:00.000Z",
      },
      {
        durationMinutes: 10_080,
        slot: "primary",
        usedPercent: 100,
        remainingPercent: 0,
        observedAt: "2026-09-05T11:59:00.000Z",
        resetAt: "2026-09-05T15:00:00.000Z",
      },
    ],
  };
  return {
    ...base,
    ...overrides,
    freshness: { ...base.freshness, ...overrides.freshness },
    windows: overrides.windows ?? base.windows,
  };
}

function expected(state, allowance = null, notificationEvidence = null, display = null) {
  return {
    schemaVersion: DESKTOP_SHELL_STATUS_SCHEMA_VERSION,
    state,
    allowance,
    notificationEvidence,
    ...(display === null ? {} : { displayEvidence: display }),
  };
}

function displaySummary(windows = displayEvidence().windows) {
  return { schemaVersion: "usagemonitor-display-evidence-v1", scopeKey: null, staleAfterSeconds: 1800,
    windows: windows.map(({ durationMinutes, remainingPercent, observedAt, resetAt }) => ({ durationMinutes, remainingPercent, observedAt, resetAt })) };
}

test("published overview display evidence supplies a zero-percent native-primary allowance without notification authority", () => {
  const evidence = displayEvidence();
  const directAllowance = {
    source: "direct",
    window: "seven_day",
    remainingPercent: 0,
  };

  const idle = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "idle" },
    displayEvidence: evidence,
    now: NOW,
  });
  assert.deepEqual(idle, expected("fresh", directAllowance, null, displaySummary()));
  assert.deepEqual(validateDesktopShellStatus(idle), idle);

  const analyzing = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "running", result: null },
    displayEvidence: evidence,
    now: NOW,
  });
  assert.deepEqual(analyzing, expected("analyzing", directAllowance, null, displaySummary()));
  assert.deepEqual(validateDesktopShellStatus(analyzing), analyzing);
  assert.equal(JSON.stringify(analyzing).includes("continuity"), false);
  assert.equal(JSON.stringify(analyzing).includes("openai_codex"), false);
});

test("desktop shell display proof follows live current reset and primary-lane bounds", () => {
  const scenarios = [
    ["demo", displayEvidence({ freshness: { status: "demo" } })],
    ["offline", displayEvidence({ freshness: { status: "offline" } })],
    ["expired", displayEvidence({
      windows: [{
        ...displayEvidence().windows[0],
        resetAt: "2026-09-05T12:00:00.000Z",
      }],
    })],
    ["malformed", displayEvidence({
      windows: [{
        ...displayEvidence().windows[0],
        remainingPercent: 43,
      }],
    })],
  ];

  for (const [name, evidence] of scenarios) {
    const status = projectDesktopShellStatus({
      snapshotStatus: "ready",
      refresh: { status: "succeeded", result: {} },
      displayEvidence: evidence,
      now: NOW,
    });
    assert.deepEqual(status, expected("stale"), name);
  }

  // A secondary normal-Codex lane remains the native fallback when no primary
  // slot exists; a slot is display precedence, not a separate provider pool.
  const secondaryFallback = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: {} },
    displayEvidence: displayEvidence({ windows: [displayEvidence().windows[0]] }),
    now: NOW,
  });
  assert.deepEqual(secondaryFallback, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 42,
  }, null, displaySummary([displayEvidence().windows[0]])));

  const expiredWeeklyFallback = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: {} },
    displayEvidence: displayEvidence({ windows: [
      displayEvidence().windows[0],
      { ...displayEvidence().windows[1], resetAt: "2026-09-05T12:00:00.000Z" },
    ] }),
    now: NOW,
  });
  assert.deepEqual(expiredWeeklyFallback, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 42,
  }, null, displaySummary([displayEvidence().windows[0]])));
});

test("strict v2 notification evidence remains the only notification-bearing path", () => {
  const notificationEvidence = {
    schemaVersion: "usagemonitor-notification-evidence-v2",
    status: "fresh_provider_observation",
    provider: "openai_codex",
    source: "app_server_read",
    freshness: "fresh",
    observedAt: "2026-09-05T12:00:00.000Z",
    continuityKey: "a".repeat(43),
    windows: [{
      lane: "primary",
      usedPercent: 26,
      durationMinutes: 300,
      resetAt: "2026-09-05T15:00:00.000Z",
      resetProofKind: "provider_reported_schedule_only",
    }],
  };
  const status = projectDesktopShellStatus({
    snapshotStatus: "ready",
    refresh: { status: "succeeded", result: { notificationEvidence } },
    displayEvidence: displayEvidence({ freshness: { status: "offline" } }),
    now: NOW,
  });
  assert.deepEqual(status, expected("fresh", {
    source: "direct",
    window: "five_hour",
    remainingPercent: 74,
  }, notificationEvidence));
  assert.throws(
    () => validateDesktopShellStatus(expected("fresh")),
    /desktop shell status is invalid/u,
  );
});


test("aged display-only observations survive until reset without notification authority", () => {
  const input = displayEvidence({ freshness: { status: "stale" }, windows: [{
    ...displayEvidence().windows[1], usedPercent: 47, remainingPercent: 53,
    observedAt: "2026-09-05T10:24:00.000Z",
  }] });
  const value = projectDesktopShellStatus({ refresh: { status: "succeeded", result: {} }, displayEvidence: input, now: NOW });
  assert.equal(value.state, "stale");
  assert.equal(value.allowance, null);
  assert.equal(value.notificationEvidence, null);
  assert.equal(value.displayEvidence.windows[0].remainingPercent, 53);
  assert.deepEqual(validateDesktopShellStatus(value), value);
  for (const refresh of [{ status: "cancelled" }, { status: "failed" }]) {
    assert.equal(projectDesktopShellStatus({ refresh, displayEvidence: input, now: NOW }).displayEvidence, undefined);
  }
  assert.equal(projectDesktopShellStatus({ refresh: { status: "idle" }, displayEvidence: input,
    now: Date.parse(input.windows[0].resetAt) }).displayEvidence, undefined);
  const replacement = projectDesktopShellStatus({ refresh: { status: "idle" }, displayEvidence: displayEvidence({ windows: [] }), now: NOW });
  assert.equal(replacement.displayEvidence, undefined, "a new empty source snapshot does not borrow the previous observation");
});

test("only elapsed time after a valid completed direct receipt receives the closed expired marker", () => {
  const receipt = {
    schemaVersion: "usagemonitor-notification-evidence-v2",
    status: "fresh_provider_observation", provider: "openai_codex", source: "app_server_read", freshness: "fresh",
    observedAt: "2026-09-05T11:54:00.000Z", continuityKey: "a".repeat(43),
    windows: [{ lane: "primary", usedPercent: 85, durationMinutes: 300, resetAt: "2026-09-05T15:00:00.000Z", resetProofKind: "provider_reported_schedule_only" }],
  };
  const refresh = { status: "succeeded", finishedAt: "2026-09-05T11:54:01.000Z", result: { notificationEvidence: receipt } };
  for (const display of [null, displayEvidence()]) {
    const expired = projectDesktopShellStatus({ refresh, displayEvidence: display, now: NOW });
    assert.equal(expired.notificationEvidence, null);
    assert.equal(expired.notificationEvidenceStatus, "expired");
    assert.deepEqual(validateDesktopShellStatus(expired), expired);
  }
  for (const change of [
    { finishedAt: "2026-09-05T12:00:00.000Z" },
    { finishedAt: undefined },
    { result: {} },
    { result: { notificationEvidence: { ...receipt, freshness: "stale" } } },
    { result: { notificationEvidence: { ...receipt, extra: true } } },
    { status: "failed" },
  ]) {
    assert.equal(projectDesktopShellStatus({ refresh: { ...refresh, ...change }, now: NOW }).notificationEvidenceStatus, undefined);
  }
  const expired = projectDesktopShellStatus({ refresh, now: NOW });
  for (const change of [
    { notificationEvidenceStatus: "fresh" },
    { notificationEvidenceStatus: null },
    { schemaVersion: "usagemonitor-desktop-shell-status-v1" },
    { state: "unavailable" },
    { notificationEvidence: receipt },
  ]) {
    assert.throws(() => validateDesktopShellStatus({ ...expired, ...change }), TypeError);
  }
});


test("quota publication survives later usage failure without notification authority", () => {
  const publishedAt = "2026-09-05T11:59:01.000Z";
  const base = { quickResultAt: publishedAt,
    quota: { status: "published", errorCode: null, publishedAt }, result: {} };
  for (const status of ["failed", "degraded", "cancelled"]) {
    const value = projectDesktopShellStatus({ refresh: { ...base, status },
      displayEvidence: displayEvidence(), now: NOW });
    assert.equal(value.state, "fresh");
    assert.equal(value.allowance.remainingPercent, 0);
    assert.equal(value.notificationEvidence, null);
    assert.deepEqual(validateDesktopShellStatus(value), value);
  }
  for (const quota of [
    { ...base.quota, status: "failed" },
    { ...base.quota, errorCode: "quota_publication_failed" },
    { ...base.quota, publishedAt: "2026-09-05T12:00:01.000Z" },
    { ...base.quota, publishedAt: "invalid" },
  ]) {
    const value = projectDesktopShellStatus({ refresh: { ...base, status: "failed", quota },
      displayEvidence: displayEvidence(), now: NOW });
    assert.equal(value.state, "unavailable");
    assert.equal(value.displayEvidence, undefined);
  }
  const stale = projectDesktopShellStatus({ refresh: { ...base, status: "failed" },
    displayEvidence: displayEvidence({ freshness: { status: "stale" } }), now: NOW });
  assert.equal(stale.state, "stale");
  assert.equal(stale.allowance, null);
  assert.equal(stale.notificationEvidence, null);
  assert.ok(stale.displayEvidence);
});
