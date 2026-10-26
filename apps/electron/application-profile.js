import { readFile } from "node:fs/promises";
import { resolve, win32 } from "node:path";
import identity from "../../config/application-identity.cjs";
import { shellError } from "./errors.js";

const { APPLICATION_IDENTITY, APPLICATION_PROFILES, validateApplicationMetadata } = identity;

// Only packaged metadata selects an installed profile. Display names have no authority.
export async function readApplicationPackage({ app, readManifest = readFile } = {}) {
  if (app?.isPackaged !== true) return null;
  try {
    const root = app.getAppPath?.();
    if (typeof root !== "string" || root.length === 0) throw new Error();
    const bytes = await readManifest(resolve(root, "package.json"));
    if (!Buffer.isBuffer(bytes) || bytes.length > 1_048_576) throw new Error();
    const manifest = JSON.parse(bytes.toString("utf8"));
    if (manifest.name !== APPLICATION_IDENTITY.packageName
        || manifest.main !== "apps/electron/main.js") throw new Error();
    const selected = validateApplicationMetadata(manifest[APPLICATION_IDENTITY.metadataKey]);
    if (selected.profile === "preview") throw new Error();
    const hasDistribution = Object.hasOwn(manifest, APPLICATION_IDENTITY.distributionMetadataKey);
    if ((selected.profile === "stable") !== hasDistribution) throw new Error();
    return Object.freeze({ identity: selected, distribution: hasDistribution
      ? manifest[APPLICATION_IDENTITY.distributionMetadataKey] : null });
  } catch {
    throw shellError("electron_configuration_invalid");
  }
}

export function applicationProfilePaths({ appData, profile, platform = process.platform } = {}) {
  if (platform !== "win32" || !Object.hasOwn(APPLICATION_PROFILES, profile)
      || typeof appData !== "string" || !win32.isAbsolute(appData)
      || appData.includes("\0") || win32.normalize(appData) === win32.parse(appData).root
      || appData.split(/[\\/]/u).some(part => part === "." || part === "..")) {
    throw shellError("electron_configuration_invalid");
  }
  const userData = win32.join(appData, APPLICATION_IDENTITY.stateDirectoryName, "profiles", profile);
  return Object.freeze({ userData, sessionData: win32.join(userData, "chromium") });
}

// The trusted composition supplies protected directory preparation before ready.
export function pinApplicationProfilePaths({ app, appData, profile, platform, prepareDirectory } = {}) {
  if (app?.isReady?.() === true || typeof app?.setPath !== "function"
      || typeof prepareDirectory !== "function") throw shellError("electron_configuration_invalid");
  const paths = applicationProfilePaths({ appData: appData ?? app.getPath("appData"), profile, platform });
  prepareDirectory(paths.userData, "state");
  prepareDirectory(paths.sessionData, "session");
  app.setPath("userData", paths.userData);
  app.setPath("sessionData", paths.sessionData);
  return paths;
}
