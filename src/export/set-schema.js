import Ajv from "ajv";
import { safeValidationErrors } from "./safe-validation-errors.js";

import compatibilitySchema from "../../schemas/local-export-v1/compatibility.schema.json" with { type: "json" };
import manifestSchema from "../../schemas/local-export-set-v1/manifest.schema.json" with { type: "json" };

export const EXPORT_SET_MANIFEST_VERSION = "local-export-set-manifest-v1";
export const EXPORT_SET_CONTRACT_VERSION = "local-export-set-contract-v1";
export const EXPORT_SET_MANIFEST_RECEIPT_VERSION = "local-export-set-manifest-receipt-v1";
export const EXPORT_SET_ORDER_VERSION = "record-family-time-id-v1";
export const EXPORT_SET_PACKING_VERSION = "greedy-canonical-bundle-v1";
export const EXPORT_SET_CHUNK_BASENAME_WIDTH = 6;
export const MAXIMUM_EXPORT_SET_CHUNKS = 512;
export const EXPORT_SET_MANIFEST_SCHEMA_SHA256 = "47683ed81e534ec58166cf058310b2cbe337744410ab15cb4c2cebbeea77c70b";

export function isCompressedExportSetManifestVersion(version) {
  return version === EXPORT_SET_MANIFEST_VERSION;
}

function invariant(path, name) {
  return { path, keyword: "invariant", schemaPath: `#/x-invariant/${name}` };
}

function recordCount(recordCounts) {
  return recordCounts.usageEvents
    + recordCounts.quotaSnapshots
    + recordCounts.activityMarkers;
}

function semanticErrors(
  manifest,
  schemaDigestByVersion,
  packingVersionByManifestVersion,
) {
  const errors = [];
  if (
    manifest.manifestContract.schemaSha256
    !== schemaDigestByVersion.get(manifest.schemaVersion)
  ) {
    errors.push(invariant(
      "/manifestContract/schemaSha256",
      "current-schema-digest",
    ));
  }
  if (Date.parse(manifest.coveredAt.endAt) < Date.parse(manifest.coveredAt.startAt)) {
    errors.push(invariant("/coveredAt", "covered-at-order"));
  }
  if (
    manifest.chunking.packingVersion
    !== packingVersionByManifestVersion.get(manifest.schemaVersion)
  ) {
    errors.push(invariant(
      "/chunking/packingVersion",
      "manifest-version-packing-version",
    ));
  }

  const providerOrder = ["openai_codex"];
  const canonicalProviders = providerOrder.filter((provider) =>
    manifest.sourceProviders.includes(provider));
  if (canonicalProviders.some(
    (provider, index) => manifest.sourceProviders[index] !== provider,
  )) {
    errors.push(invariant("/sourceProviders", "source-provider-order"));
  }

  const totals = { usageEvents: 0, quotaSnapshots: 0, activityMarkers: 0 };
  let recordCursor = 0;
  let decodedBundleBytes = 0;
  let encodedArtifactBytes = 0;
  let receiptBytes = 0;
  const bundleIds = new Set();
  for (const [position, chunk] of manifest.chunks.entries()) {
    const path = `/chunks/${position}`;
    if (chunk.index !== position) {
      errors.push(invariant(`${path}/index`, "chunk-index-order"));
    }
    if (chunk.recordStart !== recordCursor) {
      errors.push(invariant(
        `${path}/recordStart`,
        "contiguous-record-range",
      ));
    }
    const count = recordCount(chunk.recordCounts);
    const validEmptySetChunk = count === 0
      && manifest.chunks.length === 1
      && position === 0
      && recordCount(manifest.totals.recordCounts) === 0;
    if (
      (!validEmptySetChunk && count < 1)
      || chunk.recordEndExclusive !== chunk.recordStart + count
    ) {
      errors.push(invariant(
        `${path}/recordEndExclusive`,
        "chunk-range-count",
      ));
    }
    if (count > manifest.chunking.maximumRecordsPerChunk) {
      errors.push(invariant(`${path}/recordCounts`, "chunk-record-limit"));
    }
    if (chunk.bundleBytes > manifest.chunking.maximumCanonicalBundleBytes) {
      errors.push(invariant(`${path}/bundleBytes`, "chunk-bundle-limit"));
    }
    if (
      chunk.artifactBytes > manifest.chunking.maximumEncodedArtifactBytes
    ) {
      errors.push(invariant(`${path}/artifactBytes`, "chunk-artifact-limit"));
    }
    if (bundleIds.has(chunk.bundleId)) {
      errors.push(invariant(`${path}/bundleId`, "unique-bundle-id"));
    }
    bundleIds.add(chunk.bundleId);
    recordCursor = chunk.recordEndExclusive;
    totals.usageEvents += chunk.recordCounts.usageEvents;
    totals.quotaSnapshots += chunk.recordCounts.quotaSnapshots;
    totals.activityMarkers += chunk.recordCounts.activityMarkers;
    decodedBundleBytes += chunk.bundleBytes;
    encodedArtifactBytes += chunk.artifactBytes;
    receiptBytes += chunk.receiptBytes;
  }

  for (const family of Object.keys(totals)) {
    if (totals[family] !== manifest.totals.recordCounts[family]) {
      errors.push(invariant(
        `/totals/recordCounts/${family}`,
        "aggregate-record-counts",
      ));
    }
  }
  if (recordCursor !== recordCount(manifest.totals.recordCounts)) {
    errors.push(invariant(
      "/totals/recordCounts",
      "aggregate-record-range",
    ));
  }
  const decodedTotalPath = "/totals/decodedBundleBytes";
  const declaredDecodedBundleBytes = manifest.totals.decodedBundleBytes;
  if (decodedBundleBytes !== declaredDecodedBundleBytes) {
    errors.push(invariant(decodedTotalPath, "aggregate-bundle-bytes"));
  }
  if (
    encodedArtifactBytes !== manifest.totals.encodedArtifactBytes
  ) {
    errors.push(invariant(
      "/totals/encodedArtifactBytes",
      "aggregate-artifact-bytes",
    ));
  }
  if (receiptBytes !== manifest.totals.receiptBytes) {
    errors.push(invariant("/totals/receiptBytes", "aggregate-receipt-bytes"));
  }
  return errors.slice(0, 20);
}

function createExportSetSchemaContext() {
  const ajv = new Ajv({ allErrors: true, strict: true });
  ajv.addFormat("date-time", {
    type: "string",
    validate(value) {
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)) {
        return false;
      }
      return Number.isFinite(Date.parse(value));
    },
  });
  ajv.addSchema(compatibilitySchema);
  ajv.addSchema(manifestSchema);
  const validateSchemaByVersion = new Map([
    [EXPORT_SET_MANIFEST_VERSION, ajv.getSchema(manifestSchema.$id)],
  ]);
  const schemaDigestByVersion = new Map([
    [EXPORT_SET_MANIFEST_VERSION, EXPORT_SET_MANIFEST_SCHEMA_SHA256],
  ]);
  const packingVersionByManifestVersion = new Map([
    [EXPORT_SET_MANIFEST_VERSION, EXPORT_SET_PACKING_VERSION],
  ]);

  function validateExportSetManifest(value) {
    try {
      const schemaVersion = value !== null && typeof value === "object"
        ? value.schemaVersion
        : undefined;
      const validateSchema = validateSchemaByVersion.get(schemaVersion)
        ?? validateSchemaByVersion.get(EXPORT_SET_MANIFEST_VERSION);
      const valid = validateSchema(value);
      if (!valid) {
        return {
          valid: false,
          errors: safeValidationErrors(validateSchema.errors),
        };
      }
      const errors = semanticErrors(
        value,
        schemaDigestByVersion,
        packingVersionByManifestVersion,
      );
      return { valid: errors.length === 0, errors };
    } catch {
      return {
        valid: false,
        errors: [invariant("/", "readable-input")],
      };
    }
  }

  function assertValidExportSetManifest(value) {
    const result = validateExportSetManifest(value);
    if (!result.valid) {
      const summary = result.errors
        .map((error) => `${error.path}:${error.keyword}`)
        .join(", ");
      throw new Error(
        `Privacy export-set manifest failed validation (${summary})`,
      );
    }
    return value;
  }

  return Object.freeze({
    assertValidExportSetManifest,
    exportSetManifestSchema: manifestSchema,
    validateExportSetManifest,
  });
}

export const {
  assertValidExportSetManifest,
  exportSetManifestSchema,
  validateExportSetManifest,
} = createExportSetSchemaContext();

function assertChunkIndex(index) {
  if (
    !Number.isSafeInteger(index)
    || index < 0
    || index >= MAXIMUM_EXPORT_SET_CHUNKS
  ) {
    throw new RangeError(
      "Export-set chunk index must be a zero-based integer below 512",
    );
  }
}

export function exportSetChunkBundleBasename(
  index,
  schemaVersion = EXPORT_SET_MANIFEST_VERSION,
) {
  assertChunkIndex(index);
  if (schemaVersion !== EXPORT_SET_MANIFEST_VERSION) {
    throw new RangeError("Unsupported export-set manifest version");
  }
  const suffix = ".bundle.json.gz";
  return `chunk-${String(index).padStart(
    EXPORT_SET_CHUNK_BASENAME_WIDTH,
    "0",
  )}${suffix}`;
}

export function exportSetChunkReceiptBasename(index) {
  assertChunkIndex(index);
  return `chunk-${String(index).padStart(
    EXPORT_SET_CHUNK_BASENAME_WIDTH,
    "0",
  )}.receipt.json`;
}

export function exportSetChunkBasenames(
  index,
  schemaVersion = EXPORT_SET_MANIFEST_VERSION,
) {
  return Object.freeze({
    bundle: exportSetChunkBundleBasename(index, schemaVersion),
    receipt: exportSetChunkReceiptBasename(index),
  });
}
