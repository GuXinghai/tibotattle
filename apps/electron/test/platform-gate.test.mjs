import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  mkdtemp,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  createProductionDistributionMetadata,
  validateProductionDistributionMetadata,
} from "../desktop-updater.js";
import {
  ElectronShellError,
} from "../errors.js";
import {
  launchElectronShell,
} from "../main.js";
import {
  assertElectronPlatformGate,
} from "../platform-gate.js";

function refusal(code) {
  return (error) => {
    assert.equal(error instanceof ElectronShellError, true);
    assert.equal(error.code, `electron_shell_${code}`);
    assert.equal(error.message, "Electron shell operation failed");
    return true;
  };
}

async function withRuntimePlatform({ platform, architecture }, callback) {
  const platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const architectureDescriptor = Object.getOwnPropertyDescriptor(process, "arch");
  Object.defineProperty(process, "platform", { ...platformDescriptor, value: platform });
  Object.defineProperty(process, "arch", { ...architectureDescriptor, value: architecture });
  try {
    return await callback();
  } finally {
    Object.defineProperty(process, "platform", platformDescriptor);
    Object.defineProperty(process, "arch", architectureDescriptor);
  }
}


test("Windows permits only an exact stable x64 candidate without upgrading native readiness", () => {
  const productionDistribution = createProductionDistributionMetadata({
    target: "win32-x64",
    sourceRevision: "c".repeat(40),
    buildNumber: "2026090703",
  });
  assert.deepEqual(assertElectronPlatformGate({
    platform: "win32",
    architecture: "x64",
    productionDistribution,
    environment: {},
  }), {
    platform: "win32",
    architecture: "x64",
    windowsProductionReady: false,
    windowsQualificationOnly: false,
  });
  for (const override of [
    { architecture: "arm64" },
    { qualificationContext: { qualificationOnly: true } },
    { environment: { USAGE_MONITOR_TEST_LANE: "windows-local-qa" } },
    { productionDistribution: { ...productionDistribution, target: "linux-x64" } },
    { productionDistribution: { ...productionDistribution, updateFeed: "https://example.invalid" } },
    { productionDistribution: { ...productionDistribution, unexpected: true } },
  ]) {
    assert.throws(() => assertElectronPlatformGate({
      platform: "win32",
      architecture: "x64",
      productionDistribution,
      environment: {},
      ...override,
    }), refusal("windows_readiness_unavailable"));
  }
});
