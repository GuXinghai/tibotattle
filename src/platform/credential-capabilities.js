/**
 * Closed logical credential capabilities for the Windows Credential Manager
 * backend.
 *
 * Callers address credentials only through these frozen capability objects;
 * arbitrary service or account strings never reach the native boundary. The
 * `export_identity_keychain_*` error-code family is a shared contract with the
 * application layer and is kept verbatim.
 */
export const EXPORT_IDENTITY_KEYCHAIN_CAPABILITIES = Object.freeze({
  exportIdentity: Object.freeze({
    service: "app-usagemonitor.export-identity.v1",
    account: "installation",
  }),
  accountObservation: Object.freeze({
    service: "app-usagemonitor.account-observation.v1",
    account: "installation",
  }),
});

const ERROR_CODES = new Set([
  "unsupported_platform",
  "unsupported_architecture",
  "invalid_configuration",
  "binding_unavailable",
  "binding_integrity",
  "invalid_capability",
  "invalid_secret",
  "stored_value_invalid",
  "operation_failed",
  "locked",
  "denied",
  "migration_required",
  "readback_mismatch",
]);

export class ExportIdentityKeychainError extends Error {
  constructor(code) {
    if (!ERROR_CODES.has(code)) throw new TypeError("Unknown credential backend error code");
    super("Credential backend failed");
    this.name = "ExportIdentityKeychainError";
    this.code = `export_identity_keychain_${code}`;
  }
}
