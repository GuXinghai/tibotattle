import { translate } from "./localization.js";

export const WINDOW_BACKGROUND_PRESETS = Object.freeze([
  ["white", "#FFFFFF"], ["mist", "#F1F5F9"], ["stone", "#F5F5F4"], ["cream", "#FFFBEB"],
  ["mint", "#ECFDF5"], ["sky", "#F0F9FF"], ["violet", "#F5F3FF"], ["rose", "#FFF1F2"],
]);
export function normalizeHexColor(value) {
  if (typeof value !== "string") return null;
  const color = value.trim().replace(/^#?/u, "#").toUpperCase();
  return /^#[0-9A-F]{6}$/u.test(color) ? color : null;
}
export function rgbToHex(values) {
  if (!Array.isArray(values) || values.length !== 3) return null;
  const numbers = values.map(value => String(value).trim() === "" ? NaN : Number(value));
  return numbers.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    ? `#${numbers.map(n => n.toString(16).padStart(2, "0")).join("")}`.toUpperCase() : null;
}
export function validBackgroundResponse(result) {
  const value = result?.background;
  return ["ready", "cancelled"].includes(result?.status) && value
    && (value.color === null || normalizeHexColor(value.color) === value.color)
    && Number.isInteger(value.mask) && value.mask >= 0 && value.mask <= 90
    && (value.imageUrl === null || typeof value.imageUrl === "string"
      && /^tibotattle-background:\/\/image\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(value.imageUrl));
}

export async function mountWindowBackground({ documentRef = globalThis.document, windowRef = globalThis.window } = {}) {
  const bridge = windowRef?.tibotattleDesktop;
  if (bridge?.version !== "v1" || typeof bridge.getWindowBackground !== "function") return null;
  const controls = documentRef.querySelector("#window-background-controls");
  const root = documentRef.documentElement;
  const layer = documentRef.createElement("div");
  layer.id = "window-background-layer"; layer.setAttribute("aria-hidden", "true");
  documentRef.body.prepend(layer);
  let state = { color: null, mask: 35, imageUrl: null }, busy = false, disposed = false;
  let readVersion = 0, tail = Promise.resolve(), draftVersion = 0, patchTimer = null;
  let imageSize = null, imageVersion = 0, copyFrame = null;
  const copySurfaces = "dialog[open], .info-popover, .performance-tooltip, .refresh-notice-content, [popover]:popover-open, .work-usage-dialog-header, .model-performance-dialog-header";
  // Only the imported wallpaper is copied. Never sample the page, text or charts.
  // Paint containment gives each surface a fixed decoration that survives its
  // own scrolling; viewport coordinates also handle translated chart tooltips.
  function positionCopies() {
    copyFrame = null;
    if (disposed) return;
    for (const select of documentRef.querySelectorAll("select:open")) {
      const picker = windowRef.getComputedStyle(select, "::picker(select)");
      if (/^[0-9.]+px$/u.test(picker.height)) {
        const outer = parseFloat(picker.height);
        const edges = picker.boxSizing === "border-box"
          ? [picker.paddingTop, picker.paddingBottom, picker.borderTopWidth, picker.borderBottomWidth].reduce((sum, value) => sum + parseFloat(value || "0"), 0) : 0;
        const height = `${Math.max(0, Math.round((outer - edges) * 1000) / 1000)}px`;
        if (select.style.getPropertyValue("--window-background-picker-height") !== height) select.style.setProperty("--window-background-picker-height", height);
      }
    }
    if (disposed || !imageSize || !state.imageUrl) return;
    const viewport = layer.getBoundingClientRect();
    // innerWidth includes the scrollbar gutter. Document/layer widths do not,
    // so using those would recenter the wallpaper when a page starts scrolling.
    const scale = Math.max(windowRef.innerWidth / imageSize.width, windowRef.innerHeight / imageSize.height);
    const width = imageSize.width * scale, height = imageSize.height * scale;
    const x = viewport.left + (windowRef.innerWidth - width) / 2;
    const y = viewport.top + (windowRef.innerHeight - height) / 2;
    for (const [key, value] of Object.entries({
      "--window-background-viewport-image-size": `${width}px ${height}px`,
      "--window-background-viewport-image-position": `${x - viewport.left}px ${y - viewport.top}px`,
    })) {
      if (root.style.getPropertyValue(key) !== value) root.style.setProperty(key, value);
    }
    for (const surface of documentRef.querySelectorAll(copySurfaces)) {
      if (!surface.getClientRects().length) continue;
      const rect = surface.getBoundingClientRect();
      const properties = {
        "--window-background-copy-size": `${width}px ${height}px`,
        "--window-background-copy-position": `${x - rect.left - surface.clientLeft}px ${y - rect.top - surface.clientTop}px`,
        "--window-background-copy-scroll-x": `${surface.scrollLeft}px`,
        "--window-background-copy-scroll-y": `${surface.scrollTop}px`,
      };
      for (const [key, value] of Object.entries(properties)) {
        if (surface.style.getPropertyValue(key) !== value) surface.style.setProperty(key, value);
      }
    }
  }
  function scheduleCopies() {
    if (!disposed && copyFrame === null) copyFrame = windowRef.requestAnimationFrame(positionCopies);
  }
  const copyObserver = new windowRef.MutationObserver(scheduleCopies);
  copyObserver.observe(documentRef.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["style", "class", "hidden", "open"] });
  windowRef.addEventListener("resize", scheduleCopies);
  windowRef.addEventListener("scroll", scheduleCopies, true);
  // The picker is a UA scroller: it does not expose scrollTop or scroll events.
  // A zero-flow sticky copy is sized to its used height after opening instead.
  const pickerEvents = ["pointerdown", "click", "keydown", "toggle"];
  for (const event of pickerEvents) windowRef.addEventListener(event, scheduleCopies, true);
  // The dashboard/Settings owner creates the single document localizer. This
  // feature only translates its dynamic text using that owner's current locale.
  const localizer = controls ? { t: key => translate(key, {}, root.lang) } : null;
  const q = selector => controls?.querySelector(selector);
  const all = selector => [...(controls?.querySelectorAll(selector) ?? [])];
  const status = key => { const el = q("[data-background-status]"); if (el) { el.dataset.i18n = key; el.textContent = localizer.t(key); } };
  function updateControls() {
    if (!controls) return;
    const color = state.color ?? "#FFFFFF";
    q("[data-background-picker]").value = color;
    q("[data-background-chip]").style.backgroundColor = color;
    q("[data-background-hex]").value = color;
    all("[data-background-rgb]").forEach((el, i) => el.value = parseInt(color.slice(i * 2 + 1, i * 2 + 3), 16));
    q("[data-background-mask]").value = state.mask;
    q("output").textContent = `${state.mask}%`;
    q("[data-background-image-options]").hidden = state.imageUrl === null;
    const remove = q("[data-background-remove]"); remove.disabled = busy || state.imageUrl === null;
    const pick = q("[data-background-choose]");
    pick.dataset.i18n = state.imageUrl ? "background.replace" : "background.choose";
    pick.textContent = localizer.t(pick.dataset.i18n);
    all("[data-background-preset]").forEach(b => b.setAttribute("aria-pressed", String(!state.imageUrl && state.color === b.dataset.backgroundPreset)));
  }
  function apply(value) {
    const oldImage = state.imageUrl;
    state = { ...value };
    const active = state.color !== null || state.imageUrl !== null;
    root.toggleAttribute("data-window-background", active);
    root.style.setProperty("--window-background-color", state.color ?? "#FFFFFF");
    // Only a validated opaque local resource URL reaches this style. Keep the same
    // decoded image through mask/color edits and every resize.
    const imageStyle = state.imageUrl ? `url("${state.imageUrl}")` : "none";
    root.style.setProperty("--window-background-image", imageStyle);
    root.style.setProperty("--window-background-mask", state.imageUrl ? state.mask / 100 : 0);
    if (oldImage !== state.imageUrl) {
      layer.style.backgroundImage = imageStyle;
      imageSize = null;
      const version = ++imageVersion;
      root.style.setProperty("--window-background-copy-image", "none");
      if (state.imageUrl) {
        const image = new windowRef.Image();
        image.onload = () => {
          if (disposed || version !== imageVersion || !image.naturalWidth || !image.naturalHeight) return;
          imageSize = { width: image.naturalWidth, height: image.naturalHeight };
          root.style.setProperty("--window-background-copy-image", imageStyle);
          scheduleCopies();
        };
        image.src = state.imageUrl;
      }
    }
    scheduleCopies();
    updateControls();
  }
  async function read() {
    const version = ++readVersion;
    try {
      const result = await bridge.getWindowBackground();
      if (!disposed && version === readVersion && !busy && validBackgroundResponse(result)) apply(result.background);
    } catch { if (!disposed && controls) status("background.unavailable"); }
  }
  function run(action, value) {
    if (patchTimer !== null) { windowRef.clearTimeout(patchTimer); patchTimer = null; }
    const version = ++draftVersion;
    // Mutations are serialized, and edits are never overwritten by an older
    // response while a more recent valid edit is waiting to be saved.
    busy = true; ++readVersion;
    for (const el of all("[data-background-choose], [data-background-remove], [data-background-reset], [data-background-preset]")) el.disabled = true;
    status("background.saving");
    const work = tail.then(async () => {
      const result = value === undefined ? await bridge[action]() : await bridge[action](value);
      if (!validBackgroundResponse(result)) throw new Error("Background response invalid");
      if (!disposed && version === draftVersion) {
        apply(result.background);
        status(result.status === "cancelled" ? "background.cancelled" : "background.saved");
      }
    }).catch(() => { if (!disposed && version === draftVersion) status("background.failed"); }).finally(async () => {
      if (!disposed && version === draftVersion) {
        busy = false;
        for (const el of all("button")) el.disabled = false;
        // Reconcile failures with durable state without clearing the result notice.
        await read();
      }
    });
    tail = work; return work;
  }
  function colorEdit(color) {
    const error = q("[data-background-error]");
    error.hidden = color !== null;
    if (color === null) return;
    apply({ ...state, color });
    schedulePatch();
  }
  function schedulePatch() {
    ++draftVersion; ++readVersion;
    if (patchTimer !== null) windowRef.clearTimeout(patchTimer);
    patchTimer = windowRef.setTimeout(() => {
      patchTimer = null;
      void run("setWindowBackground", { color: state.color, mask: state.mask, removeImage: false });
    }, 200);
  }
  if (controls) {
    controls.hidden = false;
    const presets = q("[data-background-presets]");
    for (const [name, color] of WINDOW_BACKGROUND_PRESETS) {
      const button = documentRef.createElement("button"); button.type = "button";
      button.dataset.backgroundPreset = color; button.setAttribute("aria-pressed", "false");
      const swatch = documentRef.createElement("span"); swatch.className = "background-swatch";
      swatch.style.backgroundColor = color; swatch.setAttribute("aria-hidden", "true");
      button.dataset.i18nAriaLabel = `background.preset.${name}`;
      button.setAttribute("aria-label", localizer.t(button.dataset.i18nAriaLabel));
      button.append(swatch); presets.append(button);
      button.addEventListener("click", () => { apply({ ...state, color, imageUrl: null }); void run("setWindowBackground", { color, mask: state.mask, removeImage: true }); });
    }
    q("[data-background-picker]").addEventListener("input", event => colorEdit(normalizeHexColor(event.target.value)));
    q("[data-background-hex]").addEventListener("input", event => colorEdit(normalizeHexColor(event.target.value)));
    for (const el of all("[data-background-rgb]")) el.addEventListener("input", () => colorEdit(rgbToHex(all("[data-background-rgb]").map(x => x.value))));
    q("[data-background-mask]").addEventListener("input", event => {
      const mask = Number(event.target.value); apply({ ...state, mask });
      schedulePatch();
    });
    q("[data-background-choose]").addEventListener("click", () => void run("chooseWindowBackground"));
    q("[data-background-remove]").addEventListener("click", () => void run("setWindowBackground", { color: state.color, mask: state.mask, removeImage: true }));
    q("[data-background-reset]")?.addEventListener("click", () => void run("restoreWindowBackground"));
  }
  const localeChanged = () => {
    updateControls();
    for (const button of all("[data-background-preset]")) button.setAttribute("aria-label", localizer.t(button.dataset.i18nAriaLabel));
  };
  if (controls) windowRef?.addEventListener?.("tibotattle:locale-change", localeChanged);
  const unsubscribe = bridge.onCommand?.(command => {
    if (command.command === "windowBackground") void read();
  });
  await read();
  return { teardown() { disposed = true; ++readVersion; ++imageVersion; copyObserver.disconnect(); if (copyFrame !== null) windowRef.cancelAnimationFrame(copyFrame); windowRef.removeEventListener("resize", scheduleCopies); windowRef.removeEventListener("scroll", scheduleCopies, true); for (const event of pickerEvents) windowRef.removeEventListener(event, scheduleCopies, true); if (patchTimer !== null) windowRef.clearTimeout(patchTimer); windowRef?.removeEventListener?.("tibotattle:locale-change", localeChanged); unsubscribe?.(); layer.remove(); } };
}

if (typeof document !== "undefined") void mountWindowBackground();
