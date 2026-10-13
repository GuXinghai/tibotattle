import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION,
  AUTOMATIC_CONTRIBUTION_RETIRED_SETTINGS_SCHEMA_VERSIONS,
  AutomaticContributionRetirementError,
  retireAutomaticContributionState,
} from "../src/automatic-contribution-retirement.js";

import { createWindowsFilesystemAdapter } from "../src/platform/index.js";
import { assertWindowsOwnerOnly, grantSyntheticEveryoneRead } from "./helpers/windows-owner-only-fixture.js";

const RETIRED_AT = "2026-08-27T12:00:00.000Z";

async function ownerRoot() {
  const parent = await mkdtemp(join(tmpdir(), "automatic-retirement-"));
  const root = join(parent, "private");
  createWindowsFilesystemAdapter().ensureDirectory(root);
  return root;
}

test("automatic retirement writes one atomic content-free downgrade tombstone", async () => {
  const root = await ownerRoot();
  const settingsFile = join(root, "private", "automatic-settings.json");
  const queueFile = join(root, "queue.json");
  const preparedFile = join(root, "prepared.bin");
  await writeFile(queueFile, "queue-must-survive", { mode: 0o600 });
  await writeFile(preparedFile, "prepared-must-survive", { mode: 0o600 });
  try {
    const first = await retireAutomaticContributionState({
      settingsFile,
      now: () => new Date(RETIRED_AT),
    });
    assert.deepEqual(first, {
      status: "retired",
      schemaVersion: AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION,
      retiredAt: RETIRED_AT,
      priorState: "absent",
      networkActivity: false,
    });
    const persisted = JSON.parse(await readFile(settingsFile, "utf8"));
    assert.deepEqual(persisted, {
      schemaVersion: AUTOMATIC_CONTRIBUTION_RETIREMENT_SCHEMA_VERSION,
      retiredAt: RETIRED_AT,
      priorState: "absent",
      networkActivity: false,
    });
    assertWindowsOwnerOnly(settingsFile);
    assert.equal(await readFile(queueFile, "utf8"), "queue-must-survive");
    assert.equal(await readFile(preparedFile, "utf8"), "prepared-must-survive");

    const second = await retireAutomaticContributionState({
      settingsFile,
      now: () => new Date("2027-01-01T00:00:00.000Z"),
    });
    assert.equal(second.status, "already_retired");
    assert.equal(second.retiredAt, RETIRED_AT);
    assert.equal(
      AUTOMATIC_CONTRIBUTION_RETIRED_SETTINGS_SCHEMA_VERSIONS.includes(
        persisted.schemaVersion,
      ),
      false,
      "the tombstone must remain outside every retired scheduler schema",
    );
  } finally {
    await rm(dirname(root), { recursive: true });
  }
});

test("automatic retirement records only coarse legacy state", async () => {
  for (const [source, expected] of [
    [{ schemaVersion: "automatic-contribution-settings-v0.4", enabled: true }, "enabled"],
    [{ schemaVersion: "automatic-contribution-settings-v0.1", enabled: false }, "disabled"],
    ["not-json", "unavailable"],
  ]) {
    const root = await ownerRoot();
    const settingsFile = join(root, "automatic-settings.json");
    try {
      createWindowsFilesystemAdapter().createFile(settingsFile, Buffer.from(
        typeof source === "string" ? source : JSON.stringify(source)));
      const result = await retireAutomaticContributionState({
        settingsFile,
        now: () => new Date(RETIRED_AT),
      });
      assert.equal(result.priorState, expected);
      const serialized = await readFile(settingsFile, "utf8");
      assert.equal(serialized.includes("consent"), false);
      assert.equal(serialized.includes("destination"), false);
    } finally {
      await rm(dirname(root), { recursive: true });
    }
  }
});

test("automatic retirement refuses unsafe files without replacing them", async (t) => {
  for (const unsafe of ["acl", "symlink"]) {
    const root = await ownerRoot();
    const settingsFile = join(root, "automatic-settings.json");
    const target = join(root, "target.json");
    try {
      if (unsafe === "acl") {
        createWindowsFilesystemAdapter().createFile(settingsFile, Buffer.from("unsafe-mode"));
        grantSyntheticEveryoneRead(settingsFile);
      } else {
        await writeFile(target, "symlink-target", { mode: 0o600 });
        await symlink(target, settingsFile);
      }
      await assert.rejects(
        retireAutomaticContributionState({ settingsFile }),
        (error) => error instanceof AutomaticContributionRetirementError
          && error.code === "automatic_contribution_retirement_settings_unavailable",
      );
      assert.equal(
        await readFile(unsafe === "acl" ? settingsFile : target, "utf8"),
        unsafe === "acl" ? "unsafe-mode" : "symlink-target",
      );
    } finally {
      await rm(dirname(root), { recursive: true });
    }
  }
});
