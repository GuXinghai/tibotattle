import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { convertDesktopCalculationCopy } from "./lib/desktop-calculation-migration.mjs";

export function parseDesktopCalculationMigrationArguments(args) {
  const names = new Map([
    ["--source-state-directory", "sourceStateDirectory"], ["--target-state-directory", "targetStateDirectory"],
    ["--source-settings-directory", "sourceSettingsDirectory"], ["--target-settings-directory", "targetSettingsDirectory"],
  ]);
  const value = {};
  for (let i = 0; i < args.length; i += 2) {
    const key = names.get(args[i]);
    if (!key || Object.hasOwn(value, key) || typeof args[i + 1] !== "string" || args[i + 1].startsWith("--")) {
      throw Object.assign(new Error("Explicit source and target directories are required"), { code: "DESKTOP_CALCULATION_MIGRATION_ARGUMENTS" });
    }
    value[key] = args[i + 1];
  }
  if (Object.keys(value).length !== names.size) {
    throw Object.assign(new Error("Explicit source and target directories are required"), { code: "DESKTOP_CALCULATION_MIGRATION_ARGUMENTS" });
  }
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await convertDesktopCalculationCopy(parseDesktopCalculationMigrationArguments(process.argv.slice(2))))); }
  catch (error) {
    console.error(JSON.stringify({ status: "refused", code: typeof error?.code === "string"
      && /^DESKTOP_CALCULATION_MIGRATION_[A-Z_]+$/u.test(error.code) ? error.code : "DESKTOP_CALCULATION_MIGRATION_UNAVAILABLE" }));
    process.exitCode = 1;
  }
}
