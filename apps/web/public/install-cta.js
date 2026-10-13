// The install call-to-action. Release metadata arrives as document meta tags
// that the release-site build materializes, so every value shown here is
// checked against a fixed shape before it is displayed: an unverifiable or
// partially injected release renders as "unavailable" rather than as a
// half-filled download card.
//
// TiboTattle is Windows x64 only, so there is one installer slot and one
// architecture. Shared by the public site entry (community.js), where it is
// the primary call to action, and by the in-app dashboard entry (app.js),
// which uses the same card when the local companion is not yet reachable.

import { DEFAULT_LOCALE, translate } from "./localization.js";
import { getFormattingLocale } from "./ui-format.js";

const WINDOWS_ARCHITECTURE = "x64";

function defaultMessage(key, values = {}) {
  return translate(key, values, DEFAULT_LOCALE);
}

function configuredInstallerUrl(documentRef) {
  const raw = documentRef
    .querySelector('meta[name="usage-monitor-installer-url"]')
    ?.getAttribute("content")
    ?.trim();
  if (!raw) return null;
  try {
    const selected = new URL(raw);
    return selected.protocol === "https:"
      && !selected.username
      && !selected.password
      && !selected.port
      && !selected.search
      && !selected.hash
      && selected.pathname.toLowerCase().endsWith(".exe")
      ? selected.href
      : null;
  } catch {
    return null;
  }
}

function configuredInstallerMetadata(documentRef, name, pattern) {
  const value = documentRef
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  return value && pattern.test(value) ? value : null;
}

function configuredReleaseUrl(documentRef, name) {
  const raw = documentRef
    .querySelector(`meta[name="${name}"]`)
    ?.getAttribute("content")
    ?.trim();
  if (!raw) return null;
  try {
    const selected = new URL(raw);
    return selected.protocol === "https:"
      && !selected.username
      && !selected.password
      && !selected.port
      && !selected.search
      && !selected.hash
      ? selected.href
      : null;
  } catch {
    return null;
  }
}

export function configuredInstallerRelease(documentRef) {
  const installerUrl = configuredInstallerUrl(documentRef);
  const metadata = (name, pattern) => configuredInstallerMetadata(
    documentRef, name, pattern,
  );
  const version = metadata(
    "usage-monitor-installer-version",
    /^[0-9]+(?:\.[0-9]+){2,3}$/u,
  );
  const sha256 = metadata(
    "usage-monitor-installer-sha256",
    /^[a-f0-9]{64}$/u,
  );
  const byteText = metadata(
    "usage-monitor-installer-bytes",
    /^[1-9][0-9]{0,15}$/u,
  );
  const minimumWindows = metadata(
    "usage-monitor-minimum-windows",
    /^(?:10|11)(?:\.[0-9]{1,5}){0,2}$/u,
  );
  const architectureText = metadata(
    "usage-monitor-architectures",
    /^x64$/u,
  );
  const links = {
    releaseNotes: configuredReleaseUrl(
      documentRef,
      "usage-monitor-release-notes-url",
    ),
    privacy: configuredReleaseUrl(documentRef, "usage-monitor-privacy-url"),
    security: configuredReleaseUrl(documentRef, "usage-monitor-security-url"),
    support: configuredReleaseUrl(documentRef, "usage-monitor-support-url"),
  };
  const bytes = byteText === null ? null : Number(byteText);
  if (!installerUrl
      || !version
      || !sha256
      || !Number.isSafeInteger(bytes)
      || bytes <= 0
      || !minimumWindows
      || architectureText !== WINDOWS_ARCHITECTURE
      || Object.values(links).some((value) => value === null)) {
    return null;
  }
  if (new URL(installerUrl).pathname.split("/").at(-1)
      !== `TiboTattle-${version}-Windows-x64.exe`) return null;
  return {
    installerUrl,
    version,
    sha256,
    bytes,
    minimumWindows,
    links,
  };
}

/**
 * Show the compact assurance only when the download itself passed the closed
 * release-metadata contract. Detailed verification guidance lives in Docs.
 */
export function renderInstallerAssurance(documentRef, release) {
  const assurance = documentRef.querySelector("#download-assurance");
  if (!assurance) return null;
  assurance.hidden = !release;
  return release ?? null;
}

export function formatInstallerSize(bytes, {
  formatLocale = getFormattingLocale(),
  translateMessage = defaultMessage,
} = {}) {
  if (bytes < 1024 * 1024) {
    return translateMessage("installer.downloadKiB", {
      value: Math.ceil(bytes / 1024),
    });
  }
  const mebibytes = bytes / (1024 * 1024);
  return translateMessage("installer.downloadMiB", {
    value: new Intl.NumberFormat(formatLocale, {
      maximumFractionDigits: mebibytes >= 10 ? 0 : 1,
    }).format(mebibytes),
  });
}

export function renderInstallerJourney(documentRef, {
  compactDetails = false,
  showUnavailableAction = false,
  showReleaseLinks = true,
  formatLocale = getFormattingLocale(),
  translateMessage = defaultMessage,
} = {}) {
  const select = (selector) => documentRef.querySelector(selector);
  const release = configuredInstallerRelease(documentRef);
  const link = select("#installer-link");
  const details = select("#installer-details");
  const releaseLinks = select("#installer-links");
  const unavailable = select("#installer-unavailable");
  const unavailableAction = select("#installer-unavailable-action");
  if (release) {
    link.href = release.installerUrl;
    link.hidden = false;
    link.removeAttribute("aria-disabled");
    if (unavailableAction) unavailableAction.hidden = true;
    select("#installer-version").textContent = translateMessage(
      "installer.version",
      { version: release.version },
    );
    select("#installer-compatibility").textContent = translateMessage(
      compactDetails
        ? "installer.compatibilitySummary"
        : "installer.requiresWindows",
      {
        architecture: WINDOWS_ARCHITECTURE,
        version: release.minimumWindows,
      },
    );
    select("#installer-size").textContent = formatInstallerSize(release.bytes, {
      formatLocale,
      translateMessage,
    });
    select("#installer-sha256").textContent = translateMessage(
      "installer.sha256",
      { value: release.sha256 },
    );
    details.hidden = false;
    for (
      const [id, url] of [
        ["release-notes-link", release.links.releaseNotes],
        ["privacy-link", release.links.privacy],
        ["security-link", release.links.security],
        ["support-link", release.links.support],
      ]
    ) {
      const item = select(`#${id}`);
      if (showReleaseLinks) {
        item.href = url;
        item.hidden = false;
      } else {
        item.removeAttribute("href");
        item.hidden = true;
      }
    }
    releaseLinks.hidden = !showReleaseLinks;
    unavailable.hidden = true;
    return release;
  }
  link.removeAttribute("href");
  link.removeAttribute("aria-disabled");
  link.hidden = true;
  if (unavailableAction) unavailableAction.hidden = !showUnavailableAction;
  details.hidden = true;
  for (
    const id of [
      "installer-version",
      "installer-compatibility",
      "installer-size",
      "installer-sha256",
    ]
  ) {
    select(`#${id}`).textContent = "";
  }
  for (
    const id of [
      "release-notes-link",
      "privacy-link",
      "security-link",
      "support-link",
    ]
  ) {
    const item = select(`#${id}`);
    item.removeAttribute("href");
    item.hidden = true;
  }
  releaseLinks.hidden = true;
  unavailable.hidden = false;
  return null;
}
