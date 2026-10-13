import test from "node:test";
import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createDesktopContributionCredentialLegacyProbe,
  createDesktopContributionCredentialLegacyRecoveryBackend,
} from "../desktop-contribution-credential.js";

function cryptoFixture() {
  const key = randomBytes(32);
  let reencryptNextDecrypt = false;
  let encryptions = 0;
  return {
    requestReencrypt() { reencryptNextDecrypt = true; },
    get encryptions() { return encryptions; },
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => "gnome_libsecret",
    async encryptStringAsync(value) {
      encryptions += 1;
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const body = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
      return Buffer.concat([iv, cipher.getAuthTag(), body]);
    },
    async decryptStringAsync(value) {
      const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12));
      decipher.setAuthTag(value.subarray(12, 28));
      const shouldReEncrypt = reencryptNextDecrypt;
      reencryptNextDecrypt = false;
      return { result: Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"), shouldReEncrypt };
    },
  };
}


test("Windows legacy ciphertext requires recovery without safeStorage or record mutation", async () => {
  const calls = [];
  const legacy = {
    schemaVersion: "accountless-encrypted-credential-v1",
    encrypted: "AAAA",
  };
  const probe = createDesktopContributionCredentialLegacyProbe({
    platform: "win32",
    storage: {
      async load() {
        calls.push("load");
        return legacy;
      },
      async save() {
        calls.push("save");
        assert.fail("legacy inspection must not write");
      },
    },
  });
  const guarded = createDesktopContributionCredentialLegacyRecoveryBackend({
    backend: {
      async read() { calls.push("native-read"); return null; },
      async createIfMissing() { calls.push("native-create"); return "created"; },
      async deleteExact() { calls.push("native-delete"); return "missing"; },
    },
    legacyCredentialProbe: probe.inspect,
  });
  await assert.rejects(guarded.read(), (error) => error?.code
    === "contribution_device_credential_recovery_required"
    && error?.retryable === false);
  assert.deepEqual(calls, ["load"]);
  assert.deepEqual(legacy, {
    schemaVersion: "accountless-encrypted-credential-v1",
    encrypted: "AAAA",
  });
});
