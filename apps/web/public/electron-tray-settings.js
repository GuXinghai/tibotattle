import { translate } from "./localization.js";
import { normalizeTrayPreferences, validTrayPreferences, TRAY_OPTIONS } from "./electron-tray-preferences.js";

/** A renderer-owned undo slot; persistence and validation remain in the host. */
export function createTraySettingsController({ documentRef, bridge, localizer } = {}) {
  const root = documentRef?.querySelector?.("#settings-tray-controls");
  if (!root || typeof documentRef.createElement !== "function") return { update() {}, teardown() {} };
  const translationKeys = new Map();
  const t = (key, values) => {
    const layoutKeys = ["openPreview", "closePreview", "iconAndTooltip", "panelContent", "panelAppearance"];
    const id = `${layoutKeys.includes(key) ? "electron.settings.trayCustomization" : "electron.trayCustomization"}.${key}`;
    const copy = localizer?.t?.(id, values) ?? translate(id, values);
    if (values === undefined) translationKeys.set(copy, id);
    return copy;
  };
  let current = normalizeTrayPreferences(null);
  let previous = null;
  let busy = false;
  let available = false;
  let status = "current";
  let capabilities = {};
  let exampleState = "current";
  const listeners = [];
  const node = (tag, copy, className) => {
    const element = documentRef.createElement(tag);
    if (copy !== undefined) {
      element.textContent = copy;
      // Static controls join the page's existing language-change mechanism.
      const key = translationKeys.get(copy);
      if (key) element.setAttribute("data-i18n", key);
    }
    if (className) element.className = className;
    return element;
  };
  const listen = (element, type, handler) => {
    element.addEventListener(type, handler);
    listeners.push(() => element.removeEventListener(type, handler));
  };
  const notice = node("p", "", "settings-tray-notice");
  notice.setAttribute("role", "status");
  notice.setAttribute("aria-live", "polite");
  const controls = node("div", undefined, "settings-tray-grid");
  const selections = new Map();
  const selectionFields = new Map();
  function select(parent, key) {
    const label = node("label", undefined, "settings-field");
    label.append(node("span", t(key)));
    const input = node("select");
    input.id = `tray-${key}`;
    for (const value of TRAY_OPTIONS[key]) {
      const option = node("option", t(`option.${value}`));
      option.value = value;
      input.append(option);
    }
    label.append(input);
    parent.append(label);
    selections.set(key, input);
    selectionFields.set(key, label);
    listen(input, "change", () => {
      const next = { ...current, [key]: input.value };
      if (next.preset === "both") next.barMetric = "remaining";
      void save(next);
    });
  }
  const bar = node("fieldset", undefined, "settings-card settings-tray-group");
  bar.append(node("legend", t("iconAndTooltip")));
  for (const key of ["preset", "barMetric", "resetFormat"]) select(bar, key);
  const capabilityNotice = node("p", "", "settings-tray-note");
  bar.append(capabilityNotice);
  controls.append(bar);
  const preview = node("section", undefined, "settings-card settings-tray-preview");
  preview.setAttribute("aria-label", t("preview"));
  preview.append(node("h3", t("preview")), node("p", t("example"), "settings-tray-note"));
  const stateLabel = node("label", undefined, "settings-field");
  stateLabel.append(node("span", t("previewState")));
  const stateSelect = node("select");
  for (const value of ["current", "refreshing", "partial", "stale", "offline"]) {
    const option = node("option", t(`state.${value}`));
    option.value = value;
    stateSelect.append(option);
  }
  stateLabel.append(stateSelect);
  const previewBar = node("div", undefined, "settings-tray-preview-bar");
  preview.append(stateLabel, previewBar);
  listen(stateSelect, "change", () => { exampleState = stateSelect.value; renderPreview(); });
  const actions = node("div", undefined, "settings-tray-actions");
  const undo = node("button", t("undo"), "button");
  const restore = node("button", t("restore"), "button");
  undo.type = restore.type = "button";
  actions.append(undo, restore);
  listen(undo, "click", () => { if (previous) void save(previous, { undoing: true }); });
  listen(restore, "click", () => void save(null, { restoring: true }));
  const previewButton = node("button", t("openPreview"), "button button-quiet");
  previewButton.type = "button";
  const dialog = node("dialog", undefined, "settings-tray-dialog");
  dialog.setAttribute("aria-label", t("preview"));
  const closePreview = node("button", t("closePreview"), "button button-quiet settings-preview-close");
  closePreview.type = "button";
  dialog.append(closePreview, preview);
  listen(previewButton, "click", () => dialog.showModal?.());
  listen(closePreview, "click", () => dialog.close?.());
  root.replaceChildren(previewButton, controls, dialog, actions, notice);

  function renderPreview() {
    const missing = exampleState === "offline";
    const stale = exampleState === "stale";
    const value = missing || stale || exampleState === "partial" ? "—" : "63%";
    const week = missing || stale ? "—" : "8%";
    const reset = current.resetFormat === "clock" ? t("exampleClock") : t("exampleCountdown");

    const icon = node("span", undefined, "settings-tray-preview-icon");
    const bird = node("img");
    bird.src = "./app-icon.png";
    bird.alt = "";
    bird.width = bird.height = 22;
    icon.append(bird);
    icon.setAttribute("aria-label", t("option.app"));
    previewBar.replaceChildren(icon);
    const windows = current.preset === "both" ? [["5h", value], ["7d", week]]
      : current.preset === "icon-only" ? [] : [[current.preset === "five-hour" ? "5h" : "7d", current.preset === "five-hour" ? value : week]];
    previewBar.title = windows.map(([label, amount]) => `${label} ${amount}`).join(" · ");
    for (const [index, [label, amount]] of windows.entries()) {
      if (index > 0 && capabilities.title !== false) previewBar.append(node("span", "·"));
      const metric = current.barMetric === "remaining" || current.preset === "both" ? `${label} ${amount}`
        : `${label} ${current.barMetric === "remaining-reset" ? `${amount} · ` : ""}${missing || stale || amount === "—" ? "—" : reset}`;
      const text = node("span", metric);
      if (capabilities.title !== false) previewBar.append(text);
    }
  }

  function render() {
    const locked = busy || !available || status !== "current";
    for (const [key, input] of selections) {
      input.value = current[key];
      selectionFields.get(key).hidden = capabilities.title === false && key === "barMetric";
      if (key === "preset") {
        const caption = selectionFields.get(key).children[0];
        const labelKey = capabilities.title === false ? "tooltipPreset" : "preset";
        caption.textContent = t(labelKey);
        caption.setAttribute("data-i18n", `electron.trayCustomization.${labelKey}`);
      }
      input.disabled = locked || (key === "barMetric" && (current.preset === "both" || current.preset === "icon-only"));
    }
    undo.disabled = locked || previous === null;
    // Unknown or unreadable files remain owned by the compatible host version.
    restore.disabled = locked;
    capabilityNotice.textContent = capabilities.title === false ? t("platformTooltip") : "";
    capabilityNotice.hidden = capabilityNotice.textContent === "";
    if (status !== "current") notice.textContent = t(status === "future" ? "future" : "invalid");
    renderPreview();
  }
  async function save(next, { restoring = false, undoing = false, focusMove = null } = {}) {
    if (!available || busy) return;
    if (!restoring && !validTrayPreferences(next)) {
      notice.textContent = t("usageRule");
      render();
      return;
    }
    const focusId = documentRef.activeElement?.id;
    const before = normalizeTrayPreferences(current);
    busy = true;
    render();
    try {
      const result = await (restoring ? bridge.restoreTrayDefaults() : bridge.setTrayPreferences(next));
      const saved = result?.settings?.tray ?? result?.tray ?? next;
      if (!validTrayPreferences(saved)) throw new Error("Unavailable settings result");
      current = normalizeTrayPreferences(saved);
      previous = undoing ? null : before;
      status = "current";
      notice.textContent = t("saved");
    } catch {
      current = before;
      notice.textContent = t("saveFailed");
    } finally {
      busy = false;
      render();
      if (focusMove) root.querySelector(`[data-tray-move="${focusMove}"]`)?.focus();
      else if (focusId) documentRef.getElementById?.(focusId)?.focus();
    }
  }
  render();
  return {
    update(state, connected = true) {
      if (busy) return;
      current = normalizeTrayPreferences(state?.tray);
      status = state?.traySettingsStatus ?? "current";
      capabilities = state?.trayCapabilities ?? {};
      for (const id of ["settings-tray-heading"]) {
        const heading = documentRef.getElementById?.(id);
        if (heading) {
          const key = capabilities.title === true ? "menuBar" : "title";
          heading.textContent = t(key);
          heading.setAttribute("data-i18n", `electron.trayCustomization.${key}`);
        }
      }
      available = connected && typeof bridge?.setTrayPreferences === "function" && typeof bridge?.restoreTrayDefaults === "function";
      render();
    },
    teardown() {
      dialog.close?.(); for (const remove of listeners) remove(); },
  };
}
