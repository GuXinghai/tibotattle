import assert from "node:assert/strict";
import test from "node:test";

import {
  selectProductionParticipantIdentity,
} from "../src/application/index.js";

function baseOptions(overrides = {}) {
  return {
    environmentSecret: null,
    explicitSecretFile: null,
    appStateSecretFile: "/fixed/app-state/export-secret",
    ...overrides,
  };
}

test("application identity selection without an override fails closed", () => {
  assert.throws(
    () => selectProductionParticipantIdentity(baseOptions()),
    (error) => error.code === "EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE",
  );
});

test("identity overrides are selected without any native backend", () => {
  const selected = selectProductionParticipantIdentity(baseOptions({
    explicitSecretFile: "/development/secret",
  }));
  assert.equal(selected.mode, "owner_file_override");
  assert.equal(selected.identityOptions.secretFile, "/development/secret");
  assert.equal(selected.identityOptions.participantSecretBackend, undefined);
  assert.equal(selected.identityOptions.participantSecretCapability, undefined);
});

test("environment override keeps the app state secret file path", () => {
  const selected = selectProductionParticipantIdentity(baseOptions({
    environmentSecret: "development-only-secret",
  }));
  assert.equal(selected.mode, "external_environment_override");
  assert.equal(
    selected.identityOptions.secretFile,
    "/fixed/app-state/export-secret",
  );
  assert.equal(
    selected.identityOptions.environmentSecret,
    "development-only-secret",
  );
});

test("conflicting identity overrides fail closed", () => {
  assert.throws(
    () => selectProductionParticipantIdentity(baseOptions({
      environmentSecret: "development-only-secret",
      explicitSecretFile: "/development/secret",
    })),
    (error) => error.code === "EXPORT_IDENTITY_OVERRIDE_CONFLICT",
  );
});
