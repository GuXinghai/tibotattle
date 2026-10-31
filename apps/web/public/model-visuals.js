// Shared decorative model identity for dashboard charts and local usage tables.
// GPT-6/6.1 models reuse their GPT-5.6 family icons. The canonical catalog
// and accounting package own recognition and pricing separately.
const MODEL_PRESENTATION_ORDER = Object.freeze([
  "gpt-6-astra", "gpt-6.1-sol", "gpt-6.1-terra", "gpt-6-sol", "gpt-5.6-sol", "gpt-5.6-terra",
  "gpt-6-luna", "gpt-5.6-luna", "gpt-5.5",
]);
const MODEL_PRESENTATION_THEMES = Object.freeze([
  "astra", "sol", "terra", "sol", "sol", "terra", "luna", "luna", "classic",
]);

// Charts, pickers and usage tables share ordering, colours and decorative icons.
export function allowanceModelPresentation(modelId, catalogIndex = 0) {
  const preferred = MODEL_PRESENTATION_ORDER.indexOf(modelId);
  return {
    order: preferred < 0 ? MODEL_PRESENTATION_ORDER.length + catalogIndex : preferred,
    theme: preferred < 0 ? null : MODEL_PRESENTATION_THEMES[preferred],
    className: preferred < 0 ? `allowance-series-${catalogIndex % 8}`
      : `allowance-model-${MODEL_PRESENTATION_THEMES[preferred]}`,
  };
}

export function modelUsagePresentation(modelId) {
  modelId = typeof modelId === "string" ? modelId.trim().toLowerCase() : "";
  if (modelId === "gpt-5.3-codex-spark") return { theme: "spark", className: "allowance-model-spark" };
  if (modelId === "codex-auto-review") return { theme: "review", className: "allowance-model-review" };
  if (/^(?:gpt|codex)-.*\b(?:mini|nano)\b/.test(modelId)) {
    return { theme: "mini", className: "allowance-model-mini" };
  }
  const numberedThemes = {
    "5.4": "layers", "5.3": "grid", "5.2": "box", "5.1": "folder",
    "5": "chip", "4.1": "book", "4o": "rings", "4": "file",
  };
  const numbered = /^gpt-(5\.4|5\.3|5\.2|5\.1|5|4\.1|4o|4)(?:-|$)/.exec(modelId);
  if (numbered) return { theme: numberedThemes[numbered[1]], className: "allowance-model-classic" };
  const aliases = { "gpt-5.5-codex": "gpt-5.5", "gpt-5.6-sol-wm": "gpt-5.6-sol" };
  const presentation = allowanceModelPresentation(aliases[modelId] ?? modelId);
  return presentation.theme ? presentation : { theme: "generic", className: "allowance-model-classic" };
}

// Keep known families in the same order as the shared model identity catalog.
// Preserve exact IDs (including aliases) because these are filter values.
export function compareModelPresentation(left, right) {
  const rank = (id) => {
    const aliases = { "gpt-5.5-codex": "gpt-5.5", "gpt-5.6-sol-wm": "gpt-5.6-sol" };
    const index = MODEL_PRESENTATION_ORDER.indexOf(aliases[id] ?? id);
    return index < 0
      ? MODEL_PRESENTATION_ORDER.length + (modelUsagePresentation(id).theme === "generic" ? 1 : 0)
      : index;
  };
  return rank(left) - rank(right)
    || (right.startsWith(`${left}-`) ? -1 : left.startsWith(`${right}-`) ? 1 : 0)
    || right.localeCompare(left, "en", { numeric: true });
}

export function modelThemeIcon(documentRef, theme) {
  // Shared 24-unit canvas: compact glyphs sit within an 18-unit live area.
  // Keep optical centring independent of model recognition and chart colours.
  const paths = {
    astra: "M12 3 14.5 9.5 21 12 14.5 14.5 12 21 9.5 14.5 3 12 9.5 9.5Z",
    sol: "M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8 M12 3v2 M12 19v2 M3 12h2 M19 12h2 M5.5 5.5 7 7 M17 17 18.5 18.5 M5.5 18.5 7 17 M17 7 18.5 5.5",
    terra: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M4 8h5l2 4-3 2 1 6 M14 4l-1 4 4 2 3-1 M18 14l-3 1-1 5",
    luna: "M20.85 14.15A9 9 0 0 1 9.85 3.15a9 9 0 1 0 11 11Z",
    spark: "M12.9 3 5.7 13.8h5.4L10.2 21 18.3 9.3h-5.4Z",
    classic: "M3 4h18v16H3Z M9 4v16 M3 10h18",
    review: "M12 3l8 3v6c0 4.5-4.6 7.6-8 9-3.4-1.4-8-4.5-8-9V6l8-3Z M8.5 11.8l2.4 2.4 4.6-4.6",
    mini: "M7 7h10v10H7Z M9 3v4 M15 3v4 M9 17v4 M15 17v4 M3 9h4 M3 15h4 M17 9h4 M17 15h4",
    layers: "M3 8l9-5 9 5-9 5Z M3 12l9 5 9-5 M3 16l9 5 9-5",
    grid: "M3 3h7v7H3Z M14 3h7v7h-7Z M3 14h7v7H3Z M14 14h7v7h-7Z",
    box: "M4 7l8-4 8 4v10l-8 4-8-4Z M4 7l8 4 8-4 M12 11v10",
    folder: "M3 7V5h6l2 2h10v12H3Z",
    chip: "M6 6h12v12H6Z M9 3v3 M15 3v3 M9 18v3 M15 18v3 M3 9h3 M3 15h3 M18 9h3 M18 15h3",
    book: "M12 6C9 4 6 4 3 5v14c3-1 6-1 9 1 3-2 6-2 9-1V5c-3-1-6-1-9 1Z M12 6v14",
    rings: "M9.3 5.7a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6 M14.7 5.7a6.3 6.3 0 1 0 0 12.6 6.3 6.3 0 0 0 0-12.6",
    file: "M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6",
    generic: "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1.1.7-1.8 1.1-1.8 2.3 M12 16.5h.01",
  };
  if (!paths[theme]) return null;
  const icon = documentRef.createElementNS("http://www.w3.org/2000/svg", "svg");
  for (const [name, value] of Object.entries({ class: "allowance-model-icon", viewBox: "0 0 24 24", "aria-hidden": "true", focusable: "false" })) icon.setAttribute(name, value);
  const path = documentRef.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", paths[theme]);
  icon.append(path);
  return icon;
}
