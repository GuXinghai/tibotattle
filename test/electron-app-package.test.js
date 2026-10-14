import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  access,
  lstat,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

import {
  buildElectronApp,
  parseElectronAppArguments,
} from "../scripts/build-electron-app.mjs";
import {
  assertStagedElectronShellModuleLinkage,
  assertStagedElectronShellNodeLinkage,
  buildElectronRuntime,
  ELECTRON_TARGETS,
  ELECTRON_SHELL_RUNTIME_FILES,
} from "../scripts/build-electron-runtime.mjs";
import { RELEASE_VERSION } from "../config/release-manifest.js";

const require = createRequire(import.meta.url);
const BUILDER_CONFIG = require("../apps/electron/electron-builder.config.cjs");
const BUILDER_CONFIG_PATH = resolve("apps/electron/electron-builder.config.cjs");

function loadBuilderConfigForTarget(target) {
  const source = [
    `const config = require(${JSON.stringify(BUILDER_CONFIG_PATH)});`,
    "process.stdout.write(JSON.stringify(config));",
  ].join("\n");
  return JSON.parse(execFileSync(process.execPath, ["-e", source], {
    cwd: resolve("."),
    env: { ...process.env, TIBOTATTLE_ELECTRON_TARGET: target },
    encoding: "utf8",
  }));
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "tibotattle-electron-app-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Electron app staging includes the shell and keeps the companion manifest valid", async () => {
  await withTemporaryDirectory(async (root) => {
    const result = await buildElectronApp({ output: join(root, "app") });
    const packageJson = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const paths = manifest.files.map(({ path }) => path);

    assert.equal(result.output, resolve(root, "app"));
    assert.equal(packageJson.main, "apps/electron/main.js");
    assert.equal(manifest.entrypoint, "apps/electron/main.js");
    assert.equal(manifest.target, "win32");
    assert.equal(manifest.architecture, "x64");
    for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
      await access(join(result.output, relativePath));
      assert.ok(paths.includes(relativePath), relativePath);
    }
    assert.ok(paths.includes("src/platform/windows-credential-manager-probe.js"));
    const shellClosure = await assertStagedElectronShellModuleLinkage(result.output);
    assert.ok(shellClosure.includes("src/platform/windows-credential-manager-probe.js"));
    assert.ok(shellClosure.includes("src/platform/windows-native-unsigned-content.js"));
    await access(join(result.output, "apps/local/server.js"));
    await access(join(result.output, "apps/web/public/index.html"));
    assert.ok(paths.every((path) => !/(^|\/)(?:docs?|tests?)(?:\/|$)/iu.test(path)));
    assert.ok(!paths.some((path) => path.includes("windows_filesystem_qualification")));
    assert.ok(!paths.some((path) => path.startsWith("native/windows-filesystem/")));
  });
});


test("Electron builder configuration exposes an unsigned Windows x64 directory target", () => {
  const config = loadBuilderConfigForTarget("win32");
  assert.match(config.directories.app, /\.release-build[\\/]electron-dev[\\/]win32-x64[\\/]app$/u);
  assert.match(config.directories.output, /\.release-build[\\/]electron-dev[\\/]win32-x64[\\/]artifacts$/u);
  assert.deepEqual(config.asarUnpack, [
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
  ]);
  assert.deepEqual(config.asar, { smartUnpack: false });
  assert.deepEqual(config.win.target, [{ target: "dir", arch: ["x64"] }]);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.win.signExecutable, false);
  assert.equal(config.publish, null);
  assert.equal(config.forceCodeSigning, false);
});





test("staged Electron linkage fails closed for missing modules and packages", async () => {
  await withTemporaryDirectory(async (root) => {
    const relative = await buildElectronRuntime({
      output: join(root, "missing-relative"),
      includeElectronShell: true,
    });
    await rm(join(relative.output, "apps/electron/desktop-first-run.js"));
    await assert.rejects(
      () => assertStagedElectronShellModuleLinkage(relative.output),
      (error) => error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE",
    );
    await assert.rejects(
      () => assertStagedElectronShellNodeLinkage(relative.output),
      (error) => error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE",
    );

    const packageManifest = await buildElectronRuntime({
      output: join(root, "missing-workspace-manifest"),
      includeElectronShell: true,
    });
    await rm(join(
      packageManifest.output,
      "node_modules/@app-usagemonitor/telemetry-contract/package.json",
    ));
    await assert.rejects(
      () => assertStagedElectronShellModuleLinkage(packageManifest.output),
      (error) => error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE",
    );

    const workspaceFile = await buildElectronRuntime({
      output: join(root, "missing-workspace-file"),
      includeElectronShell: true,
    });
    await rm(join(
      workspaceFile.output,
      "node_modules/@app-usagemonitor/telemetry-contract/src/constants.js",
    ));
    await assert.rejects(
      () => assertStagedElectronShellNodeLinkage(workspaceFile.output),
      (error) => error?.code === "ELECTRON_RUNTIME_STAGED_MODULE_LINKAGE",
    );
  });
});

test("Windows Electron staging requires the reviewed native binding pair", async () => {
  await withTemporaryDirectory(async (root) => {
    await assert.rejects(
      () => buildElectronApp({
        output: join(root, "missing-inputs"),
        target: "win32",
        windowsBindingPath: join(root, "missing.node"),
        windowsManifestPath: join(root, "missing.node.manifest.json"),
      }),
      (error) => error.code === "ELECTRON_APP_WINDOWS_INPUT_REQUIRED",
    );
  });
});

test("Windows Electron staging includes the exact binding pair and shell", async () => {
  await withTemporaryDirectory(async (root) => {
    const bindingPath = join(root, "windows_filesystem.node");
    const manifestPath = join(root, "windows_filesystem.node.manifest.json");
    const binding = Buffer.from("synthetic reviewed Windows binding\n", "utf8");
    await writeFile(bindingPath, binding, { mode: 0o600 });
    await writeFile(manifestPath, `${JSON.stringify({
      bindingFile: "windows_filesystem.node",
      platform: "win32",
      architecture: "x64",
      bytes: binding.byteLength,
      sha256: sha256(binding),
    })}\n`, { mode: 0o600 });

    const result = await buildElectronApp({
      output: join(root, "windows-app"),
      target: "windows",
      packagingProfile: "windows-production",
      packageVersion: RELEASE_VERSION,
      windowsBindingPath: bindingPath,
      windowsManifestPath: manifestPath,
    });
    const packageJson = JSON.parse(await readFile(join(result.output, "package.json"), "utf8"));
    const manifest = JSON.parse(await readFile(result.manifestPath, "utf8"));
    const paths = manifest.files.map(({ path }) => path);

    assert.equal(packageJson.main, "apps/electron/main.js");
    assert.equal(packageJson.productName, "TiboTattle");
    for (const path of [
      "node_modules/@app-usagemonitor/quota-analysis/src/workload.js",
      "src/local-index-workload.js",
      "apps/local/overview-refresh-scheduler.js",
      "apps/web/public/overview-workload.js",
    ]) assert.ok(paths.includes(path), path);
    assert.equal(packageJson.version, RELEASE_VERSION);
    assert.equal(manifest.target, "win32");
    assert.equal(manifest.architecture, "x64");
    assert.equal(manifest.entrypoint, "apps/electron/main.js");
    assert.equal(manifest.windowsBinding.included, true);
    assert.equal(manifest.windowsBinding.verified, false);
    assert.equal(manifest.windowsBinding.status, "included_unverified");
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node"));
    assert.ok(paths.includes("native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json"));
    for (const relativePath of ELECTRON_SHELL_RUNTIME_FILES) {
      await access(join(result.output, relativePath));
      assert.ok(paths.includes(relativePath), relativePath);
    }
    const shellClosure = await assertStagedElectronShellModuleLinkage(result.output);
    assert.ok(shellClosure.includes("src/platform/windows-credential-manager-probe.js"));
    assert.ok(shellClosure.includes("src/platform/windows-native-unsigned-content.js"));
    assert.ok(!paths.some((path) => path.includes("windows_filesystem_qualification")));
    assert.ok(!paths.some((path) => /(^|\/)(?:docs?|tests?)(?:\/|$)/iu.test(path)));
  });
});


test("Electron app rejects production profile outside the Windows shell release boundary", async () => {
  await withTemporaryDirectory(async (root) => {
    await assert.rejects(
      () => buildElectronApp({
        output: join(root, "unknown-profile"),
        packagingProfile: "unknown",
      }),
      (error) => error.code === "ELECTRON_APP_INVALID_PROFILE",
    );
    await assert.rejects(
      () => buildElectronRuntime({
        output: join(root, "windows-production-companion-only"),
        target: "win32-x64",
        packagingProfile: "windows-production",
        includeElectronShell: false,
      }),
      (error) => error.code === "ELECTRON_RUNTIME_PACKAGING_PROFILE_TARGET",
    );
    await assert.rejects(
      () => buildElectronApp({
        output: join(root, "wrong-version"),
        packagingProfile: "development",
        packageVersion: "9.9.9",
      }),
      (error) => error.code === "ELECTRON_RUNTIME_INVALID_PACKAGE_VERSION",
    );
  });
});
