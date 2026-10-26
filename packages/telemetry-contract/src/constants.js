export const TELEMETRY_SCHEMA_VERSION = "telemetry-contribution-v0.1";
export const TELEMETRY_CONTRIBUTION_SCHEMA_VERSION =
  TELEMETRY_SCHEMA_VERSION;
export const ACCOUNT_SCOPED_TELEMETRY_SCHEMA_VERSION =
  "telemetry-contribution-v0.2";
export const ACCOUNT_SCOPED_TELEMETRY_CONSENT_VERSION =
  "privacy-safe-telemetry-v0.2";
export const TELEMETRY_ENVELOPE_SCHEMA_VERSION =
  "telemetry-envelope-v0.1";
export const ACCOUNT_SCOPED_TELEMETRY_ENVELOPE_SCHEMA_VERSION =
  "telemetry-envelope-v0.2";
export const MAX_TELEMETRY_BROWSER_BYTES = 1_310_720;

// Plan identifiers mirror Codex's KnownPlan enum verbatim (serde lowercase /
// rename names) so we never invent our own plan labels. Source of truth:
// openai/codex codex-rs/protocol/src/auth.rs (KnownPlan). "unknown" is our
// sentinel for a plan Codex has not (yet) named. Product allowance ratios and
// display labels are separate policy; renaming Pro does not change this identity.
// promax is verified in reviewed source and installed binary plan vocabulary.
// Provider allowance and window semantics remain unverified.
export const TELEMETRY_PLAN_TYPES = Object.freeze([
  "free",
  "go",
  "plus",
  "pro",
  "prolite",
  "promax",
  "team",
  "self_serve_business_prolite",
  "self_serve_business_usage_based",
  "business",
  "ent26",
  "enterprise_cbp_automation",
  "enterprise_cbp_usage_based",
  "enterprise",
  "edu",
  "edu_plus",
  "edu_pro",
  "unknown",
]);

// Human-readable names mirror Codex's KnownPlan::display_name() values. Keep
// this map exhaustive for every named plan above; "unknown" intentionally has
// no display name so public surfaces fail closed instead of inventing one.
export const TELEMETRY_PLAN_DISPLAY_NAMES = Object.freeze({
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro (More)",
  prolite: "Pro",
  promax: "Pro (Max)",
  team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business",
  ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise",
  edu: "Edu",
  edu_plus: "Edu Plus",
  edu_pro: "Edu Pro",
});

export const TELEMETRY_TOOL_CLASSES = Object.freeze([
  "webSearch",
  "fileSearch",
  "codeInterpreter",
  "hostedShell",
  "computerUse",
  "mcp",
  "applyPatch",
  "localShell",
  "subagent",
  "toolGateway",
  "other",
  "unknown",
]);

// Historical telemetry v0.x model vocabulary. Claude identities remain here only
// so existing versioned contributions can be recognized; active model identity
// and presentation use REVIEWED_MODEL_CATALOG, which is Codex-only.
export const TELEMETRY_MODEL_IDS = Object.freeze([
  "unknown",
  "gpt-4.1",
  "gpt-5",
  "gpt-5.4",
  "gpt-5.4-mini",
  "gpt-5.5",
  "gpt-5.5-codex",
  "gpt-5.6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "claude-fable-5",
  "claude-haiku-4-5-20251001",
  "claude-opus-4-8",
  "claude-sonnet-4-6",
  "claude-sonnet-5",
  "codex-auto-review",
  "gpt-4-turbo-2024-04-09",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-2024-05-13",
  "gpt-4o-mini",
  "gpt-5-codex",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-5-pro",
  "gpt-5.1",
  "gpt-5.1-codex",
  "gpt-5.1-codex-mini",
  "gpt-5.2",
  "gpt-5.2-codex",
  "gpt-5.2-pro",
  "gpt-5.3-codex",
  "gpt-5.3-codex-spark",
  "gpt-5.4-nano",
  "gpt-5.4-pro",
  "gpt-5.5-pro",
  "gpt-5.6-sol-wm",
  "gpt-6-astra",
  "o1",
  "o1-pro",
  "o3",
  "o3-mini",
  "o3-pro",
  "o4-mini",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-6.1-astra",
  "claude-fable-5-1",
  "claude-mythos-5-1",
  "claude-opus-5",
  "claude-opus-5-5",
  "gpt-6.1-sol",
  "gpt-5.1-codex-max",
]);
