// Provider identities only; quota, entitlement and pricing are separate.
export const CODEX_PLAN_DISPLAY_NAMES = Object.freeze({
  free: "Free", go: "Go", plus: "Plus", pro: "Pro 200",
  prolite: "Pro 100", promax: "Pro 500", team: "Team",
  self_serve_business_prolite: "Self Serve Business ProLite",
  self_serve_business_usage_based: "Self Serve Business Usage Based",
  business: "Business", ent26: "Enterprise",
  enterprise_cbp_automation: "Enterprise (Automation)",
  enterprise_cbp_usage_based: "Enterprise CBP Usage Based",
  enterprise: "Enterprise", edu: "Edu", edu_plus: "Edu Plus",
  edu_pro: "Edu Pro", sci: "Academic Researchers",
  sci_plus: "Academic Researchers Plus",
});

export const CODEX_PLAN_TYPES = Object.freeze([
  ...Object.keys(CODEX_PLAN_DISPLAY_NAMES), "unknown",
]);
