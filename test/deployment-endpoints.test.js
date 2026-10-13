import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DEPLOYMENT_ENDPOINTS,
  assertDeploymentEndpoints,
} from "../config/deployment-endpoints.js";
import {
  checkDeploymentEndpointConsumers,
  ELECTRON_RUNTIME_PATH,
  validateDeploymentEndpointConsumers,
  validateWorkerDeploymentEndpoints,
  validateWorkerDeploymentEndpointGates,
  WORKER_TYPES_PATH,
} from "../apps/worker/scripts/check-deployment-endpoints.mjs";

test("reviewed deployment endpoint manifest is internally coherent", () => {
  assert.deepEqual(
    DEPLOYMENT_ENDPOINTS.sparkle,
    {
      origin: "https://updates.tibotattle.com",
      r2Bucket: "tibotattle-updates",
    },
  );
  assert.deepEqual(
    DEPLOYMENT_ENDPOINTS.public.routeHosts,
    ["tibotattle.com", "www.tibotattle.com"],
  );
  assert.deepEqual(DEPLOYMENT_ENDPOINTS.admin, {
    host: "admin.tibotattle.com",
    origin: "https://admin.tibotattle.com",
  });
  assert.deepEqual(DEPLOYMENT_ENDPOINTS.staging, {
    origin: "https://app-usagemonitor-staging.adamallcock.workers.dev",
    previewUrls: false,
    workerName: "app-usagemonitor-staging",
    workersDev: true,
  });
  assert.equal(assertDeploymentEndpoints(), DEPLOYMENT_ENDPOINTS);
});

test("Worker endpoint projection rejects an independent public origin", () => {
  const configuration = {
    env: {
      production: {
        routes: [
          ...DEPLOYMENT_ENDPOINTS.public.routeHosts,
          DEPLOYMENT_ENDPOINTS.admin.host,
        ].map((pattern) => ({
          custom_domain: true,
          pattern,
        })),
        vars: {
          PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin,
          ACCESS_TEAM_DOMAIN: "",
          ACCESS_AUD: "",
        },
      },
      staging: {
        name: DEPLOYMENT_ENDPOINTS.staging.workerName,
        workers_dev: DEPLOYMENT_ENDPOINTS.staging.workersDev,
        preview_urls: DEPLOYMENT_ENDPOINTS.staging.previewUrls,
        vars: { PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.staging.origin },
      },
    },
  };
  assert.doesNotThrow(() => validateWorkerDeploymentEndpoints(configuration));
  configuration.env.production.vars.PUBLIC_ORIGIN = "https://other.example";
  assert.throws(
    () => validateWorkerDeploymentEndpoints(configuration),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  configuration.env.production.vars.PUBLIC_ORIGIN =
    DEPLOYMENT_ENDPOINTS.public.origin;

  // Dropping the admin custom domain or its Access variable slots must fail:
  // the admin surface only ships alongside its Zero Trust binding.
  const withoutAdminRoute = {
    env: {
      production: {
        ...configuration.env.production,
        routes: configuration.env.production.routes.slice(0, 2),
      },
    },
  };
  assert.throws(
    () => validateWorkerDeploymentEndpoints(withoutAdminRoute),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  const withoutAccessVars = {
    env: {
      production: {
        ...configuration.env.production,
        vars: { PUBLIC_ORIGIN: DEPLOYMENT_ENDPOINTS.public.origin },
      },
    },
  };
  assert.throws(
    () => validateWorkerDeploymentEndpoints(withoutAccessVars),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );

  const wrongStagingName = structuredClone(configuration);
  wrongStagingName.env.staging.name = "another-worker";
  assert.throws(
    () => validateWorkerDeploymentEndpoints(wrongStagingName),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  const stagingPublicOrigin = structuredClone(configuration);
  stagingPublicOrigin.env.staging.vars.PUBLIC_ORIGIN =
    DEPLOYMENT_ENDPOINTS.public.origin;
  assert.throws(
    () => validateWorkerDeploymentEndpoints(stagingPublicOrigin),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
  const missingStagingOrigin = structuredClone(configuration);
  delete missingStagingOrigin.env.staging.vars.PUBLIC_ORIGIN;
  assert.throws(
    () => validateWorkerDeploymentEndpoints(missingStagingOrigin),
    { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
  );
});

test("Worker deployment scripts run the endpoint check before deployment", () => {
  const endpointCheckCommand = "npm run deployment:endpoints:check";
  const deploymentOperations = [
    ["deploy:dry", "wrangler deploy --env=\"\" --dry-run"],
    ["production:deploy:dry", "wrangler deploy --env production --dry-run"],
    ["staging:check", "wrangler deploy --env staging --dry-run"],
    ["staging:deploy", "node ./scripts/deploy-disabled-staging.mjs"],
  ];
  const scripts = {
    "deployment:endpoints:check": "node ./scripts/check-deployment-endpoints.mjs",
    "production:deploy": "node ./scripts/production-deploy.mjs",
  };
  for (const [name, operation] of deploymentOperations) {
    scripts[name] = `${endpointCheckCommand} && ${operation}`;
  }

  assert.doesNotThrow(() => validateWorkerDeploymentEndpointGates({ scripts }));
  for (const [name, operation] of deploymentOperations) {
    scripts[name] = `${operation} && ${endpointCheckCommand}`;
    assert.throws(
      () => validateWorkerDeploymentEndpointGates({ scripts }),
      { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" },
      `${name} must reject an endpoint check after its deployment operation`,
    );
    scripts[name] = `${endpointCheckCommand} && ${operation}`;
  }
});

test("checked-in deployment endpoint consumers match the reviewed manifest", async () => {
  const checked = await checkDeploymentEndpointConsumers();
  assert.equal(checked.publicOrigin, DEPLOYMENT_ENDPOINTS.public.origin);
  assert.equal(checked.r2Bucket, DEPLOYMENT_ENDPOINTS.sparkle.r2Bucket);
  assert.deepEqual(checked.worker.routeHosts, [
    ...DEPLOYMENT_ENDPOINTS.public.routeHosts,
    DEPLOYMENT_ENDPOINTS.admin.host,
  ]);
  assert.equal(checked.worker.adminHost, DEPLOYMENT_ENDPOINTS.admin.host);
  assert.equal(checked.worker.stagingOrigin, DEPLOYMENT_ENDPOINTS.staging.origin);
  assert.deepEqual(checked.gates.checkedScripts, [
    "deploy:dry",
    "production:deploy",
    "production:deploy:dry",
    "staging:check",
    "staging:deploy",
  ]);
});

test("Electron runtime endpoint drift fails the deployment consumer check", async () => {
  const [electronRuntimeSource, workerTypes] =
    await Promise.all([
      ELECTRON_RUNTIME_PATH,
      WORKER_TYPES_PATH,
    ].map((path) => readFile(path, "utf8")));
  const input = { electronRuntimeSource, workerTypes };
  assert.doesNotThrow(() => validateDeploymentEndpointConsumers(input));
  assert.throws(() => validateDeploymentEndpointConsumers({
    ...input,
    electronRuntimeSource: electronRuntimeSource.replaceAll(
      "DEPLOYMENT_ENDPOINTS.public.origin", "https://other.example.test",
    ),
  }), { code: "DEPLOYMENT_ENDPOINTS_MISMATCH" });
});
