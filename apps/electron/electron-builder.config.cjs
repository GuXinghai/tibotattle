const path = require("node:path");

const repositoryRoot = path.resolve(__dirname, "../..");
const requestedTarget = process.env.TIBOTATTLE_ELECTRON_TARGET ?? "win32-x64";
const targetAliases = {
  windows: "win32-x64",
  win: "win32-x64",
  win32: "win32-x64",
  "win32-x64": "win32-x64",
};
const target = Object.hasOwn(targetAliases, requestedTarget) ? targetAliases[requestedTarget] : null;
if (!target) {
  throw new Error("TIBOTATTLE_ELECTRON_TARGET must be win32-x64");
}
const targetSpec = { platform: "win32", architecture: "x64" };
const appDirectory = path.join(
  repositoryRoot,
  ".release-build/electron-dev",
  target,
  "app",
);
const artifactDirectory = path.join(
  repositoryRoot,
  ".release-build/electron-dev",
  target,
  "artifacts",
);

/**
 * Development-only Electron configuration. `build-electron-app.mjs` creates
 * this app directory first; electron-builder is intentionally a later explicit
 * target step. Set TIBOTATTLE_ELECTRON_TARGET to the canonical Windows target
 * before invoking electron-builder. This development config does not register
 * the production custom URL scheme, which keeps side-by-side test packages
 * from stealing native app callbacks.
 */
module.exports = {
  appId: "com.adamallcock.tibotattle.electron.dev",
  productName: "TiboTattle Dev",
  artifactName: "TiboTattle-Dev-${version}-${os}-${arch}.${ext}",
  icon: path.join(repositoryRoot, "apps/web/public/tibotattle-icon.png"),
  directories: {
    app: appDirectory,
    output: artifactDirectory,
  },
  // These patterns run against the exact staged app directory, never the
  // repository checkout. Keep the manually captured native/runtime closure.
  files: [
    {
      from: ".",
      to: ".",
      filter: [
        "package.json",
        "electron-runtime-manifest.json",
        "apps/electron/**",
        "apps/local/**",
        "apps/web/public/**",
        "config/**",
        "contracts/**",
        "native/windows-filesystem/build/Release/windows_filesystem.node",
        "native/windows-filesystem/build/Release/windows_filesystem.node.manifest.json",
        "schemas/**",
        "src/**",
        "generated/**",
      ],
    },
    {
      from: "node_modules",
      to: "node_modules",
      filter: ["**/*"],
    },
  ],
  // Smart unpacking would expand the entire @github/keytar package because
  // it contains a native prebuild. The reviewed artifact contract unpacks
  // only the exact Windows native files listed below.
  asar: { smartUnpack: false },
  // Only the reviewed Windows native runtime is unpacked. The Electron shell
  // and JavaScript companion remain in app.asar.
  asarUnpack: [
    "node_modules/@github/keytar/prebuilds/win32-x64/keytar.node",
    "native/windows-filesystem/build/Release/windows_filesystem.node",
  ],
  extraMetadata: {
    main: "apps/electron/main.js",
    name: "app-usagemonitor",
    productName: "TiboTattle Dev",
    desktopName: "com.adamallcock.tibotattle.electron.dev.desktop",
  },
  forceCodeSigning: false,
  // The staged app deliberately has no lockfile. Returning false from the
  // hook keeps electron-builder from walking the checkout's workspace
  // metadata while npmRebuild still makes its production-dependency phase
  // select this exact staged app directory.
  beforeBuild: () => false,
  npmRebuild: true,
  buildDependenciesFromSource: false,
  nodeGypRebuild: false,
  // `publish` is a provider configuration, not the CLI publish policy. A
  // string here is interpreted as a provider name during distribution builds
  // (so `"never"` would try to load electron-publisher-never). The packaging
  // entrypoint supplies `--publish never` explicitly.
  publish: null,
  win: {
    target: [{ target: "dir", arch: [targetSpec.architecture] }],
    signAndEditExecutable: false,
    signExecutable: false,
  },
};
