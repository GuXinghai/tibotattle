function selectionError(code) {
  const error = new Error(
    "Production participant identity backend selection failed",
  );
  error.code = code;
  return error;
}

// Port-level selection for the participant identity secret. Concrete Windows
// Credential Manager composition lives in src/export-identity-production.js,
// which routes production Windows through its own readiness gate. This port
// only admits the explicit development overrides; with no override it fails
// closed without constructing any backend.
export function selectProductionParticipantIdentity({
  explicitSecretFile = null,
  environmentSecret,
  appStateSecretFile,
} = {}) {
  if (environmentSecret && explicitSecretFile) {
    throw selectionError("EXPORT_IDENTITY_OVERRIDE_CONFLICT");
  }
  if (environmentSecret) {
    return Object.freeze({
      mode: "external_environment_override",
      identityOptions: Object.freeze({
        environmentSecret,
        secretFile: appStateSecretFile,
        legacySecretFile: null,
      }),
    });
  }
  if (explicitSecretFile) {
    return Object.freeze({
      mode: "owner_file_override",
      identityOptions: Object.freeze({
        environmentSecret: null,
        secretFile: explicitSecretFile,
        legacySecretFile: null,
      }),
    });
  }
  throw selectionError("EXPORT_IDENTITY_PRODUCTION_BACKEND_UNAVAILABLE");
}
