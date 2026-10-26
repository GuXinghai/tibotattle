/**
 * Positive source membership for the reviewed client surfaces.
 *
 * This is deliberately data-only.  A surface entry is an exact repository
 * relative path, never a glob or a directory to discover.  Route aliases,
 * native policy, public-site exclusions, and test-lane selection remain
 * separate contracts at their owning boundaries.
 */

export const SURFACE_MANIFEST_SCHEMA = "usagemonitor-surface-manifest-v0.1";

const SHARED_WEB_FILES = Object.freeze([
  "apps/web/public/app.js",
  "apps/web/public/cache-reuse-matrix.js",
  "apps/web/public/cache-reuse-matrix.css",
  "apps/web/public/cache-reuse-metrics.js",
  "apps/web/public/trends-horizon.js",
  "apps/web/public/overview-workload.js",
  "apps/web/public/allowance-trends.js",
  "apps/web/public/allowance-page.js",
  "apps/web/public/weekly-api-intervals.js",
  "apps/web/public/weekly-api-chart.js",
  "apps/web/public/community-data.js",
  "apps/web/public/data-client.js",
  "apps/web/public/desktop-appearance.js",
  "apps/web/public/dashboard-report-preload.js",
  "apps/web/public/dashboard-ui.js",
  "apps/web/public/desktop-shell.js",
  "apps/web/public/window-background.js",
  "apps/web/public/window-background.css",
  "apps/web/public/electron-refresh-lifecycle.js",
  "apps/web/public/local-refresh-pause.js",
  "apps/web/public/electron-settings.css",
  "apps/web/public/electron-settings.html",
  "apps/web/public/electron-settings.js",
  "apps/web/public/electron-tray-popup.css",
  "apps/web/public/electron-tray-popup.html",
  "apps/web/public/electron-tray-popup.js",
  "apps/web/public/electron-tray-preferences.js",
  "apps/web/public/electron-tray-settings.js",
  "apps/web/public/i18n.generated.js",
  "apps/web/public/icon-panel-left.svg",
  "apps/web/public/icon-refresh-cw.svg",
  "apps/web/public/icon-settings.svg",
  "apps/web/public/codex-color.svg",
  "apps/web/public/index.html",
  "apps/web/public/install-cta.js",
  "apps/web/public/lib.js",
  "apps/web/public/localization.js",
  "apps/web/public/model-catalog.generated.js",
  "apps/web/public/model-performance.css",
  "apps/web/public/model-performance.js",
  "apps/web/public/model-visuals.js",
  "apps/web/public/navigation.js",
  "apps/web/public/reporting-period.js",
  "apps/web/public/styles.css",
  "apps/web/public/usage-simple.css",
  "apps/web/public/telemetry-envelope.js",
  "apps/web/public/telemetry-shared.generated.js",
  "apps/web/public/app-icon.png",
  "apps/web/public/app-icon.svg",
  "apps/web/public/tray-icon.png",
  "apps/web/public/tray-icon.svg",
  "apps/web/public/ui-format.js",
  "apps/web/public/work-usage-view.js",
  "apps/web/public/x-reader.js",
  "apps/web/public/x-reader-integration.js",
  "apps/web/public/x-reader.css",
  "apps/web/public/vendor/hls.light.min.js",
  "apps/web/public/vendor/hls.js.LICENSE",
]);

export const SURFACE_MANIFEST = Object.freeze({
  schemaVersion: SURFACE_MANIFEST_SCHEMA,
  surfaces: Object.freeze({
    "local-companion": SHARED_WEB_FILES,
    "electron-runtime": SHARED_WEB_FILES,
  }),
});
