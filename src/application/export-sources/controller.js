import {
  createEmptySupplementalSourcePlan,
  normalizeSupplementalSourcePlan,
  summarizeSupplementalSourcePlan,
  normalizeExportResourceLimits,
  stableJson,
} from "../../export/index.js";

export function createLocalExportSetController(configuration) {
const {
  bufferByteLength,
  codexCheckpoint,
  codexCollectorWorkspace,
  codexSourcePlan,
  createExportResourceGuard,
  deriveParticipantId,
  exportCompatibilityTuple,
  resolvePath,
  safeRecords,
  sourcePlanBundle,
  workspace,
} = configuration;
const {
  normalizeActivityMarker,
  normalizeExportBounds,
  summarizeActivityMarkerPlan,
} = safeRecords;
const { populateCheckpointedCodexSources } = codexCheckpoint;
const {
  appendCodexCollectorWorkspaceSource,
  collectorPlanningGuard,
  createCodexCollectorWorkspaceSource,
  populateCodexCollectorWorkspaceSource,
} = codexCollectorWorkspace;
const {
  createCodexExportSourcePlan,
  resolveCodexExportSourcePlan,
  ExportSourcePlanError,
} = codexSourcePlan;
const {
  buildExportWorkspaceDescriptor,
  createExportWorkspace,
  DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS,
  ExportWorkspaceError,
  openExportWorkspace,
  withExportWorkspaceLease,
} = workspace;
const {
  ExportSourcePlanBundleError,
  resolveExportSourcePlanBundle,
} = sourcePlanBundle;

async function populateWorkspace({
  workspace,
  sourcePlan,
  secret,
  activityMarkers,
  resourceGuard,
  failpoint = async () => {},
  checkpointLinesPerBatch,
  collectorPath = null,
  collectorCandidatesPerBatch,
} = {}) {
  await populateCheckpointedCodexSources({
    workspace,
    sourcePlan,
    secret,
    resourceGuard,
    failpoint,
    ...(checkpointLinesPerBatch === undefined ? {} : { maximumLinesPerBatch: checkpointLinesPerBatch }),
  });
  let collectorDiagnosticRegistryGaps = [];
  if (collectorPath !== null) {
    const collector = await populateCodexCollectorWorkspaceSource({
      workspace,
      collectorPath,
      secret,
      resourceGuard,
      failpoint,
      ...(collectorCandidatesPerBatch === undefined
        ? {} : { maximumCandidateRecords: collectorCandidatesPerBatch }),
    });
    collectorDiagnosticRegistryGaps = collector.missingRegistryRows;
  }
  const bounds = {
    startAt: sourcePlan.startAt,
    endAt: sourcePlan.endAt,
    startMs: Date.parse(sourcePlan.startAt),
    endMs: Date.parse(sourcePlan.endAt),
  };
  const pendingMarkerIds = new Set();
  const markerBatch = [];
  for (const marker of activityMarkers) {
    const record = normalizeActivityMarker(secret, marker, bounds);
    if (!record || pendingMarkerIds.has(record.markerId)
        || workspace.hasRecord("activityMarker", record.markerId)) continue;
    resourceGuard.observeOutputRecord(bufferByteLength(stableJson(record), "utf8"));
    markerBatch.push({ recordType: "activityMarker", record });
    pendingMarkerIds.add(record.markerId);
    if (markerBatch.length >= DEFAULT_EXPORT_WORKSPACE_BATCH_RECORDS) {
      await workspace.insertRecordBatch(markerBatch.splice(0, markerBatch.length));
      pendingMarkerIds.clear();
      await failpoint("after_record_batch");
    }
  }
  if (markerBatch.length > 0) {
    await workspace.insertRecordBatch(markerBatch);
    await failpoint("after_record_batch");
  }
  await failpoint("after_diagnostics");
  if (!workspace.hasPendingSupplementalSources()) {
    workspace.finalizeScan();
    await failpoint("after_scan_complete");
  }
  return { status: await workspace.status(), collectorDiagnosticRegistryGaps };
}

function storedCollectorDiagnosticRegistryGaps(workspace) {
  if (typeof workspace.supplementalDiagnosticRegistryGaps !== "function") return [];
  const collectorSourceKeys = new Set(workspace.loadSupplementalSourcePlan().sources
    .filter((source) => source.kind === "codex_collector_ledger")
    .map((source) => source.sourceKey));
  return workspace.supplementalDiagnosticRegistryGaps()
    .filter((item) => collectorSourceKeys.has(item.sourceKey))
    .map(({ sourceKey, ...item }) => item);
}

function requestedCollectorPath({ collectorPath = null, enableCollector = false, enableCodexCollector = false } = {}) {
  if (typeof enableCollector !== "boolean" || typeof enableCodexCollector !== "boolean") {
    throw new TypeError("Codex collector enable options must be boolean");
  }
  if (collectorPath === null || collectorPath === undefined) {
    if (enableCollector || enableCodexCollector) {
      throw new Error("A Codex collector path is required when collector export is enabled");
    }
    return null;
  }
  if (typeof collectorPath !== "string" || collectorPath.length === 0) {
    throw new TypeError("Codex collector path must be a non-empty string");
  }
  return collectorPath;
}

const RETIRED_CLAUDE_OPTION_KEYS = Object.freeze([
  "claudeStateDirectory",
  "enableClaudeStatus",
  "enableClaudeStatusline",
  "claudeRecordsPerBatch",
  "claudeProjectsDirectory",
  "enableClaudeUsage",
  "enableClaudeTranscripts",
  "claudeTranscriptRecordsPerBatch",
]);

function rejectRetiredClaudeOptions(options) {
  if (options && typeof options === "object"
      && RETIRED_CLAUDE_OPTION_KEYS.some((key) => Object.hasOwn(options, key))) {
    throw new ExportWorkspaceError("checkpoint_mismatch");
  }
}

function activeSupplementalSourcePlan(value) {
  const plan = normalizeSupplementalSourcePlan(value);
  // Persisted Claude plan rows remain structurally readable, but this
  // controller no longer creates or resumes processing from them.
  if (plan.sources.some((source) => source.kind !== "codex_collector_ledger")) {
    throw new ExportWorkspaceError("checkpoint_mismatch");
  }
  return plan;
}

function combinedSourcePlanPlanningGuard(resourceGuard) {
  if (!resourceGuard || !resourceGuard.limits) throw new TypeError("Export resource guard is required");
  return {
    limits: resourceGuard.limits,
    assertCoveredInterval: resourceGuard.assertCoveredInterval.bind(resourceGuard),
    checkRuntime: resourceGuard.checkRuntime.bind(resourceGuard),
    // Directory traversal is additive work, not part of the frozen source
    // selection gauge, so it remains charged while the combined plan is built.
    observeDirectoryEntry: resourceGuard.observeDirectoryEntry.bind(resourceGuard),
    observeLine: resourceGuard.observeLine.bind(resourceGuard),
    assertSourceSelection: resourceGuard.assertSourceSelection.bind(resourceGuard),
    // Individual discovered files and the Codex plan total would otherwise
    // establish a partial gauge before the frozen collector prefix can be
    // included. Validate runtime now; the exact combined total is charged once
    // below through observeSourcePlan.
    observeSourceFile() {
      resourceGuard.checkRuntime();
    },
    observeSourcePlan() {
      resourceGuard.checkRuntime();
    },
  };
}

function assertResumeDescriptor(descriptor, secret, resourceLimits) {
  if (descriptor.participantId !== deriveParticipantId(secret)
      || stableJson(descriptor.compatibility) !== stableJson(exportCompatibilityTuple())
      || stableJson(descriptor.resourceLimits) !== stableJson(resourceLimits)) {
    throw new ExportWorkspaceError("checkpoint_mismatch");
  }
}

async function createLocalExportWorkspaceUnlocked({
  directory,
  startAt,
  endAt,
  codexHome,
  secret,
  activityMarkers = [],
  createdAt = new Date().toISOString(),
  resourceLimits = {},
  resourceClock,
  resourceRss,
  failpoint,
  checkpointLinesPerBatch,
  supplementalSourcePlan = createEmptySupplementalSourcePlan(),
  collectorPath = null,
  enableCollector = false,
  enableCodexCollector = false,
  collectorCandidatesPerBatch,
  sourcePlanBundle = null,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const bounds = normalizeExportBounds(startAt, endAt);
  const resourceGuard = createExportResourceGuard({
    limits: resourceLimits,
    scope: "export_set",
    ...(resourceClock ? { clock: resourceClock } : {}),
    ...(resourceRss ? { rss: resourceRss } : {}),
  });
  resourceGuard.assertCoveredInterval(bounds.startMs, bounds.endMs);
  let selectedCollectorPath;
  let effectiveSupplementalSourcePlan;
  let supplementalPrivatePlans;
  let sourcePlan;
  if (sourcePlanBundle !== null) {
    const resolved = await resolveExportSourcePlanBundle(sourcePlanBundle, {
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard,
    });
    selectedCollectorPath = resolved.collectorPath;
    effectiveSupplementalSourcePlan = activeSupplementalSourcePlan(resolved.supplementalSourcePlan);
    supplementalPrivatePlans = resolved.supplementalPrivatePlans;
    sourcePlan = resolved.sourcePlan;
  } else {
    selectedCollectorPath = requestedCollectorPath({ collectorPath, enableCollector, enableCodexCollector });
    effectiveSupplementalSourcePlan = activeSupplementalSourcePlan(supplementalSourcePlan);
    supplementalPrivatePlans = [];
    if (selectedCollectorPath !== null) {
      const collector = await createCodexCollectorWorkspaceSource({
        collectorPath: selectedCollectorPath,
        startAt: bounds.startAt,
        endAt: bounds.endAt,
        resourceGuard: collectorPlanningGuard(resourceGuard),
      });
      effectiveSupplementalSourcePlan = appendCodexCollectorWorkspaceSource(
        effectiveSupplementalSourcePlan,
        collector.collectorPlan,
      );
    }
    const supplementalSummary = summarizeSupplementalSourcePlan(effectiveSupplementalSourcePlan);
    sourcePlan = await createCodexExportSourcePlan({
      codexHome,
      startAt: bounds.startAt,
      endAt: bounds.endAt,
      resourceGuard: supplementalSummary.sourceCount === 0
        ? resourceGuard : combinedSourcePlanPlanningGuard(resourceGuard),
    });
    if (supplementalSummary.sourceCount > 0) {
      resourceGuard.observeSourcePlan(
        sourcePlan.sources.length + supplementalSummary.sourceFiles,
        sourcePlan.sources.reduce((sum, source) => sum + source.prefixBytes, 0) + supplementalSummary.sourceBytes,
      );
    }
  }
  const activityPlan = summarizeActivityMarkerPlan(secret, activityMarkers, bounds, {
    maximumRecords: resourceGuard.limits.maximumExportSetRecords,
  });
  for (const source of sourcePlan.sources) source.rolloutInfo.sourcePlanOrdinal = source.ordinal;
  const descriptor = buildExportWorkspaceDescriptor({
    participantId: deriveParticipantId(secret),
    createdAt,
    coveredAt: bounds,
    compatibility: exportCompatibilityTuple(),
    sourcePlan,
    supplementalSourcePlan: effectiveSupplementalSourcePlan,
    activityPlan,
    sourceProviders: ["openai_codex"],
    resourceLimits: resourceGuard.limits,
  });
  const workspace = await createExportWorkspace({
    directory,
    descriptor,
    sourcePlan,
    supplementalSourcePlan: effectiveSupplementalSourcePlan,
    supplementalPrivatePlans,
    maximumWorkspaceBytes: resourceGuard.limits.maximumWorkspaceBytes,
  });
  let invocationBegun = false;
  let invocationSucceeded = false;
  try {
    workspace.beginInvocation();
    invocationBegun = true;
    const populated = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
      checkpointLinesPerBatch,
      collectorPath: selectedCollectorPath,
      collectorCandidatesPerBatch,
    });
    const { status, collectorDiagnosticRegistryGaps } = populated;
    resourceGuard.observeWorkspace(Math.max(
      status.workspaceBytes,
      workspace.resourceUsage().workspaceHighWaterBytes,
    ));
    invocationSucceeded = true;
    return { descriptor, status, collectorDiagnosticRegistryGaps, resourceUsage: resourceGuard.snapshot() };
  } finally {
    try {
      let durableUsage = null;
      try {
        durableUsage = resourceGuard.durableSnapshot();
      } catch {
        // Preserve the original failure; the stale-invocation reservation
        // remains the conservative fallback if this process cannot finish.
      }
      if (invocationBegun && (durableUsage !== null || invocationSucceeded)) {
        workspace.finishInvocation({ resourceUsage: durableUsage });
      }
    } finally {
      workspace.close();
    }
  }
}

async function resumeLocalExportWorkspaceUnlocked({
  directory,
  codexHome,
  secret,
  activityMarkers = [],
  resourceLimits = {},
  resourceClock,
  resourceRss,
  failpoint,
  checkpointLinesPerBatch,
  collectorPath = null,
  enableCollector = false,
  enableCodexCollector = false,
  collectorCandidatesPerBatch,
} = {}) {
  if (!secret) throw new Error("A participant export secret is required");
  const normalizedLimits = normalizeExportResourceLimits(resourceLimits);
  const workspace = await openExportWorkspace({
    directory,
    maximumWorkspaceBytes: normalizedLimits.maximumWorkspaceBytes,
  });
  let invocationBegun = false;
  let resourceGuard = null;
  let invocationSucceeded = false;
  try {
    const descriptor = workspace.getDescriptor();
    assertResumeDescriptor(descriptor, secret, normalizedLimits);
    if (workspace.isPoisoned()) throw new ExportWorkspaceError("checkpoint_mismatch");
    const selectedCollectorPath = requestedCollectorPath({ collectorPath, enableCollector, enableCodexCollector });
    const storedSupplementalPlan = activeSupplementalSourcePlan(workspace.loadSupplementalSourcePlan());
    const hasCollectorSource = storedSupplementalPlan.sources.some(
      (source) => source.kind === "codex_collector_ledger",
    );
    if ((hasCollectorSource && selectedCollectorPath === null)
        || (!hasCollectorSource && selectedCollectorPath !== null)) {
      throw new ExportWorkspaceError("checkpoint_mismatch");
    }
    workspace.beginInvocation();
    invocationBegun = true;
    resourceGuard = createExportResourceGuard({
      limits: normalizedLimits,
      scope: "export_set",
      initialUsage: workspace.resourceUsage(),
      ...(resourceClock ? { clock: resourceClock } : {}),
      ...(resourceRss ? { rss: resourceRss } : {}),
    });
    const storedPlan = workspace.loadSourcePlan();
    resourceGuard.assertCoveredInterval(Date.parse(storedPlan.startAt), Date.parse(storedPlan.endAt));
    let sourcePlan;
    try {
      sourcePlan = await resolveCodexExportSourcePlan(storedPlan, { codexHome, resourceGuard });
    } catch (error) {
      if (error instanceof ExportSourcePlanError) workspace.markPoisoned("source_integrity");
      throw error;
    }
    workspace.rebindSourcePaths(sourcePlan);
    const activityPlan = summarizeActivityMarkerPlan(secret, activityMarkers, {
      startAt: storedPlan.startAt,
      endAt: storedPlan.endAt,
      startMs: Date.parse(storedPlan.startAt),
      endMs: Date.parse(storedPlan.endAt),
    }, {
      maximumRecords: resourceGuard.limits.maximumExportSetRecords,
    });
    if (stableJson(activityPlan) !== stableJson(descriptor.activityPlan)) {
      throw new ExportWorkspaceError("checkpoint_mismatch");
    }
    for (const source of sourcePlan.sources) source.rolloutInfo.sourcePlanOrdinal = source.ordinal;
    if (workspace.isScanComplete()) {
      resourceGuard.observeWorkspace((await workspace.status()).workspaceBytes);
      invocationSucceeded = true;
      return {
        descriptor,
        status: await workspace.status(),
        collectorDiagnosticRegistryGaps: storedCollectorDiagnosticRegistryGaps(workspace),
        resourceUsage: resourceGuard.snapshot(),
      };
    }
    const populated = await populateWorkspace({
      workspace,
      sourcePlan,
      secret,
      activityMarkers,
      resourceGuard,
      failpoint,
      checkpointLinesPerBatch,
      collectorPath: selectedCollectorPath,
      collectorCandidatesPerBatch,
    });
    const { status, collectorDiagnosticRegistryGaps } = populated;
    resourceGuard.observeWorkspace(Math.max(
      status.workspaceBytes,
      workspace.resourceUsage().workspaceHighWaterBytes,
    ));
    invocationSucceeded = true;
    return { descriptor, status, collectorDiagnosticRegistryGaps, resourceUsage: resourceGuard.snapshot() };
  } finally {
    try {
      let durableUsage = null;
      try {
        durableUsage = resourceGuard?.durableSnapshot() ?? null;
      } catch {
        // Preserve the original failure; recovery will charge a reservation.
      }
      if (invocationBegun && (durableUsage !== null || invocationSucceeded)) {
        workspace.finishInvocation({ resourceUsage: durableUsage });
      }
    } finally {
      workspace.close();
    }
  }
}

async function inspectLocalExportWorkspaceUnlocked({ directory } = {}) {
  const workspace = await openExportWorkspace({ directory });
  try {
    const descriptor = workspace.getDescriptor();
    return {
      workspaceVersion: descriptor.workspaceVersion,
      resourcePolicyVersion: descriptor.resourcePolicyVersion,
      coveredAt: structuredClone(descriptor.coveredAt),
      sourceProviders: [...descriptor.sourceProviders],
      sourcePlan: structuredClone(descriptor.sourcePlan),
      supplementalSourcePlan: structuredClone(descriptor.supplementalSourcePlan),
      ...await workspace.status(),
    };
  } finally {
    workspace.close();
  }
}

async function createLocalExportWorkspace(options = {}) {
  rejectRetiredClaudeOptions(options);
  if (!options.directory) throw new Error("Export workspace directory is required");
  if (options.sourcePlanBundle !== null && options.sourcePlanBundle !== undefined) {
    const discoveryKeys = [
      "codexHome", "supplementalSourcePlan", "collectorPath", "enableCollector", "enableCodexCollector",
    ];
    if (discoveryKeys.some((key) => Object.hasOwn(options, key))) {
      throw new ExportSourcePlanBundleError("configuration");
    }
  }
  return withExportWorkspaceLease(options.directory, () => createLocalExportWorkspaceUnlocked(options));
}

async function resumeLocalExportWorkspace(options = {}) {
  rejectRetiredClaudeOptions(options);
  if (!options.directory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.directory, () => resumeLocalExportWorkspaceUnlocked(options));
}

async function inspectLocalExportWorkspace(options = {}) {
  if (!options.directory) throw new Error("Export workspace directory is required");
  return withExportWorkspaceLease(options.directory, () => inspectLocalExportWorkspaceUnlocked(options));
}

return Object.freeze({
  createLocalExportWorkspace,
  inspectLocalExportWorkspace,
  resumeLocalExportWorkspace,
});
}
