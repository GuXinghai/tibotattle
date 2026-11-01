---
title: Dashboard setup copy and native folder picker
date: 2026-11-02
type: receipt
status: verified
source_commit: 4004cff4
---

# Result and boundary

The "Codex folder not found" setup entry now opens the native Codex folder
picker directly in Electron, and its details copy was shortened in every
shipped locale. The changes were verified in the development-package renderer
against the isolated real-data profile. The live index was not used by this UI
check.

# Setup copy

The details dialog previously included a hidden "Ready" badge in its title and
repeated the missing-folder explanation in the title, summary, first check and
note. The visible heading now supplies the title, and the three locales use the
shortened structure:

- summary: `请在设置中选择现有的 Codex 文件夹，然后再次检查。`
- checks: `未找到 Codex 文件夹` / `可以保存应用数据` / `没有已完成的 Codex 任务`
- note: `准备好后点击“再次检查”。检查不会读取日志或上传数据。`

The canonical catalog is `packages/i18n/index.js`; the browser mirror was
regenerated with `npm run i18n:browser:generate`. English and Spanish use the
same shortened structure.

# Native folder picker

When Electron reports `codex_home_missing` or `codex_home_unreadable`, clicking
the setup row now invokes the reviewed `chooseCodexHome` bridge instead of
opening another details dialog. After the picker returns, the dashboard runs
the ordinary setup recheck. Browser mode and other setup problems retain the
details dialog because they have no native bridge action.

# Verification

- `node --test apps/web/test/localization-copy.test.mjs
  apps/web/test/i18n-browser-parity.test.mjs
  apps/web/test/overview-detail-links.test.mjs
  apps/web/test/app-refresh-notice.test.mjs`: 15 passed.
- `npm run i18n:browser:check`: passed.
- `npm run product:ui:test`: 896 passed.
- `npm run docs:check` and `npm run test:preflight`: passed.
- Packaged development candidate, source revision
  `4004cff47c0e8fb07901eecf95f98dae3ead3605`:
  executable SHA-256
  `235e16d895a87d5b09db7e4e85be23c25d50c7fd0e948a53632c27ed38a1b56b`;
  ASAR SHA-256
  `55c88b40ec2ece98ec94dae59d1648bc13b1031ae91f30986184452e9c4a2af4`.
- The packaged Electron renderer was inspected through its loopback-only
  DevTools endpoint. Clicking the missing-folder setup row left the details
  dialog closed and invoked the native picker path. The shortened title,
  summary, checks and note rendered as above. The notice popover remained fully
  inside the 1180x822 viewport (`left: 16`, `right: 436`).

# Boundary

This proves the development-package renderer, shortened copy and native picker
dispatch. It does not qualify a signed installed stable candidate, release,
updater or deployment. The isolated development profile still has an empty
Codex home, so the setup state is expected; the live v11 index was not changed.
