import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import * as dataClient from "../public/data-client.js";
import * as library from "../public/lib.js";
import { LOCAL_COMPANION_STATIC_FILES } from "../../local/static-assets.js";
import { CATALOGS } from "@app-usagemonitor/i18n";
import { WEB_MESSAGES } from "../public/localization.js";

test("shipped catalogs contain no retired sharing, consent or community copy", () => {
  for (const catalog of [...Object.values(CATALOGS), WEB_MESSAGES]) {
    for (const key of Object.keys(catalog)) {
      assert.doesNotMatch(key, /^(?:continuityConsent\.|performanceConsent\.|contribution\.|community\.|site\.|electron\.sharing\.|electron\.settings\.sharing\.)/u);
    }
  }
});

const retiredMethods = [
  "incrementalContributionSyncStatus", "pairContributionDevice",
  "resetContributionDeviceCredential", "disconnectContributionDevice",
  "contributionSyncExactReview", "approveIncrementalContribution",
  "reviewAttributionContribution", "approveAttributionContribution",
  "telemetryPerformanceStatus", "reviewTelemetryPerformance",
  "approveTelemetryPerformance", "localContributionMutation", "localPerformanceMutation",
];

test("dashboard client exposes no retired upload, consent, hosted identity or historical parser APIs", () => {
  for (const name of retiredMethods) {
    assert.equal(name in dataClient.LocalCompanionClient.prototype, false, name);
  }
  for (const name of Object.keys(dataClient)) {
    assert.doesNotMatch(name, /Telemetry|Contribution|Participant|Community|Hosted|BackendReadiness|IDENTITY|CONSENT/iu);
  }
  for (const name of Object.keys(library)) {
    assert.doesNotMatch(name, /Telemetry|Contribution|Synthetic|Envelope|Filename|ApiError/iu);
  }
});

test("retired browser assets are absent from the local static allowlist", () => {
  for (const name of ["telemetry-envelope.js", "telemetry-shared.generated.js", "model-catalog.generated.js", "community-data.js"]) {
    assert.equal(Object.hasOwn(LOCAL_COMPANION_STATIC_FILES, `/${name}`), false, name);
  }
  assert.equal(Object.hasOwn(LOCAL_COMPANION_STATIC_FILES, "/codex-catalog.generated.js"), true);
});

test("shipped dashboard helpers contain no hosted route or legacy wire dependency", async () => {
  for (const name of ["data-client.js", "lib.js"]) {
    const source = await readFile(new URL(`../public/${name}`, import.meta.url), "utf8");
    assert.doesNotMatch(source, /telemetry-shared|telemetry-envelope|community-data|\/api\/v1|\/contribution\/|\/performance\/(?:status|review|approve)|accounts\.google\.com|appleid\.apple\.com/iu, name);
  }
});

test("browser diagnostics accept only the active local refresh journey", async () => {
  let calls = 0;
  const client = new dataClient.LocalCompanionClient({ fetchImpl: async () => { calls += 1; throw new Error("unexpected request"); } });
  for (const surface of ["contribution_prepare", "automatic_contribution", "hosted_identity", "participant_deletion"]) {
    assert.equal(library.diagnosticSurface(surface), "");
    await assert.rejects(client.recordDiagnosticNote({ reference: "TT-000000", surface }), TypeError);
  }
  assert.equal(calls, 0);
});
