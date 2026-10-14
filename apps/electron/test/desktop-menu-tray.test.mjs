import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";

import {
  createDesktopActionInterface,
  createDesktopMenuTemplate,
  DESKTOP_ACTION_NAMES,
  installDesktopApplicationMenu,
  resolveDesktopLocale,
} from "../desktop-menu.js";
import {
  createDesktopTrayIconFactory,
  createDesktopTrayTemplate,
  extractDesktopTrayTemplateBitmap,
  resolveDesktopTrayIcon,
  STATUS_PLACEHOLDER,
  TRAY_ICON_RELATIVE_PATH,
  TRAY_ICON_SIZE,
  TRAY_TEMPLATE_CROP_INSET_RATIO,
  TRAY_TEMPLATE_CROP_SIZE_RATIO,
} from "../desktop-tray.js";

function actionRecorder() {
  const calls = [];
  const actions = Object.fromEntries(
    DESKTOP_ACTION_NAMES.map((name) => [name, () => calls.push(name)]),
  );
  return { actions, calls };
}

function item(template, label) {
  const value = template.find((entry) => entry.label === label);
  assert.ok(value, `missing menu item: ${label}`);
  return value;
}

test("desktop action interface is bounded and supplies safe no-ops", () => {
  const actions = createDesktopActionInterface({ show: () => "shown" });
  assert.equal(Object.isFrozen(actions), true);
  assert.deepEqual(Object.keys(actions), [...DESKTOP_ACTION_NAMES]);
  assert.equal(actions.show(), "shown");
  for (const name of DESKTOP_ACTION_NAMES.filter((value) => value !== "show")) {
    assert.doesNotThrow(() => actions[name](), name);
  }
  assert.throws(
    () => createDesktopActionInterface(null),
    /actions must be an object/u,
  );
});

test("missing usage refresh is a no-op and cannot invoke the separate retry action", () => {
  const calls = [];
  const actions = createDesktopActionInterface({
    retry: () => calls.push("retry"),
  });
  actions.refresh();
  assert.deepEqual(calls, []);
  actions.retry();
  assert.deepEqual(calls, ["retry"]);
});


test("Windows menus use conventional File and Help entries", () => {
  const { actions, calls } = actionRecorder();
  for (const platform of ["win32"]) {
    const template = createMenuFixture({
      appName: "TiboTattle Dev",
      platform,
      actions,
    });
    assert.deepEqual(template.map(({ label }) => label), [
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
    ]);
    const file = template.find(({ label }) => label === "File").submenu;
    item(file, "Open").click();
    item(file, "Settings…").click();
    item(file, "Exit").click();
    const help = template.find(({ label }) => label === "Help").submenu;
    item(help, "About TiboTattle Dev").click();
    assert.equal(item(file, "Settings…").accelerator, "CmdOrCtrl+,");
    assert.equal(item(file, "Exit").accelerator, "CmdOrCtrl+Q");
  }
  assert.deepEqual(calls.slice(-4), ["show", "settings", "quit", "about"]);
});

test("desktop menu and tray copy resolves every supported language", () => {
  const expected = {
    "en-US": {
      file: "File",
      overview: "Overview",
      sections: ["Usage & costs", "Allowance", "Model performance"],
      refresh: "Update Local Usage",
      checkForUpdates: "Check for Updates…",
      tray: "Open TiboTattle Dev",
      update: "Update Local Usage",
      quit: "Quit TiboTattle Dev",
      status: "Stale",
    },
    "zh-Hans": {
      file: "文件",
      overview: "概览",
      sections: ["用量与成本", "额度", "模型性能"],
      refresh: "更新本地用量",
      checkForUpdates: "检查更新…",
      tray: "打开 TiboTattle Dev",
      update: "更新本地用量",
      quit: "退出 TiboTattle Dev",
      status: "已过时",
    },
    es: {
      file: "Archivo",
      overview: "Resumen",
      sections: ["Uso y costos", "Asignación", "Rendimiento de modelos"],
      refresh: "Actualizar uso local",
      checkForUpdates: "Buscar actualizaciones…",
      tray: "Abrir TiboTattle Dev",
      update: "Actualizar uso local",
      quit: "Salir de TiboTattle Dev",
      status: "Desactualizado",
    },
  };
  for (const [locale, copy] of Object.entries(expected)) {
    assert.equal(resolveDesktopLocale(locale, ["en-US"]), locale);
    const menu = createMenuFixture({
      appName: "TiboTattle Dev",
      platform: "win32",
      locale,
    });
    assert.equal(menu[0].label, copy.file);
    const file = menu[0].submenu;
    assert.equal(file[1].label, locale === "en-US" ? "Settings…" : locale === "zh-Hans" ? "设置…" : "Configuración…");
    const view = menu.find(({ label }) => label === (locale === "en-US" ? "View" : locale === "zh-Hans" ? "视图" : "Ver"));
    assert.equal(view.submenu[0].label, copy.refresh);
    assert.equal(typeof item(view.submenu, copy.overview).click, "function");
    for (const label of copy.sections) assert.equal(typeof item(view.submenu, label).click, "function");
    const tray = createTrayFixture({
      appName: "TiboTattle Dev",
      locale,
      trayStatus: { status: "stale", allowance: null, notificationEvidence: null },
    });
    assert.equal(tray.find((entry) => entry.label === copy.tray)?.label, copy.tray);
    assert.equal(tray.find((entry) => entry.label === copy.update)?.label, copy.update);
    const checkForUpdates = tray.find((entry) => entry.label === copy.checkForUpdates);
    assert.ok(checkForUpdates);
    assert.equal(checkForUpdates.enabled, false);
    assert.equal(checkForUpdates.click, undefined);
    assert.equal(tray.find((entry) => entry.label === copy.quit)?.label, copy.quit);
    assert.equal(tray[1].label, copy.status);
  }
});

test("application menu installation is dependency-injected and optional in plain Node", () => {
  const calls = [];
  const menu = { template: [] };
  const Menu = {
    buildFromTemplate(template) {
      calls.push(["build", template]);
      return menu;
    },
    setApplicationMenu(value) {
      calls.push(["set", value]);
    },
  };
  assert.equal(installDesktopApplicationMenu({ Menu, appName: "TiboTattle" }), menu);
  assert.equal(calls[0][0], "build");
  assert.deepEqual(calls[1], ["set", menu]);
  assert.equal(installDesktopApplicationMenu({ Menu: undefined }), null);
});

test("tray menu exposes truthful status and shared action callbacks", () => {
  const { actions, calls } = actionRecorder();
  const template = createTrayFixture({
    appName: "TiboTattle Dev",
    actions,
  });
  assert.deepEqual(template.map(({ label, type }) => type === "separator" ? type : label), [
    "TiboTattle Dev · – allowance",
    STATUS_PLACEHOLDER,
    "separator",
    "Open TiboTattle Dev",
    "Allowance",
    "Usage & costs",
    "Model performance",
    "Retry",
    "Check for Updates…",
    "Settings…",
    "About TiboTattle Dev",
    "separator",
    "Quit TiboTattle Dev",
  ]);
  assert.equal(item(template, STATUS_PLACEHOLDER).enabled, false);
  item(template, "Open TiboTattle Dev").click();
  item(template, "Allowance").click();
  item(template, "Usage & costs").click();
  item(template, "Model performance").click();
  item(template, "Retry").click();
  item(template, "Settings…").click();
  item(template, "About TiboTattle Dev").click();
  item(template, "Quit TiboTattle Dev").click();
  assert.deepEqual(calls, [
    "show",
    "allowance",
    "usage",
    "performance",
    "retry",
    "settings",
    "about",
    "quit",
  ]);
  assert.equal(item(template, "Check for Updates…").enabled, false);
  assert.equal(item(template, "Check for Updates…").click, undefined);
  assert.equal(item(template, "Retry").accelerator, undefined);
  assert.equal(item(template, "Settings…").accelerator, "CmdOrCtrl+,");
  assert.equal(item(template, "Quit TiboTattle Dev").accelerator, "CmdOrCtrl+Q");
});


test("tray check-for-updates is enabled only for an injected bounded capability", () => {
  const calls = [];
  const template = createTrayFixture({
    appName: "TiboTattle Dev",
    actions: { checkForUpdates: () => calls.push("checkForUpdates") },
  });
  const checkForUpdates = item(template, "Check for Updates…");
  assert.equal(checkForUpdates.enabled, true);
  checkForUpdates.click();
  assert.deepEqual(calls, ["checkForUpdates"]);
});

function nativeImageFixture({
  sourceEmpty = false,
  resizedEmpty = false,
  includeTemplate = true,
} = {}) {
  const calls = {
    createFromPath: [],
    crop: [],
    resize: [],
    template: [],
  };
  const resized = {
    isEmpty: () => resizedEmpty,
  };
  if (includeTemplate) {
    resized.setTemplateImage = (value) => calls.template.push(value);
  }
  const source = {
    isEmpty: () => sourceEmpty,
    getSize: () => ({ width: 1_024, height: 1_024 }),
    crop: (options) => {
      calls.crop.push(options);
      return source;
    },
    resize: (options) => {
      calls.resize.push(options);
      return resized;
    },
  };
  return {
    calls,
    resized,
    nativeImage: {
      createFromPath: (value) => {
        calls.createFromPath.push(value);
        return source;
      },
    },
  };
}





test("real packaged bird asset produces a sparse template, not a white plate", async () => {
  const { readFile } = await import("node:fs/promises");
  const { inflateSync } = await import("node:zlib");
  const assetPath = new URL("../../web/public/tibotattle-icon.png", import.meta.url);
  const png = await readFile(assetPath);

  // This deliberately small decoder handles the reviewed RGBA/non-interlaced
  // brand asset without introducing an image dependency into the Electron
  // unit-test lane. It also makes an accidental replacement with a flat plate
  // fail the test instead of merely checking the file's existence.
  assert.deepEqual([...png.subarray(0, 8)], [
    137, 80, 78, 71, 13, 10, 26, 10,
  ]);
  let width = 0;
  let height = 0;
  const compressed = [];
  let offset = 8;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.equal(data[8], 8, "brand PNG uses 8-bit samples");
      assert.equal(data[9], 6, "brand PNG uses RGBA samples");
      assert.equal(data[12], 0, "brand PNG is not interlaced");
    } else if (type === "IDAT") {
      compressed.push(data);
    }
    offset += 12 + length;
  }
  assert.equal(width, 1_024);
  assert.equal(height, 1_024);
  const scanlineBytes = width * 4;
  const decoded = inflateSync(Buffer.concat(compressed));
  assert.equal(decoded.length, height * (scanlineBytes + 1));
  const rgba = Buffer.alloc(width * height * 4);
  let sourceOffset = 0;
  let destinationOffset = 0;
  let previous = Buffer.alloc(scanlineBytes);
  for (let y = 0; y < height; y += 1) {
    const filter = decoded[sourceOffset++];
    const row = Buffer.from(decoded.subarray(sourceOffset, sourceOffset + scanlineBytes));
    sourceOffset += scanlineBytes;
    for (let x = 0; x < scanlineBytes; x += 1) {
      const left = x >= 4 ? row[x - 4] : 0;
      const above = previous[x];
      const upperLeft = x >= 4 ? previous[x - 4] : 0;
      if (filter === 1) row[x] = (row[x] + left) & 0xff;
      else if (filter === 2) row[x] = (row[x] + above) & 0xff;
      else if (filter === 3) row[x] = (row[x] + Math.floor((left + above) / 2)) & 0xff;
      else if (filter === 4) {
        const p = left + above - upperLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - above);
        const pc = Math.abs(p - upperLeft);
        row[x] = (row[x] + (pa <= pb && pa <= pc ? left : pb <= pc ? above : upperLeft)) & 0xff;
      } else assert.equal(filter, 0, `unsupported PNG filter ${filter}`);
    }
    row.copy(rgba, destinationOffset);
    destinationOffset += scanlineBytes;
    previous = row;
  }

  // Sample the same crop into the 64px BGRA surface used by nativeImage.
  const cropX = Math.floor(width * TRAY_TEMPLATE_CROP_INSET_RATIO);
  const cropY = Math.floor(height * TRAY_TEMPLATE_CROP_INSET_RATIO);
  const cropWidth = Math.round(width * TRAY_TEMPLATE_CROP_SIZE_RATIO);
  const cropHeight = Math.round(height * TRAY_TEMPLATE_CROP_SIZE_RATIO);
  const bitmap = Buffer.alloc(64 * 64 * 4);
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const sourceX = Math.min(width - 1, cropX + Math.floor(x * cropWidth / 64));
      const sourceY = Math.min(height - 1, cropY + Math.floor(y * cropHeight / 64));
      const source = (sourceY * width + sourceX) * 4;
      const target = (y * 64 + x) * 4;
      bitmap[target] = rgba[source + 2];
      bitmap[target + 1] = rgba[source + 1];
      bitmap[target + 2] = rgba[source];
      bitmap[target + 3] = rgba[source + 3];
    }
  }
  const extracted = extractDesktopTrayTemplateBitmap(bitmap);
  assert.ok(extracted, "real asset should produce a template bitmap");
  let retained = 0;
  let transparent = 0;
  for (let index = 3; index < extracted.length; index += 4) {
    if (extracted[index] > 0) retained += 1;
    if (extracted[index] === 0) transparent += 1;
  }
  // The bird occupies a meaningful but bounded part of the crop. A flat
  // plate would retain nearly all 4,096 pixels; a missing/blank mark retains
  // none. Keep these bounds deliberately broad around the reviewed asset.
  assert.ok(retained >= 500, `expected bird occupancy, got ${retained}`);
  assert.ok(transparent >= 800, `expected plate removal, got ${transparent}`);
});

test("Windows tray icon resolution uses the same fixed asset without template mode", () => {
  const fixture = nativeImageFixture();
  const result = resolveDesktopTrayIcon({
    nativeImage: fixture.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "win32",
  });
  assert.equal(result, fixture.resized);
  assert.deepEqual(fixture.calls.createFromPath, [
    join("/trusted/app", TRAY_ICON_RELATIVE_PATH),
  ]);
  assert.deepEqual(fixture.calls.template, []);
});

test("tray icon resolution keeps an explicit injected icon seam", () => {
  const icon = { kind: "reviewed-test-icon" };
  assert.equal(resolveDesktopTrayIcon({ icon }), icon);
});

test("tray icon resolution fails closed for missing, empty, and invalid images", () => {
  const emptySource = nativeImageFixture({ sourceEmpty: true });
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: emptySource.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "win32",
  }), undefined);
  assert.deepEqual(emptySource.calls.resize, []);

  const emptyResized = nativeImageFixture({ resizedEmpty: true });
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: emptyResized.nativeImage,
    resourceRoot: "/trusted/app",
    platform: "win32",
  }), undefined);

  assert.equal(resolveDesktopTrayIcon({
    nativeImage: {
      createFromPath() {
        throw new Error("asset missing");
      },
    },
    resourceRoot: "/trusted/app",
  }), undefined);
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: {},
    resourceRoot: "/trusted/app",
  }), undefined);
  assert.equal(resolveDesktopTrayIcon({
    nativeImage: nativeImageFixture().nativeImage,
    resourceRoot: "relative-root",
  }), undefined);
});

function createTrayFixture(options = {}) {
  return createDesktopTrayTemplate({ locale: "en-US", ...options });
}

function createMenuFixture(options = {}) {
  return createDesktopMenuTemplate({ locale: "en-US", ...options });
}
