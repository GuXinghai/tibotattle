import test from "node:test";
import assert from "node:assert/strict";

import {
  deriveTelemetryAccountTrackIdV2,
  deriveTelemetryPlanEraIdV1,
  isTelemetryAccountTrackIdV2,
  UNATTRIBUTED_ACCOUNT_TRACK_ID,
} from "../src/contribution/account-track.js";

const attributedTrack = `account-track:v2:${"a".repeat(64)}`;
const planEraInputs = Object.freeze({
  accountTrackId: attributedTrack,
  planType: "pro",
  eraStartOccurrenceId: "synthetic-occurrence-0001",
  accountObservationSecret: Buffer.alloc(32, 0x59),
  destinationOrigin: "https://synthetic.invalid",
  enrollmentNamespace: "synthetic-enrollment-0001",
});

test("unattributed account-track sentinel cannot derive a plan-era pseudonym", () => {
  assert.equal(isTelemetryAccountTrackIdV2(UNATTRIBUTED_ACCOUNT_TRACK_ID), true);
  assert.equal(deriveTelemetryPlanEraIdV1({
    ...planEraInputs,
    accountTrackId: UNATTRIBUTED_ACCOUNT_TRACK_ID,
  }), null);
});

test("plan-era derivation returns null until every independent binding is present", () => {
  for (const incomplete of [
    { accountObservationSecret: null },
    { destinationOrigin: null },
    { enrollmentNamespace: null },
    { eraStartOccurrenceId: null },
    { planType: "unknown" },
  ]) {
    assert.equal(deriveTelemetryPlanEraIdV1({ ...planEraInputs, ...incomplete }), null);
  }
});

test("attributed plan-era derivation remains deterministic and account v2 keeps its sentinel contract", () => {
  const first = deriveTelemetryPlanEraIdV1(planEraInputs);
  assert.equal(typeof first, "string");
  assert.notEqual(first, UNATTRIBUTED_ACCOUNT_TRACK_ID);
  assert.equal(deriveTelemetryPlanEraIdV1(planEraInputs), first);

  assert.equal(deriveTelemetryAccountTrackIdV2(), UNATTRIBUTED_ACCOUNT_TRACK_ID);
  assert.equal(deriveTelemetryAccountTrackIdV2({
    accountScope: {
      status: "unavailable",
      reason: "missing_account",
      version: "openai-account-v1",
      scopeId: null,
      planType: null,
    },
    accountObservationSecret: Buffer.alloc(32, 0x59),
    destinationOrigin: planEraInputs.destinationOrigin,
    enrollmentNamespace: planEraInputs.enrollmentNamespace,
  }), UNATTRIBUTED_ACCOUNT_TRACK_ID);
});
