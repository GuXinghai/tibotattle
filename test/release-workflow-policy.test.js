import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import {
  checkReleaseWorkflowPolicy,
  inspectWorkflowSource,
} from "../scripts/check-release-workflow-policy.mjs";

test("checked-in GitHub workflows pin actions and avoid unsafe release triggers", async () => {
  const result = await checkReleaseWorkflowPolicy();
  assert.ok(result.files.includes(".github/workflows/codex-contract-drift.yml"));
  assert.ok(result.files.includes(".github/workflows/osv-scanner.yml"));
  assert.ok(result.files.includes(".github/workflows/windows-portability.yml"));
});

test("Codex drift monitoring is read-only, immutable, and cannot rewrite the ledger", async () => {
  const workflow = await readFile(new URL(
    "../.github/workflows/codex-contract-drift.yml",
    import.meta.url,
  ), "utf8");

  assert.match(workflow, /pull_request:/u);
  assert.match(workflow, /push:\n\s+branches:\n\s+- main/u);
  assert.match(workflow, /schedule:\n\s+- cron: "17 5 \* \* \*"/u);
  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /^\s+[a-z-]+: write$/mu);

  assert.match(
    workflow,
    /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/u,
  );
  assert.match(
    workflow,
    /actions\/setup-node@820762786026740c76f36085b0efc47a31fe5020/u,
  );
  assert.match(
    workflow,
    /actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u,
  );
  assert.match(workflow, /persist-credentials: false/u);
  assert.match(workflow, /package-manager-cache: false/u);

  assert.match(workflow, /if: github\.event_name != 'pull_request'/u);
  assert.match(workflow, /git ls-remote --refs https:\/\/github\.com\/openai\/codex\.git/u);
  assert.match(workflow, /--source-revision "\$\{\{ steps\.upstream-source\.outputs\.revision \}\}"/u);
  assert.match(workflow, /--binary "standalone_latest=/u);
  assert.match(workflow, /npm install[\s\S]*--ignore-scripts[\s\S]*"@openai\/codex@\$codex_version"/u);
  assert.match(workflow, /--report "\$RUNNER_TEMP\/codex-contract-live\.json"/u);
  assert.match(workflow, /if: always\(\)[\s\S]*if-no-files-found: error/u);
  assert.doesNotMatch(workflow, /--update-ledger/u);
});

test("setup-node never initializes a package-manager cache before pnpm exists", async () => {
  for (const workflowPath of [
    ".github/workflows/codex-contract-drift.yml",
    ".github/workflows/release-trust-policy.yml",
    ".github/workflows/windows-portability.yml",
  ]) {
    const workflow = await readFile(new URL(`../${workflowPath}`, import.meta.url), "utf8");
    const setupNodeSteps = workflow.split(/\n\s+- name:/u)
      .filter((step) => step.includes("actions/setup-node@"));
    assert.ok(setupNodeSteps.length > 0, `${workflowPath} must configure setup-node`);
    for (const step of setupNodeSteps) {
      assert.match(step, /^\s*package-manager-cache:\s*false\s*$/mu,
        `${workflowPath} must disable setup-node's pre-pnpm automatic cache`);
    }
  }
});

test("the release trust job installs only its pinned locked dependency graph", async () => {
  const workflow = await readFile(new URL(
    "../.github/workflows/release-trust-policy.yml",
    import.meta.url,
  ), "utf8");
  assert.match(workflow, /npm install --global corepack@0\.34\.0 --force --ignore-scripts/u);
  assert.match(workflow, /corepack prepare pnpm@11\.9\.0 --activate/u);
  assert.match(workflow, /test "\$\(pnpm --version\)" = "11\.9\.0"/u);
  assert.match(workflow, /pnpm install --frozen-lockfile --ignore-scripts/u);
});

test("release trust workflow stays read-only and triggers on PRs and main", async () => {
  const workflow = await readFile(new URL(
    "../.github/workflows/release-trust-policy.yml",
    import.meta.url,
  ), "utf8");
  assert.match(workflow, /^permissions:\n  contents: read$/mu);
  assert.doesNotMatch(workflow, /^\s+[a-z-]+: write$/mu);
});

test("workflow policy accepts local actions and full immutable action SHAs", () => {
  assert.deepEqual(inspectWorkflowSource(`
steps:
  - uses: ./\n  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5
    with:
      persist-credentials: false
`), []);
});

test("workflow policy requires checkout steps to disable credential persistence explicitly", () => {
  const failures = inspectWorkflowSource(`
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
`, { path: ".github/workflows/checkout-bypass.yml" });
  assert.equal(failures.length, 1);
  assert.ok(failures[0].includes("persist-credentials explicitly to false"));

  const envBypass = inspectWorkflowSource(`
steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09
    env:
      persist-credentials: false
`, { path: ".github/workflows/checkout-env-bypass.yml" });
  assert.equal(envBypass.length, 1);
  assert.ok(envBypass[0].includes("persist-credentials explicitly to false"));
});

test("workflow policy rejects mutable actions, dangerous triggers, credentials, and persistent runners", () => {
  const failures = inspectWorkflowSource(`
on:
  pull_request_target:
jobs:
  release:
    runs-on: [self-hosted, macOS]
    steps:
      - uses: actions/checkout@v5
        with:
          persist-credentials: true
`, { path: ".github/workflows/release.yml" });

  assert.equal(failures.length, 4);
  assert.ok(failures.some((failure) => failure.includes("full commit SHA")));
  assert.ok(failures.some((failure) => failure.includes("pull_request_target")));
  assert.ok(failures.some((failure) => failure.includes("must not persist")));
  assert.ok(failures.some((failure) => failure.includes("self-hosted")));
});

test("workflow policy rejects quoted keys, uppercase booleans, and multiline self-hosted arrays", () => {
  const failures = inspectWorkflowSource(`
"on":
  "pull_request_target": {}
jobs:
  release:
    "runs-on":
      - "self-hosted"
      - macOS
    steps:
      - "uses": "actions/checkout@v5"
        with:
          "persist-credentials": TRUE
`, { path: ".github/workflows/bypass.yml" });

  assert.equal(failures.length, 4);
  assert.ok(failures.some((failure) => failure.includes("pull_request_target")));
  assert.ok(failures.some((failure) => failure.includes("self-hosted")));
  assert.ok(failures.some((failure) => failure.includes("full commit SHA")));
  assert.ok(failures.some((failure) => failure.includes("must not persist")));
});

test("workflow policy parses quoted immutable actions and ignores hash characters in quotes", () => {
  assert.deepEqual(inspectWorkflowSource(`
steps:
  - 'uses': 'actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09'
    with:
      'persist-credentials': 'FALSE' # this # is part of the comment
  - uses: "./.github/actions/local#action"
`), []);
});

test("workflow policy allows only the versioned Windows repository runner", () => {
  assert.deepEqual(inspectWorkflowSource(`
jobs:
  windows:
    runs-on: "windows-2025"
`), []);
  for (const runner of ["ubuntu-latest", "windows-latest", "ubuntu-24.04", "windows-2022", "windows-11-arm"]) {
    assert.equal(inspectWorkflowSource(`jobs:\n  test:\n    runs-on: ${runner}\n`).length, 1);
  }

  // macOS runners are outside the Windows-only release scope and fail closed.
  assert.equal(inspectWorkflowSource(`
jobs:
  macos:
    runs-on: [macos-14]
`).length, 1);

  const failures = inspectWorkflowSource(`
on: { pull_request_target: {} }
jobs:
  custom:
    runs-on: ubuntu-custom
  arbitrary:
    runs-on: organization-large-runner
  dynamic:
    runs-on: \${{ matrix.runner }}
`, { path: ".github/workflows/runner-bypass.yml" });
  assert.equal(failures.length, 4);
  assert.equal(failures.filter((failure) => failure.includes("pull_request_target")).length, 1);
  assert.equal(failures.filter((failure) => failure.includes("one static")).length, 2);
  assert.equal(failures.filter((failure) => failure.includes("static GitHub-hosted")).length, 1);
});

test("workflow policy recursively scans local actions and refuses missing, escaping and cyclic definitions", async () => {
  const root = await mkdtemp(join(tmpdir(), "local-action-policy-"));
  try {
    await mkdir(join(root, ".github/workflows"), { recursive: true });
    await mkdir(join(root, "tools/outer"), { recursive: true });
    await mkdir(join(root, "tools/inner"), { recursive: true });
    const workflow = join(root, ".github/workflows/test.yml");
    await writeFile(workflow, "steps:\n  - uses: ./tools/outer\n");
    await writeFile(join(root, "tools/outer/action.yml"), "runs:\n  using: composite\n  steps:\n    - uses: ./tools/inner\n");
    const inner = join(root, "tools/inner/action.yaml");
    await writeFile(inner, "runs:\n  using: composite\n  steps:\n    - uses: actions/example@main\n");
    await assert.rejects(checkReleaseWorkflowPolicy({ repositoryRoot: root }), /full commit SHA/u);
    await writeFile(inner, "runs:\n  using: composite\n  steps:\n    - uses: actions/example@0123456789012345678901234567890123456789\n");
    const result = await checkReleaseWorkflowPolicy({ repositoryRoot: root });
    assert.ok(result.files.includes("tools/inner/action.yaml"));
    for (const [reference, message] of [["./tools/outer", /cycle/u], ["./missing", /missing/u], ["./../outside", /within repository/u]]) {
      await writeFile(inner, `runs:\n  using: composite\n  steps:\n    - uses: ${reference}\n`);
      await assert.rejects(checkReleaseWorkflowPolicy({ repositoryRoot: root }), message);
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("release trust owns and triggers on Electron signing, publication, packaging and Worker configuration", async () => {
  const owners = await readFile(new URL("../.github/CODEOWNERS", import.meta.url), "utf8");
  const workflow = await readFile(new URL("../.github/workflows/release-trust-policy.yml", import.meta.url), "utf8");
  for (const pattern of ["scripts/*electron*", "scripts/lib/*electron*", "scripts/lib/publication-file-digest.mjs", "apps/worker/wrangler.jsonc"]) {
    assert.ok(owners.includes(`/${pattern} @adamallcock`));
    assert.equal(workflow.split(`- "${pattern}"`).length - 1, 2, `${pattern} must trigger both PR and main checks`);
  }
});

test("workflow policy rejects flow-style sensitive mappings instead of parsing them as trusted", () => {
  const failures = inspectWorkflowSource(`
jobs: { release: { "runs-on": ubuntu-24.04, steps: [{ "uses": actions/checkout@v5, "with": { "persist-credentials": true } }] } }
`, { path: ".github/workflows/flow-bypass.yml" });
  assert.equal(failures.length, 3);
  assert.ok(failures.some((failure) => failure.includes("runs-on")));
  assert.ok(failures.some((failure) => failure.includes("uses")));
  assert.ok(failures.some((failure) => failure.includes("persist-credentials")));

  const triggerFailures = inspectWorkflowSource(
    "on: [push, pull_request_target]",
    { path: ".github/workflows/flow-trigger-bypass.yml" },
  );
  assert.equal(triggerFailures.length, 1);
  assert.ok(triggerFailures[0].includes("pull_request_target"));
});
