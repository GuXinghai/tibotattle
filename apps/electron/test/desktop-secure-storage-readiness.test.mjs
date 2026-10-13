import assert from "node:assert/strict";
import test from "node:test";

import {
  awaitDesktopSecureStorageOperation,
  classifyDesktopSecureStorageFailure,
  createDesktopSecureStorageDialog,
  createDesktopSecureStorageFailure,
  DESKTOP_SECURE_STORAGE_FAILURE_REASONS,
  isDesktopSecureStorageFailure,
  normalizeDesktopSecureStorageFailureReason,
} from "../desktop-secure-storage-readiness.js";

const CODE_CASES = Object.freeze([
  ["broker_timeout", "timeout", "SECURE_STORAGE_TIMEOUT"],
  ["adapter_integrity_failed", "adapter_integrity_failed", "SECURE_STORAGE_ADAPTER_INTEGRITY_FAILED"],
  ["broker_unavailable", "security_unavailable", "SECURE_STORAGE_UNAVAILABLE"],
]);

test("secure storage failures keep a closed content-free reason and support code", () => {
  for (const [, reason] of CODE_CASES) {
    assert.ok(DESKTOP_SECURE_STORAGE_FAILURE_REASONS.includes(reason), reason);
  }
  for (const [code, reason, supportCode] of CODE_CASES) {
    const error = Object.assign(new Error("private native detail"), { code });
    assert.equal(isDesktopSecureStorageFailure(error), true);
    assert.equal(classifyDesktopSecureStorageFailure(error), reason);
    const dialog = createDesktopSecureStorageDialog(reason);
    assert.equal(dialog.type, "warning");
    assert.equal(dialog.title, "Unable to prepare secure storage");
    assert.match(dialog.detail, new RegExp(`Support code: ${supportCode}\\.$`, "u"));
    assert.doesNotMatch(JSON.stringify(dialog), /private native detail/u);
    assert.deepEqual(dialog.buttons, ["Quit", "Retry"]);
    assert.equal(dialog.defaultId, 0);
    assert.equal(dialog.cancelId, 0);
  }
});

test("migration-required guidance preserves legacy state and offers no unavailable recovery flow", () => {
  const dialog = createDesktopSecureStorageDialog("migration_required");
  assert.equal(dialog.message, "An existing TiboTattle credential requires migration.");
  assert.match(dialog.detail, /Quit and contact support with the support code below/u);
  assert.match(dialog.detail, /The legacy credential is preserved\./u);
  assert.match(dialog.detail, /Do not delete or reset credentials or app data\./u);
  assert.match(dialog.detail, /Retry only repeats the secure credential check/u);
  assert.match(dialog.detail, /neither Retry nor reinstalling this release migrates the credential\./u);
  assert.match(dialog.detail, /No credential was created, replaced, or deleted\./u);
  assert.match(dialog.detail, /Support code: SECURE_STORAGE_MIGRATION_REQUIRED\.$/u);
  assert.doesNotMatch(dialog.detail, /Secure upgrade|Review migration|Approve migration|Settings/u);
  assert.deepEqual(dialog.buttons, ["Quit", "Retry"]);
  assert.equal(dialog.defaultId, 0);
  assert.equal(dialog.cancelId, 0);
});

test("unknown or hostile failures collapse to security unavailable", () => {
  const hostile = new Proxy({}, { get() { throw new Error("private detail"); } });
  for (const value of [undefined, null, {}, hostile]) {
    assert.equal(classifyDesktopSecureStorageFailure(value), "security_unavailable");
    assert.equal(isDesktopSecureStorageFailure(value), false);
  }
  assert.equal(normalizeDesktopSecureStorageFailureReason("not-a-reason"),
    "security_unavailable");
});

test("localized secure storage recovery keeps support codes and safe defaults", () => {
  for (const reason of DESKTOP_SECURE_STORAGE_FAILURE_REASONS) {
    const english = createDesktopSecureStorageDialog(reason);
    const chinese = createDesktopSecureStorageDialog(reason, { locale: "system", systemLocales: ["zh-CN"] });
    const spanish = createDesktopSecureStorageDialog(reason, { locale: "es" });
    const supportCode = english.detail.match(/SECURE_STORAGE_[A-Z_]+/u)?.[0];
    assert.equal(chinese.title, "无法准备安全存储");
    assert.deepEqual(chinese.buttons, ["退出", "重试"]);
    assert.match(chinese.detail, /未创建、替换或删除任何凭据/u);
    assert.ok(chinese.detail.endsWith(`支持代码：${supportCode}。`));
    assert.deepEqual(spanish.buttons, ["Salir", "Reintentar"]);
    assert.ok(spanish.detail.endsWith(`Código de soporte: ${supportCode}.`));
    for (const dialog of [chinese, spanish]) {
      assert.equal(dialog.defaultId, 0);
      assert.equal(dialog.cancelId, 0);
      assert.doesNotMatch(JSON.stringify(dialog), /electron\.(?:secureStorage|recovery)\./u);
    }
  }
  const migration = createDesktopSecureStorageDialog("migration_required", { locale: "zh-Hans" });
  assert.match(migration.detail, /请勿删除或重置凭据或应用数据/u);
  assert.match(migration.detail, /重试或重新安装此版本均无法迁移凭据/u);
});

test("explicit readiness failures retain only a fixed reason", () => {
  const error = createDesktopSecureStorageFailure("credential_invalid");
  assert.equal(error.code, "desktop_secure_storage_unavailable");
  assert.equal(error.secureStorageReason, "credential_invalid");
  assert.equal(classifyDesktopSecureStorageFailure(error), "credential_invalid");
  assert.equal(isDesktopSecureStorageFailure(error), true);
});

test("secure storage operations have a bounded content-free timeout", async () => {
  let resolveLateRead;
  const lateSecret = Buffer.alloc(32, 19);
  await assert.rejects(
    awaitDesktopSecureStorageOperation(() => new Promise((resolve) => {
      resolveLateRead = resolve;
    }), {
      timeoutMs: 5,
      disposeLateResult(value) {
        value.fill(0);
      },
    }),
    (error) => error?.code === "desktop_secure_storage_unavailable"
      && error.secureStorageReason === "timeout",
  );
  resolveLateRead(lateSecret);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(lateSecret, Buffer.alloc(32));
  await assert.rejects(
    awaitDesktopSecureStorageOperation(() => null, { timeoutMs: 0 }),
    (error) => error?.secureStorageReason === "adapter_integrity_failed",
  );
});
