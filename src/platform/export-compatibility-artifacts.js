import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SCHEMA_FILES = Object.freeze({
  "activity-marker.schema.json": new URL(
    "../../schemas/local-export-v1/activity-marker.schema.json",
    import.meta.url,
  ),
  "bundle.schema.json": new URL(
    "../../schemas/local-export-v1/bundle.schema.json",
    import.meta.url,
  ),
  "compatibility.schema.json": new URL(
    "../../schemas/local-export-v1/compatibility.schema.json",
    import.meta.url,
  ),
  "privacy-receipt.schema.json": new URL(
    "../../schemas/local-export-v1/privacy-receipt.schema.json",
    import.meta.url,
  ),
  "quota-snapshot.schema.json": new URL(
    "../../schemas/local-export-v1/quota-snapshot.schema.json",
    import.meta.url,
  ),
  "usage-event.schema.json": new URL(
    "../../schemas/local-export-v1/usage-event.schema.json",
    import.meta.url,
  ),
});

const FIELD_CONTRACT_FILE = new URL(
  "../../generated/local-export-v1-field-dictionary.json",
  import.meta.url,
);
const GENERATED_COMPATIBILITY_FILE = new URL(
  "../../generated/local-export-v1-compatibility.json",
  import.meta.url,
);
const PACKAGE_METADATA_FILE = new URL(
  "../../package.json",
  import.meta.url,
);
function readArtifact(url, name) {
  const storedBytes = Buffer.from(readFileSync(fileURLToPath(url)));
  return Object.freeze({
    ...(name === undefined ? {} : { name }),
    get bytes() {
      return Buffer.from(storedBytes);
    },
  });
}

export function readExportCompatibilityArtifactSet({
  schemaNames,
} = {}) {
  if (
    !Array.isArray(schemaNames)
    || schemaNames.length !== Object.keys(SCHEMA_FILES).length
    || schemaNames.some(
      (name, index) => name !== Object.keys(SCHEMA_FILES)[index],
    )
  ) {
    throw new TypeError("schemaNames must match the reviewed artifact set");
  }
  return Object.freeze({
    schemas: Object.freeze(schemaNames.map(
      (name) => readArtifact(SCHEMA_FILES[name], name),
    )),
    fieldContract: readArtifact(FIELD_CONTRACT_FILE),
    generatedCompatibility: readArtifact(
      GENERATED_COMPATIBILITY_FILE,
    ),
    packageMetadata: readArtifact(PACKAGE_METADATA_FILE),
  });
}
