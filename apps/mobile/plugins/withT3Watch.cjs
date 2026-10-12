"use strict";

// Adds the T3 Watch single-target watchOS app to the generated iOS project and
// embeds it in the iPhone app. Watch sources stay outside apps/mobile/ios
// (prebuild --clean deletes it) and are referenced by relative path, as is the
// optional local Swift package linked into the watch target.
//
// Idempotent: the target, embed phase, group, product and package reference are
// found by name/path and reused, and every object this plugin owns gets a UUID
// derived from the target name, so repeated prebuilds (clean or incremental)
// rewrite the same objects instead of adding new ones.
//
// DEVELOPMENT_TEAM is left unset, like expo-sharing's extension: Expo's
// prebuild team mod runs before this one, and `expo run:ios` applies the
// selected team to every native target when it signs.

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { withDangerousMod, withXcodeProject } = require("expo/config-plugins");

const EMBED_PHASE_NAME = "Embed Watch Content";

function resolveOptions(config, options) {
  const iosBundleIdentifier = config.ios?.bundleIdentifier;
  if (!iosBundleIdentifier) {
    throw new Error("withT3Watch requires ios.bundleIdentifier.");
  }
  return {
    targetName: options.targetName ?? "T3Watch",
    sourcesDir: options.sourcesDir ?? "../watch/T3Watch",
    packageDir:
      options.packageDir === undefined ? "../../packages/watch-native" : options.packageDir,
    packageProduct: options.packageProduct ?? "T3WatchKit",
    bundleIdentifier: options.bundleIdentifier ?? `${iosBundleIdentifier}.watchkitapp`,
    companionBundleIdentifier: iosBundleIdentifier,
    deploymentTarget: options.deploymentTarget ?? "26.0",
    groupIdentifier: options.groupIdentifier ?? null,
    swiftVersion: options.swiftVersion ?? null,
    strictConcurrency: options.strictConcurrency ?? "complete",
    displayName: options.displayName ?? config.name,
    marketingVersion: config.ios?.version ?? config.version ?? "1.0",
    buildNumber: config.ios?.buildNumber ?? "1",
  };
}

// pbxproj values: quote anything outside the always-safe bare character set.
function q(value) {
  const text = String(value);
  return /^[A-Za-z0-9_./]+$/.test(text) ? text : JSON.stringify(text);
}

function unq(value) {
  return typeof value === "string" ? value.replace(/^"(.*)"$/, "$1") : value;
}

function entries(section) {
  return Object.entries(section ?? {}).filter(([key]) => !key.endsWith("_comment"));
}

function section(objects, isa) {
  objects[isa] ??= {};
  return objects[isa];
}

function put(objects, isa, uuid, value, comment) {
  const target = section(objects, isa);
  target[uuid] = { isa, ...value };
  if (comment) target[`${uuid}_comment`] = comment;
}

function remove(objects, uuid) {
  for (const sectionObjects of Object.values(objects)) {
    if (sectionObjects && typeof sectionObjects === "object" && uuid in sectionObjects) {
      delete sectionObjects[uuid];
      delete sectionObjects[`${uuid}_comment`];
    }
  }
}

function lookup(objects, uuid) {
  for (const sectionObjects of Object.values(objects)) {
    if (sectionObjects && typeof sectionObjects === "object" && uuid in sectionObjects) {
      return sectionObjects[uuid];
    }
  }
  return null;
}

function ref(uuid, comment) {
  return { value: uuid, comment };
}

function listSourceFiles(sourcesRoot) {
  const swiftFiles = [];
  let assetCatalog = null;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const absolute = path.join(dir, entry.name);
      const relative = path.relative(sourcesRoot, absolute).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name === "Assets.xcassets" && dir === sourcesRoot) {
          assetCatalog = relative;
        } else if (!entry.name.endsWith(".xcassets")) {
          walk(absolute);
        }
      } else if (entry.name.endsWith(".swift")) {
        swiftFiles.push(relative);
      }
    }
  };
  walk(sourcesRoot);
  return { swiftFiles: swiftFiles.sort(), assetCatalog };
}

function buildSettings(opts, mainSwiftVersion, { assetCatalogRoot, debug }) {
  const hasAsset = (name) => assetCatalogRoot && fs.existsSync(path.join(assetCatalogRoot, name));
  const settings = {
    ...(hasAsset("AppIcon.appiconset") ? { ASSETCATALOG_COMPILER_APPICON_NAME: "AppIcon" } : {}),
    ...(hasAsset("AccentColor.colorset")
      ? { ASSETCATALOG_COMPILER_GLOBAL_ACCENT_COLOR_NAME: "AccentColor" }
      : {}),
    ...(opts.groupIdentifier
      ? { CODE_SIGN_ENTITLEMENTS: q(`${opts.targetName}/${opts.targetName}.entitlements`) }
      : {}),
    CODE_SIGN_STYLE: "Automatic",
    CURRENT_PROJECT_VERSION: q(opts.buildNumber),
    ENABLE_PREVIEWS: "YES",
    GENERATE_INFOPLIST_FILE: "YES",
    // Merged with the generated keys; carries what INFOPLIST_KEY_* cannot express.
    INFOPLIST_FILE: q(`${opts.targetName}/Info.plist`),
    INFOPLIST_KEY_CFBundleDisplayName: q(opts.displayName),
    INFOPLIST_KEY_UISupportedInterfaceOrientations: q(
      "UIInterfaceOrientationPortrait UIInterfaceOrientationPortraitUpsideDown",
    ),
    INFOPLIST_KEY_WKApplication: "YES",
    INFOPLIST_KEY_WKCompanionAppBundleIdentifier: q(opts.companionBundleIdentifier),
    INFOPLIST_KEY_WKWatchOnly: "NO",
    LD_RUNPATH_SEARCH_PATHS: [q("$(inherited)"), q("@executable_path/Frameworks")],
    MARKETING_VERSION: q(opts.marketingVersion),
    PRODUCT_BUNDLE_IDENTIFIER: q(opts.bundleIdentifier),
    PRODUCT_NAME: q("$(TARGET_NAME)"),
    SDKROOT: "watchos",
    SKIP_INSTALL: "YES",
    SUPPORTED_PLATFORMS: q("watchos watchsimulator"),
    SWIFT_EMIT_LOC_STRINGS: "YES",
    SWIFT_STRICT_CONCURRENCY: q(opts.strictConcurrency),
    SWIFT_VERSION: q(opts.swiftVersion ?? mainSwiftVersion ?? "5.0"),
    TARGETED_DEVICE_FAMILY: "4",
    WATCHOS_DEPLOYMENT_TARGET: q(opts.deploymentTarget),
  };
  if (debug) {
    settings.SWIFT_ACTIVE_COMPILATION_CONDITIONS = q("DEBUG $(inherited)");
    settings.SWIFT_OPTIMIZATION_LEVEL = q("-Onone");
  } else {
    settings.SWIFT_COMPILATION_MODE = "wholemodule";
  }
  return settings;
}

function applyWatchTarget(project, opts, { projectName, platformProjectRoot, projectRoot }) {
  const objects = project.hash.project.objects;
  const id = (role) =>
    crypto
      .createHash("sha1")
      .update(`withT3Watch:${opts.targetName}:${role}`)
      .digest("hex")
      .slice(0, 24)
      .toUpperCase();

  const [projectUuid, pbxProject] = entries(objects.PBXProject)[0];
  const nativeTargets = section(objects, "PBXNativeTarget");
  const mainTargetEntry = entries(nativeTargets).find(([, t]) => unq(t.name) === projectName);
  if (!mainTargetEntry) {
    throw new Error(`withT3Watch: iOS app target "${projectName}" not found.`);
  }
  const mainTarget = mainTargetEntry[1];

  const sourcesRoot = path.resolve(projectRoot, opts.sourcesDir);
  const { swiftFiles, assetCatalog } = fs.existsSync(sourcesRoot)
    ? listSourceFiles(sourcesRoot)
    : { swiftFiles: [], assetCatalog: null };
  if (swiftFiles.length === 0) {
    throw new Error(`withT3Watch: no Swift sources found under ${sourcesRoot}.`);
  }
  let packageRoot = null;
  if (opts.packageDir) {
    packageRoot = path.resolve(projectRoot, opts.packageDir);
    if (!fs.existsSync(path.join(packageRoot, "Package.swift"))) {
      throw new Error(`withT3Watch: no Package.swift found under ${packageRoot}.`);
    }
  }

  const productName = `${opts.targetName}.app`;
  const productComment = productName;
  const fromIos = (absolute) =>
    path.relative(platformProjectRoot, absolute).split(path.sep).join("/");

  // Existing target (from a previous run or an older plugin version): reuse its
  // UUID and drop everything it owns so the objects below replace them.
  const existingTarget = entries(nativeTargets).find(([, t]) => unq(t.name) === opts.targetName);
  const targetUuid = existingTarget?.[0] ?? id("target");
  if (existingTarget) {
    const old = existingTarget[1];
    for (const phase of old.buildPhases ?? []) {
      for (const file of lookup(objects, phase.value)?.files ?? []) remove(objects, file.value);
      remove(objects, phase.value);
    }
    for (const dep of old.packageProductDependencies ?? []) remove(objects, dep.value);
    const oldList = lookup(objects, old.buildConfigurationList);
    for (const configuration of oldList?.buildConfigurations ?? [])
      remove(objects, configuration.value);
    remove(objects, old.buildConfigurationList);
  }

  // Product reference in the Products group.
  const productsGroup = lookup(objects, pbxProject.productRefGroup);
  const existingProduct = (productsGroup?.children ?? []).find(
    (child) => unq(lookup(objects, child.value)?.path) === productName,
  );
  const productRefUuid = existingProduct?.value ?? id("product");
  put(
    objects,
    "PBXFileReference",
    productRefUuid,
    {
      explicitFileType: "wrapper.application",
      includeInIndex: 0,
      path: q(productName),
      sourceTree: "BUILT_PRODUCTS_DIR",
    },
    productComment,
  );
  if (productsGroup && !existingProduct) {
    productsGroup.children.push(ref(productRefUuid, productComment));
  }

  // Source group, pointing outside ios/ at the source-controlled watch sources.
  const mainGroup = lookup(objects, pbxProject.mainGroup);
  const existingGroupRef = mainGroup.children.find(
    (child) => unq(lookup(objects, child.value)?.name) === opts.targetName,
  );
  const groupUuid = existingGroupRef?.value ?? id("group");
  for (const child of lookup(objects, groupUuid)?.children ?? []) remove(objects, child.value);

  const sourceBuildFiles = [];
  const groupChildren = [];
  for (const file of swiftFiles) {
    const fileRefUuid = id(`file:${file}`);
    const buildFileUuid = id(`build:${file}`);
    const name = path.posix.basename(file);
    put(
      objects,
      "PBXFileReference",
      fileRefUuid,
      {
        lastKnownFileType: "sourcecode.swift",
        name: q(name),
        path: q(file),
        sourceTree: q("<group>"),
      },
      name,
    );
    put(
      objects,
      "PBXBuildFile",
      buildFileUuid,
      { fileRef: fileRefUuid, fileRef_comment: name },
      `${name} in Sources`,
    );
    groupChildren.push(ref(fileRefUuid, name));
    sourceBuildFiles.push(ref(buildFileUuid, `${name} in Sources`));
  }
  const resourceBuildFiles = [];
  if (assetCatalog) {
    const fileRefUuid = id(`file:${assetCatalog}`);
    const buildFileUuid = id(`build:${assetCatalog}`);
    put(
      objects,
      "PBXFileReference",
      fileRefUuid,
      { lastKnownFileType: "folder.assetcatalog", path: q(assetCatalog), sourceTree: q("<group>") },
      assetCatalog,
    );
    put(
      objects,
      "PBXBuildFile",
      buildFileUuid,
      { fileRef: fileRefUuid, fileRef_comment: assetCatalog },
      `${assetCatalog} in Resources`,
    );
    groupChildren.push(ref(fileRefUuid, assetCatalog));
    resourceBuildFiles.push(ref(buildFileUuid, `${assetCatalog} in Resources`));
  }
  put(
    objects,
    "PBXGroup",
    groupUuid,
    {
      children: groupChildren,
      name: q(opts.targetName),
      path: q(fromIos(sourcesRoot)),
      sourceTree: q("<group>"),
    },
    opts.targetName,
  );
  if (!existingGroupRef) mainGroup.children.push(ref(groupUuid, opts.targetName));

  // Local Swift package linked into the watch target.
  const frameworkBuildFiles = [];
  const packageProductDependencies = [];
  if (packageRoot) {
    const relativePath = fromIos(packageRoot);
    const existingPackage = entries(objects.XCLocalSwiftPackageReference).find(
      ([, p]) => unq(p.relativePath) === relativePath,
    );
    const packageUuid = existingPackage?.[0] ?? id("package");
    const packageComment = `XCLocalSwiftPackageReference "${relativePath}"`;
    put(
      objects,
      "XCLocalSwiftPackageReference",
      packageUuid,
      { relativePath: q(relativePath) },
      packageComment,
    );
    pbxProject.packageReferences ??= [];
    if (!pbxProject.packageReferences.some((p) => p.value === packageUuid)) {
      pbxProject.packageReferences.push(ref(packageUuid, packageComment));
    }
    const productDependencyUuid = id("package-product");
    put(
      objects,
      "XCSwiftPackageProductDependency",
      productDependencyUuid,
      {
        package: packageUuid,
        package_comment: packageComment,
        productName: q(opts.packageProduct),
      },
      opts.packageProduct,
    );
    const buildFileUuid = id("build:package-product");
    put(
      objects,
      "PBXBuildFile",
      buildFileUuid,
      { productRef: productDependencyUuid, productRef_comment: opts.packageProduct },
      `${opts.packageProduct} in Frameworks`,
    );
    packageProductDependencies.push(ref(productDependencyUuid, opts.packageProduct));
    frameworkBuildFiles.push(ref(buildFileUuid, `${opts.packageProduct} in Frameworks`));
  }

  // Build phases.
  const phase = (isa, role, name, files) => {
    const uuid = id(`phase:${role}`);
    put(
      objects,
      isa,
      uuid,
      { buildActionMask: 2147483647, files, runOnlyForDeploymentPostprocessing: 0 },
      name,
    );
    return ref(uuid, name);
  };
  const buildPhases = [
    phase("PBXSourcesBuildPhase", "sources", "Sources", sourceBuildFiles),
    phase("PBXFrameworksBuildPhase", "frameworks", "Frameworks", frameworkBuildFiles),
    phase("PBXResourcesBuildPhase", "resources", "Resources", resourceBuildFiles),
  ];

  // Build configurations, mirroring the iOS app's configuration names.
  const mainList = lookup(objects, mainTarget.buildConfigurationList);
  const mainConfigurations = (mainList?.buildConfigurations ?? []).map((c) =>
    lookup(objects, c.value),
  );
  const mainSwiftVersion = unq(
    mainConfigurations.find((c) => c?.buildSettings?.SWIFT_VERSION)?.buildSettings.SWIFT_VERSION,
  );
  const assetCatalogRoot = assetCatalog ? path.join(sourcesRoot, assetCatalog) : null;
  const configurationRefs = mainConfigurations.map((mainConfiguration) => {
    const name = unq(mainConfiguration.name);
    const uuid = id(`configuration:${name}`);
    put(
      objects,
      "XCBuildConfiguration",
      uuid,
      {
        buildSettings: buildSettings(opts, mainSwiftVersion, {
          assetCatalogRoot,
          debug: name === "Debug",
        }),
        name: q(name),
      },
      name,
    );
    return ref(uuid, name);
  });
  const configurationListUuid = id("configuration-list");
  const configurationListComment = `Build configuration list for PBXNativeTarget "${opts.targetName}"`;
  put(
    objects,
    "XCConfigurationList",
    configurationListUuid,
    {
      buildConfigurations: configurationRefs,
      defaultConfigurationIsVisible: 0,
      defaultConfigurationName: mainList?.defaultConfigurationName ?? "Release",
    },
    configurationListComment,
  );

  put(
    objects,
    "PBXNativeTarget",
    targetUuid,
    {
      buildConfigurationList: configurationListUuid,
      buildConfigurationList_comment: configurationListComment,
      buildPhases,
      buildRules: [],
      dependencies: [],
      name: q(opts.targetName),
      packageProductDependencies,
      productName: q(opts.targetName),
      productReference: productRefUuid,
      productReference_comment: productComment,
      productType: q("com.apple.product-type.application"),
    },
    opts.targetName,
  );
  if (!pbxProject.targets.some((t) => t.value === targetUuid)) {
    pbxProject.targets.push(ref(targetUuid, opts.targetName));
  }
  pbxProject.attributes.TargetAttributes ??= {};
  pbxProject.attributes.TargetAttributes[targetUuid] = {
    CreatedOnToolsVersion: "26.0",
    ProvisioningStyle: "Automatic",
  };

  // iOS app: depend on and embed the watch app.
  mainTarget.dependencies ??= [];
  const hasDependency = mainTarget.dependencies.some(
    (dep) => lookup(objects, dep.value)?.target === targetUuid,
  );
  if (!hasDependency) {
    const proxyUuid = id("container-proxy");
    const dependencyUuid = id("target-dependency");
    put(
      objects,
      "PBXContainerItemProxy",
      proxyUuid,
      {
        containerPortal: projectUuid,
        containerPortal_comment: "Project object",
        proxyType: 1,
        remoteGlobalIDString: targetUuid,
        remoteInfo: q(opts.targetName),
      },
      "PBXContainerItemProxy",
    );
    put(
      objects,
      "PBXTargetDependency",
      dependencyUuid,
      {
        target: targetUuid,
        target_comment: opts.targetName,
        targetProxy: proxyUuid,
        targetProxy_comment: "PBXContainerItemProxy",
      },
      "PBXTargetDependency",
    );
    mainTarget.dependencies.push(ref(dependencyUuid, "PBXTargetDependency"));
  }

  const embedBuildFileUuid = id("build:embed");
  const embedComment = `${productName} in ${EMBED_PHASE_NAME}`;
  put(
    objects,
    "PBXBuildFile",
    embedBuildFileUuid,
    {
      fileRef: productRefUuid,
      fileRef_comment: productComment,
      settings: { ATTRIBUTES: ["RemoveHeadersOnCopy"] },
    },
    embedComment,
  );
  const existingEmbed = mainTarget.buildPhases.find(
    (p) => unq(lookup(objects, p.value)?.name) === EMBED_PHASE_NAME,
  );
  const embedPhaseUuid = existingEmbed?.value ?? id("phase:embed");
  const embedFiles = (lookup(objects, embedPhaseUuid)?.files ?? []).filter(
    (file) => file.value !== embedBuildFileUuid,
  );
  put(
    objects,
    "PBXCopyFilesBuildPhase",
    embedPhaseUuid,
    {
      buildActionMask: 2147483647,
      dstPath: q("$(CONTENTS_FOLDER_PATH)/Watch"),
      dstSubfolderSpec: 16,
      files: [...embedFiles, ref(embedBuildFileUuid, embedComment)],
      name: q(EMBED_PHASE_NAME),
      runOnlyForDeploymentPostprocessing: 0,
    },
    EMBED_PHASE_NAME,
  );
  if (!existingEmbed) mainTarget.buildPhases.push(ref(embedPhaseUuid, EMBED_PHASE_NAME));

  return { targetUuid, productName };
}

function schemeXml({ targetUuid, targetName, productName, projectName }) {
  const buildable = `<BuildableReference
               BuildableIdentifier = "primary"
               BlueprintIdentifier = "${targetUuid}"
               BuildableName = "${productName}"
               BlueprintName = "${targetName}"
               ReferencedContainer = "container:${projectName}.xcodeproj">
            </BuildableReference>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<Scheme
   LastUpgradeVersion = "2600"
   version = "1.7">
   <BuildAction
      parallelizeBuildables = "YES"
      buildImplicitDependencies = "YES">
      <BuildActionEntries>
         <BuildActionEntry
            buildForTesting = "YES"
            buildForRunning = "YES"
            buildForProfiling = "YES"
            buildForArchiving = "YES"
            buildForAnalyzing = "YES">
            ${buildable}
         </BuildActionEntry>
      </BuildActionEntries>
   </BuildAction>
   <LaunchAction
      buildConfiguration = "Debug"
      selectedDebuggerIdentifier = "Xcode.DebuggerFoundation.Debugger.LLDB"
      selectedLauncherIdentifier = "Xcode.DebuggerFoundation.Launcher.LLDB"
      launchStyle = "0"
      useCustomWorkingDirectory = "NO"
      ignoresPersistentStateOnLaunch = "NO"
      debugDocumentVersioning = "YES"
      debugServiceExtension = "internal"
      allowLocationSimulation = "YES">
      <BuildableProductRunnable
         runnableDebuggingMode = "0">
         ${buildable}
      </BuildableProductRunnable>
   </LaunchAction>
   <ArchiveAction
      buildConfiguration = "Release"
      revealArchiveInOrganizer = "YES">
   </ArchiveAction>
</Scheme>
`;
}

function withWatchXcodeProject(config, opts) {
  return withXcodeProject(config, (cfg) => {
    const { projectName, platformProjectRoot, projectRoot } = cfg.modRequest;
    const { targetUuid, productName } = applyWatchTarget(cfg.modResults, opts, {
      projectName,
      platformProjectRoot,
      projectRoot,
    });
    const schemesDir = path.join(
      platformProjectRoot,
      `${projectName}.xcodeproj`,
      "xcshareddata",
      "xcschemes",
    );
    fs.mkdirSync(schemesDir, { recursive: true });
    fs.writeFileSync(
      path.join(schemesDir, `${opts.targetName}.xcscheme`),
      schemeXml({ targetUuid, targetName: opts.targetName, productName, projectName }),
    );
    return cfg;
  });
}

function withWatchTargetFiles(config, opts) {
  return withDangerousMod(config, [
    "ios",
    (cfg) => {
      const dir = path.join(cfg.modRequest.platformProjectRoot, opts.targetName);
      fs.mkdirSync(dir, { recursive: true });
      // Users point the Watch at `npx t3` servers on their LAN over plain
      // HTTP, the same reason the iPhone app allows arbitrary loads.
      fs.writeFileSync(
        path.join(dir, "Info.plist"),
        `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSMicrophoneUsageDescription</key>
  <string>Record instructions to transcribe on your T3 server.</string>
  <key>NSAppTransportSecurity</key>
  <dict>
    <key>NSAllowsArbitraryLoads</key>
    <true/>
  </dict>
</dict>
</plist>
`,
      );
      if (opts.groupIdentifier) {
        fs.writeFileSync(
          path.join(dir, `${opts.targetName}.entitlements`),
          `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>com.apple.security.application-groups</key>
  <array>
    <string>${opts.groupIdentifier}</string>
  </array>
</dict>
</plist>
`,
        );
      }
      return cfg;
    },
  ]);
}

// EAS credentials only provision bundle IDs it is told about (same mechanism
// expo-widgets uses for its extension).
function withWatchEasConfig(config, opts) {
  const ios = config.extra?.eas?.build?.experimental?.ios ?? {};
  const appExtensions = (ios.appExtensions ?? []).filter(
    (ext) => ext.targetName !== opts.targetName,
  );
  appExtensions.push({
    targetName: opts.targetName,
    bundleIdentifier: opts.bundleIdentifier,
    ...(opts.groupIdentifier
      ? { entitlements: { "com.apple.security.application-groups": [opts.groupIdentifier] } }
      : {}),
  });
  config.extra = {
    ...config.extra,
    eas: {
      ...config.extra?.eas,
      build: {
        ...config.extra?.eas?.build,
        experimental: {
          ...config.extra?.eas?.build?.experimental,
          ios: { ...ios, appExtensions },
        },
      },
    },
  };
  return config;
}

module.exports = function withT3Watch(config, options = {}) {
  const opts = resolveOptions(config, options);
  return withWatchXcodeProject(withWatchTargetFiles(withWatchEasConfig(config, opts), opts), opts);
};
