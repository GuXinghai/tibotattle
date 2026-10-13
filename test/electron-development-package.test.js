import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { developmentBuildEnvironment, developmentPackagePlan, executableArchitecture, parseDevelopmentPackageArguments, writeDevelopmentHandoff } from "../scripts/package-electron-development.mjs";

import { parseProductionCandidateArguments } from "../scripts/package-electron-production.mjs";

const sourceRevision = "a".repeat(40);

test("targeted diagnostic runs retain full push qualification and use the same runtime jobs", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  assert.match(workflow, /qualification:\n\s+description:[^\n]+\n\s+required: true\n\s+default: full\n\s+type: choice/u);
  assert.match(workflow, /group: electron-development-packages-\$\{\{ github.ref \}\}-\$\{\{ inputs.qualification \|\| 'full' \}\}/u);
  assert.match(workflow, /cancel-in-progress: false/u);
  const jobs = [...workflow.matchAll(/^  ([a-z][a-z0-9-]+):\n    if: ([^\n]+)$/gmu)];
  const all = ["win32-x64", "win32-x64-normal-candidate", "win32-x64-nsis-lifecycle"];
  assert.deepEqual(jobs.map(([, id]) => id), all);
  const selected = (eventName, qualification) => jobs.filter(([, , expression]) => {
    // These simple predicates use only syntax shared by JS and Actions.
    assert.match(expression, /^[a-zA-Z0-9_.' =!|\-]+$/u);
    return runInNewContext(expression, { github: { event_name: eventName }, inputs: { qualification } }, { timeout: 100 });
  }).map(([, id]) => id);
  for (const qualification of [undefined, "full", "windows-runtime"]) {
    assert.deepEqual(selected("push", qualification), all, "pushes always require every job");
  }
  assert.deepEqual(selected("workflow_dispatch", "full"), all);
  assert.deepEqual(selected("workflow_dispatch", "windows-runtime"), ["win32-x64-normal-candidate"]);
  assert.deepEqual(selected("workflow_dispatch", "native-runtime"), [], "retired non-Windows lane selects nothing");
  assert.deepEqual(selected("workflow_dispatch", "unknown"), []);
  assert.match(workflow, /win32-x64-nsis-lifecycle:[\s\S]*?needs: win32-x64/u);
});



test("package CLI refuses unknown targets, publication flags, duplicate selections and ambiguous native inputs", () => {
  for (const args of [
    ["--target", "linux-arm64"], ["--publish", "always"], ["--target", "darwin-x64", "--target", "darwin-arm64"],
    ["--format", "release"], ["--windows-binding", "binding.node"],
    ["--target", "linux-x64", "--windows-binding", "binding.node", "--windows-manifest", "manifest.json"],
  ]) assert.throws(() => parseDevelopmentPackageArguments(args), /ELECTRON_DEVELOPMENT_/u);
  const options = parseDevelopmentPackageArguments(["--target", "win32-x64", "--format", "dir", "--windows-binding", "binding.node", "--windows-manifest", "manifest.json", "--dry-run"]);
  assert.equal(options.dryRun, true);
  assert.equal(options.replaceStaging, false);
  assert.equal(options.windowsBindingPath, "binding.node");
  assert.throws(() => developmentPackagePlan({ target: "darwin-arm64", sourceRevision: "main" }), /PLAN_INVALID/u);
});

test("development builder cannot inherit signing, publishing or application credentials", () => {
  const env = developmentBuildEnvironment({ PATH: "/safe/bin", HOME: "/safe/home", CSC_LINK: "private", WIN_CSC_LINK: "private", CSC_KEY_PASSWORD: "private", GH_TOKEN: "private", APPLE_ID: "private", APPLE_APP_SPECIFIC_PASSWORD: "private", APP_USAGEMONITOR_EXPORT_SECRET: "private", USAGE_MONITOR_CENTRAL_ORIGIN: "https://example.invalid", TIBOTATTLE_ELECTRON_TARGET: "win32-x64" }, "win32-x64");
  assert.deepEqual(Object.keys(env).sort(), ["CSC_IDENTITY_AUTO_DISCOVERY", "HOME", "PATH", "TIBOTATTLE_ELECTRON_TARGET", "TIBOTATTLE_ELECTRON_VERSION"]);
  assert.equal(env.CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.equal(env.TIBOTATTLE_ELECTRON_TARGET, "win32-x64");
  assert.equal(JSON.stringify(env).includes("private"), false);
  assert.throws(() => developmentBuildEnvironment({ PATH: "/safe/bin" }, "darwin-arm64"), /TARGET_OR_FORMAT_INVALID/u);
});

test("artifact machine verification rejects an incorrect or malformed executable", () => {
  for (const cpu of [0x0100000c, 0x01000007]) {
    const header = Buffer.alloc(64); header.writeUInt32LE(0xfeedfacf); header.writeUInt32LE(cpu, 4);
    assert.throws(() => executableArchitecture(header), /EXECUTABLE_ARCHITECTURE/u);
  }
  const elf = Buffer.alloc(64); Buffer.from([0x7f, 0x45, 0x4c, 0x46, 2, 1]).copy(elf); elf.writeUInt16LE(62, 18);
  assert.throws(() => executableArchitecture(elf), /EXECUTABLE_ARCHITECTURE/u);
  elf.writeUInt16LE(183, 18);
  assert.throws(() => executableArchitecture(elf), /EXECUTABLE_ARCHITECTURE/u);
  const pe = Buffer.alloc(256); pe.write("MZ"); pe.writeUInt32LE(128, 60); pe.write("PE\0\0", 128); pe.writeUInt16LE(0x8664, 132);
  assert.equal(executableArchitecture(pe), "win32-x64");
  pe.writeUInt32LE(65535, 60);
  assert.throws(() => executableArchitecture(pe), /EXECUTABLE_ARCHITECTURE/u);
  for (const header of [Buffer.alloc(0), Buffer.from("arbitrary"), Buffer.alloc(64)]) assert.throws(() => executableArchitecture(header), /EXECUTABLE_ARCHITECTURE/u);
});

test("the development workflow builds Windows on a static native runner without release authority", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /  push:\n    branches:\n      - codex\/unified-desktop-accountless\n/u);
  assert.match(workflow, /contents: read/u);
  assert.doesNotMatch(workflow, /pull_request_target|secrets\.|contents: write|id-token: write|--publish always/u);
  const jobs = workflow.split(/\n(?= {2}[a-z][a-z0-9-]+:\n)/u);
  for (const [target, runner] of [["win32-x64", "windows-2025"]]) {
    const job = jobs.find((section) => section.startsWith(`  ${target}:\n`));
    assert.ok(job);
    assert.ok(job.includes(`runs-on: ${runner}\n`));
    assert.ok(job.includes(`package-electron-development.mjs --target ${target} --format distribution --replace-staging`));
    assert.ok(job.includes(`/\${{ github.sha }}/${target}/distribution/`));
  }
  assert.doesNotMatch(workflow, /Add the (?:Windows|Linux) development launch handoff/u,
    "handoff assembly belongs to the common local/CI packaging command");
  assert.equal((workflow.match(/persist-credentials: false/gu) ?? []).length, 3);
  assert.equal((workflow.match(/if-no-files-found: error/gu) ?? []).length, 3);
  assert.match(workflow, /WINDOWS_BINDING_BUILD_FAILED/u);
  assert.doesNotMatch(workflow, /darwin|macos|linux|ubuntu/iu, "development packaging is Windows-only");

  const windowsPackageJob = jobs.find((section) => section.startsWith("  win32-x64:\n"));
  const windowsLifecycleJob = jobs.find((section) => section.startsWith("  win32-x64-nsis-lifecycle:\n"));
  assert.ok(windowsPackageJob);
  assert.ok(windowsLifecycleJob);
  assert.match(windowsPackageJob, /outputs:\n\s+development-artifact-id: \$\{\{ steps\.retain-win32-development\.outputs\.artifact-id \}\}/u);
  assert.match(windowsPackageJob, /id: retain-win32-development/u);
  assert.match(windowsPackageJob, /include-hidden-files: true/u);
  assert.match(windowsPackageJob, /\.release-build\/electron-dev\/win32-x64\/app\//u);
  assert.match(windowsPackageJob, /id: validate-win32-retained-inputs/u);
  assert.match(windowsPackageJob, /WINDOWS_RETAINED_ARTIFACT_REPARSE_POINT/u);
  assert.match(windowsPackageJob, /WINDOWS_RETAINED_ARTIFACT_HIDDEN_TOPOLOGY/u);
  assert.match(windowsPackageJob, /ValidateSet\('distribution', 'staged'\)/u);
  assert.match(windowsPackageJob, /ValidateSet\('dot_directory', 'dot_file', 'missing'\)/u);
  assert.match(windowsPackageJob, /ValidateSet\('approved_json_schema', 'approved_fast_uri', 'unapproved'\)/u);
  assert.match(windowsPackageJob, /excludedHiddenDirectory = '\.icon-ico'/u);
  assert.match(windowsPackageJob, /\$isFixedExcludedCache = \$rootSpec\.inventoryRoot -ceq 'distribution'/u);
  assert.match(windowsPackageJob, /if \(\$isFixedExcludedCache\) \{ continue \}/u);
  assert.match(windowsPackageJob, /!\.release-build\/electron-candidates\/\$\{\{ github\.sha \}\}\/win32-x64\/distribution\/\.icon-ico\/\*\*/u);
  assert.match(windowsPackageJob, /node_modules\/json-schema-traverse\/\.eslintrc\.yml/u);
  assert.match(windowsPackageJob, /b1ea981e2461f053646b08a616efcaba0d3b278b223957e9eb931bcbc3971ccc/u);
  assert.match(windowsPackageJob, /node_modules\/fast-uri\/\.gitattributes/u);
  assert.match(windowsPackageJob, /e173bffc6cde613d3e6d06e49f2b1d05385cb02aa68c4931656b5b051ab649dd/u);
  assert.match(
    windowsPackageJob,
    /if: \$\{\{ !cancelled\(\) && steps\.validate-win32-retained-inputs\.outcome == 'success' \}\}/u,
  );
  assert.ok(
    windowsPackageJob.indexOf("Exercise synthetic upload and account-observation storage")
      < windowsPackageJob.indexOf("Validate exact retained Windows artifact inputs"),
  );
  assert.ok(
    windowsPackageJob.indexOf("Validate exact retained Windows artifact inputs")
      < windowsPackageJob.indexOf("Retain verified Windows package, staging tree, and receipts"),
  );
  assert.doesNotMatch(windowsPackageJob, /Exercise unsigned NSIS install/u);

  assert.match(windowsLifecycleJob, /needs: win32-x64/u);
  assert.match(windowsLifecycleJob, /runs-on: windows-2025/u);
  assert.match(windowsLifecycleJob, /persist-credentials: false/u);
  assert.match(windowsLifecycleJob, /pnpm install --frozen-lockfile --ignore-scripts/u);
  assert.match(windowsLifecycleJob, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/u);
  assert.match(windowsLifecycleJob, /artifact-ids: \$\{\{ needs\.win32-x64\.outputs\.development-artifact-id \}\}/u);
  assert.match(windowsLifecycleJob, /merge-multiple: true/u);
  assert.match(windowsLifecycleJob, /\.release-build\/electron-dev\/win32-x64\/app/u);
  assert.match(windowsLifecycleJob, /smoke-electron-windows-nsis-lifecycle\.mjs/u);
  assert.match(windowsLifecycleJob, /Retain Windows NSIS lifecycle receipt/u);
  assert.doesNotMatch(windowsLifecycleJob, /smoke-electron-windows-accountless\.mjs/u);
});


test("normal Windows CI keeps unsigned candidate bytes private and preserves the release configuration", async () => {
  const workflow = await readFile(new URL("../.github/workflows/electron-development-packages.yml", import.meta.url), "utf8");
  const jobs = workflow.split(/\n(?= {2}[a-z][a-z0-9-]+:\n)/u);
  const job = jobs.find((section) => section.startsWith("  win32-x64-normal-candidate:\n"));
  assert.ok(job);
  assert.match(job, /runs-on: windows-2025/u);
  assert.doesNotMatch(job, /needs:|download-artifact|secrets\.|qualification-smoke|accountless-storage-smoke/u,
    "normal credentials start in an independent disposable account");
  assert.match(job, /rebuild --directory native\/windows-filesystem/u);
  assert.match(job, /node scripts\/build-windows-filesystem-manifest\.mjs/u);
  const prepare = job.slice(job.indexOf("- name: Prepare the unsigned Windows"),
    job.indexOf("- name: Exercise normal Windows"));
  const preparationLine = prepare.match(/^\s+node scripts\/package-electron-production\.mjs (.+)$/mu)?.[1];
  assert.ok(preparationLine);
  const expanded = preparationLine.replaceAll("$env:GITHUB_SHA", sourceRevision)
    .replaceAll("$env:GITHUB_RUN_NUMBER", "1234567");
  const parsed = parseProductionCandidateArguments(expanded.split(/\s+/u));
  assert.equal(parsed.target, "win32-x64");
  assert.equal(parsed.sourceRevision, sourceRevision);
  assert.equal(parsed.buildNumber, "1234567");
  assert.doesNotMatch(prepare, /GITHUB_RUN_ID|TIBOTATTLE_ELECTRON_REHEARSAL/u);
  const builderArguments = prepare.match(/^\s+pnpm exec electron-builder (.+)$/mu)?.[1].split(/\s+/u);
  assert.deepEqual(builderArguments, [
    "--config", "apps/electron/electron-builder.production.config.cjs",
    "--win", "dir", "--x64", "--publish", "never",
    "--config.forceCodeSigning=false", "--config.win.signExecutable=false",
  ]);
  const script = [
    'const { createRequire } = require("node:module");',
    'const req = createRequire(require.resolve("electron-builder"));',
    `process.argv = [process.execPath, "electron-builder", ...${JSON.stringify(builderArguments)}];`,
    'const builder = req("./builder.js");',
    'const { getConfig, validateConfiguration } = req("app-builder-lib/out/util/config/config.js");',
    'const { DebugLogger } = req("builder-util");',
    'builder.build = async (rawOptions) => {',
    'const options = builder.normalizeOptions(rawOptions);',
    'const config = await getConfig(process.cwd(), null, options.config);',
    'await validateConfiguration(config, new DebugLogger(false));',
    'process.stdout.write(JSON.stringify({ config, publish: options.publish, targets: [...options.targets].map(([platform, arches]) => ({ platform: platform.nodeName, arches: [...arches] })) }));',
    '};',
    'req("./cli/cli.js");',
  ].join("\n");
  const releaseVersion = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")).version;
  const output = execFileSync(process.execPath, ["-e", script], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("TIBOTATTLE_ELECTRON_"))),
      TIBOTATTLE_ELECTRON_TARGET: "win32-x64", TIBOTATTLE_ELECTRON_SOURCE_REVISION: sourceRevision,
      TIBOTATTLE_ELECTRON_BUILD_NUMBER: "1234567", TIBOTATTLE_ELECTRON_VERSION: releaseVersion,
    },
  });
  const result = JSON.parse(output.trim().split(/\r?\n/u).at(-1));
  assert.equal(result.config.forceCodeSigning, false);
  assert.equal(result.config.win.signExecutable, false);
  assert.equal(result.config.win.signAndEditExecutable, true);
  assert.equal(result.config.win.verifyUpdateCodeSignature, true);
  assert.equal(result.config.extraMetadata.tibotattleDistribution.channel, "stable");
  assert.equal(result.config.extraMetadata.tibotattleDistribution.sourceRevision, sourceRevision);
  assert.equal(result.config.extraMetadata.tibotattleDistribution.target, "win32-x64");
  assert.equal(result.publish, "never");
  assert.deepEqual(result.targets, [{ platform: "win32", arches: [[1, ["dir"]]] }]);
  const execute = job.slice(job.indexOf("- name: Exercise normal Windows"), job.indexOf("- name: Retain only"));
  assert.match(execute, /smoke-electron-windows-normal-candidate\.mjs --app .* --staged-app .* --source-candidate .* --source-revision \$env:GITHUB_SHA --receipt/u);
  assert.doesNotMatch(execute, /ELECTRON_RUN_AS_NODE|--no-sandbox|QUALIFICATION|TEST_LANE/u);
  const upload = job.slice(job.indexOf("- name: Retain only"));
  assert.match(upload, /path: \.release-build\/electron-windows-normal-candidate\/normal-candidate-smoke\.json/u);
  assert.doesNotMatch(upload, /electron-production|include-hidden-files|win-unpacked|\*\*/u,
    "only the closed receipt leaves the disposable candidate runner");
});

test("common packaging assembles usable, hashed handoffs without a source checkout", async () => {
  for (const target of ["win32-x64"]) {
    const outputDirectory = await mkdtemp(join(tmpdir(), "electron-development-handoff-"));
    try {
      const files = await writeDevelopmentHandoff({ target, outputDirectory });
      assert.equal(files.length, 3);
      for (const file of files) {
        const bytes = await readFile(join(outputDirectory, file.file));
        assert.equal(bytes.length, file.bytes);
        assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
        if (file.executable && process.platform !== "win32") {
          assert.equal((await stat(join(outputDirectory, file.file))).mode & 0o111, 0o111);
        }
      }
      const readme = await readFile(join(outputDirectory, "DEVELOPMENT-TESTING.txt"), "utf8");
      assert.match(readme, /hosted accountless uploads remain unavailable/u);
      assert.match(readme, /No separate Node\.js installation or source checkout is needed/u);
      const wrapper = files.find(({ file }) => /\.cmd$/u.test(file));
      const source = await readFile(join(outputDirectory, wrapper.file), "utf8");
      assert.match(source, /ELECTRON_RUN_AS_NODE=1/u);
      assert.doesNotMatch(source, /SOURCE_CHECKOUT|%SOURCE%|source checkout.*required/iu);
      await assert.rejects(writeDevelopmentHandoff({ target, outputDirectory }), { code: "EEXIST" });
      assert.equal(await readFile(join(outputDirectory, "DEVELOPMENT-TESTING.txt"), "utf8"), readme);
    } finally { await rm(outputDirectory, { recursive: true, force: true }); }
  }
});
