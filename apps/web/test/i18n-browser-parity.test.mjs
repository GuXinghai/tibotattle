import productBrand from "../../../config/product-brand.cjs";
import assert from "node:assert/strict";
import test from "node:test";

import * as canonical from "../../../packages/i18n/index.js";
import {
  I18N_BROWSER_MIRROR_FILE,
  buildI18nBrowserMirror,
  checkI18nBrowserMirror,
} from "../../../scripts/generate-i18n-browser-mirror.js";
import * as browser from "../public/i18n.generated.js";
import { translate } from "../public/localization.js";

test("dashboard notice details resolve through the runtime browser translator", () => {
  for (const locale of canonical.SUPPORTED_LOCALES) {
    assert.equal(translate("dashboard.notice.details", {}, locale),
      canonical.CATALOGS[locale]["dashboard.notice.details"]);
    assert.equal(translate("dashboard.overview.partial", {}, locale),
      canonical.CATALOGS[locale]["dashboard.overview.partial"]);
  }
});

test("the browser i18n mirror is current and exposes the canonical contract", async () => {
  assert.equal(await checkI18nBrowserMirror(), true);
  assert.deepEqual(Object.keys(browser).sort(), [...Object.keys(canonical), "PRODUCT_BRAND_NAMES", "PRODUCT_FULL_NAME"].sort());
  assert.deepEqual(browser.PRODUCT_BRAND_NAMES, productBrand.names);
  assert.equal(browser.PRODUCT_FULL_NAME, productBrand.fullName);
  assert.equal(
    await buildI18nBrowserMirror(),
    await import("node:fs/promises").then(({ readFile }) =>
      readFile(I18N_BROWSER_MIRROR_FILE, "utf8")),
  );

  assert.equal(
    browser.formatNumber(1234567.89, "en-US"),
    canonical.formatNumber(1234567.89, "en-US"),
  );
  assert.equal(
    browser.formatDate("2026-08-03T12:00:00.000Z", "en-US"),
    canonical.formatDate("2026-08-03T12:00:00.000Z", "en-US"),
  );
  for (const value of ["en-us", "zh-CN", "zh-Hant-TW", "invalid_locale", null]) {
    assert.equal(browser.canonicalizeLocale(value), canonical.canonicalizeLocale(value));
  }
  for (const value of ["en-US", "en", "zh-CN", "zh-TW", "zh-Hant", "es-MX", null]) {
    assert.equal(browser.negotiateLocale(value), canonical.negotiateLocale(value));
  }
});
