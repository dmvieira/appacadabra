/**
 * withIosShareExtension
 *
 * Adds a native iOS Share Extension target to the prebuilt Xcode project so
 * Appacadabra shows up as a destination in the iOS share sheet (text, URLs,
 * files). The Swift sources, Info.plist and entitlements live under
 * `modules/share-intent/ios/ShareExtension/` and are the canonical source of
 * truth — this plugin only copies them into the generated `ios/` tree and
 * wires them into `project.pbxproj` on `expo prebuild --platform ios`.
 *
 * Why a config plugin instead of an Expo module:
 *   Expo modules cannot declare additional iOS application-extension targets
 *   (the modules autolinking framework only knows how to vend libraries for
 *   the main app target). So we own the Swift, and this plugin links it.
 */

const { withDangerousMod, withXcodeProject } = require('@expo/config-plugins');
const fs = require('fs-extra');
const path = require('path');

const EXTENSION_TARGET_NAME = 'AppacadabraShareExtension';
const EXTENSION_BUNDLE_SUFFIX = 'ShareExtension';
const APP_GROUP = 'group.ai.appacadabra.app';
const SOURCE_DIR_FROM_PROJECT_ROOT = path.join(
  'modules',
  'share-intent',
  'ios',
  'ShareExtension',
);
const SWIFT_FILES = ['ShareViewController.swift'];
const PLIST_FILE = 'Info.plist';
const ENTITLEMENTS_FILE = 'ShareExtension.entitlements';

/**
 * Step 1: copy the owned ShareExtension sources into the prebuilt ios/ tree so
 * the Xcode project (and CocoaPods, if it later needs them) can see them at
 * stable paths relative to `ios/`.
 */
const withShareExtensionSources = (config) => {
  return withDangerousMod(config, [
    'ios',
    async (innerConfig) => {
      const projectRoot = innerConfig.modRequest.projectRoot;
      const platformRoot = innerConfig.modRequest.platformProjectRoot;
      const sourceDir = path.join(projectRoot, SOURCE_DIR_FROM_PROJECT_ROOT);
      const destDir = path.join(platformRoot, EXTENSION_TARGET_NAME);

      if (!(await fs.pathExists(sourceDir))) {
        console.warn(
          `[withIosShareExtension] Source directory not found: ${sourceDir}`,
        );
        return innerConfig;
      }

      await fs.ensureDir(destDir);
      for (const fileName of [...SWIFT_FILES, PLIST_FILE, ENTITLEMENTS_FILE]) {
        const src = path.join(sourceDir, fileName);
        const dst = path.join(destDir, fileName);
        if (await fs.pathExists(src)) {
          await fs.copy(src, dst, { overwrite: true });
          console.log(
            `[withIosShareExtension] Copied ${fileName} -> ${EXTENSION_TARGET_NAME}/`,
          );
        } else {
          console.warn(`[withIosShareExtension] Missing source: ${src}`);
        }
      }

      return innerConfig;
    },
  ]);
};

/**
 * Step 2: register the new target in project.pbxproj.
 *
 * Idempotency: we no-op if a PBXNativeTarget with our name already exists.
 * This matters because `expo prebuild` (without --clean) re-runs plugins on an
 * existing pbxproj.
 */
const withShareExtensionTarget = (config) => {
  return withXcodeProject(config, (innerConfig) => {
    const xcode = innerConfig.modResults;
    const mainBundleId =
      innerConfig.ios?.bundleIdentifier ?? 'ai.appacadabra.app';
    const extensionBundleId = `${mainBundleId}.${EXTENSION_BUNDLE_SUFFIX}`;

    // Idempotency check
    const nativeTargets = xcode.pbxNativeTargetSection();
    for (const key of Object.keys(nativeTargets)) {
      const value = nativeTargets[key];
      if (
        value &&
        typeof value === 'object' &&
        'name' in value &&
        typeof value.name === 'string' &&
        value.name.replace(/"/g, '') === EXTENSION_TARGET_NAME
      ) {
        console.log(
          `[withIosShareExtension] Target ${EXTENSION_TARGET_NAME} already present, skipping`,
        );
        return innerConfig;
      }
    }

    const target = xcode.addTarget(
      EXTENSION_TARGET_NAME,
      'app_extension',
      EXTENSION_TARGET_NAME,
      extensionBundleId,
    );

    const pbxGroup = xcode.addPbxGroup(
      [],
      EXTENSION_TARGET_NAME,
      EXTENSION_TARGET_NAME,
    );
    const projectSection = xcode.getFirstProject();
    const mainGroupKey = projectSection.firstProject.mainGroup;
    xcode.addToPbxGroup({ uuid: pbxGroup.uuid }, mainGroupKey);

    xcode.addBuildPhase(
      [],
      'PBXSourcesBuildPhase',
      'Sources',
      target.uuid,
    );
    xcode.addBuildPhase(
      [],
      'PBXResourcesBuildPhase',
      'Resources',
      target.uuid,
    );
    xcode.addBuildPhase(
      [],
      'PBXFrameworksBuildPhase',
      'Frameworks',
      target.uuid,
    );

    for (const fileName of SWIFT_FILES) {
      xcode.addSourceFile(
        `${EXTENSION_TARGET_NAME}/${fileName}`,
        { target: target.uuid },
        pbxGroup.uuid,
      );
    }

    xcode.addFile(
      `${EXTENSION_TARGET_NAME}/${PLIST_FILE}`,
      pbxGroup.uuid,
      { target: undefined, lastKnownFileType: 'text.plist.xml' },
    );
    xcode.addFile(
      `${EXTENSION_TARGET_NAME}/${ENTITLEMENTS_FILE}`,
      pbxGroup.uuid,
      { target: undefined, lastKnownFileType: 'text.plist.entitlements' },
    );

    const pbxNativeTargetSection = xcode.hash.project.objects.PBXNativeTarget;
    const nativeTargetObj = pbxNativeTargetSection[target.uuid];
    if (!nativeTargetObj || typeof nativeTargetObj !== 'object') {
      return innerConfig;
    }
    const buildConfigListKey = nativeTargetObj.buildConfigurationList;
    if (!buildConfigListKey) {
      return innerConfig;
    }

    const configLists = xcode.hash.project.objects.XCConfigurationList;
    const configList = configLists[buildConfigListKey];
    if (!configList || typeof configList !== 'object') {
      return innerConfig;
    }

    const buildConfigs = configList.buildConfigurations;
    if (!buildConfigs) {
      return innerConfig;
    }

    const xcBuildConfigurations =
      xcode.hash.project.objects.XCBuildConfiguration;
    const iosDeploymentTarget = '15.1';
    const swiftVersion = '5.0';

    for (const { value: cfgKey } of buildConfigs) {
      const cfg = xcBuildConfigurations[cfgKey];
      if (!cfg || typeof cfg !== 'object') continue;
      const settings = cfg.buildSettings;
      if (!settings) continue;

      settings.INFOPLIST_FILE = `"${EXTENSION_TARGET_NAME}/${PLIST_FILE}"`;
      settings.CODE_SIGN_ENTITLEMENTS = `"${EXTENSION_TARGET_NAME}/${ENTITLEMENTS_FILE}"`;
      settings.PRODUCT_BUNDLE_IDENTIFIER = `"${extensionBundleId}"`;
      settings.PRODUCT_NAME = `"${EXTENSION_TARGET_NAME}"`;
      settings.IPHONEOS_DEPLOYMENT_TARGET = iosDeploymentTarget;
      settings.SWIFT_VERSION = swiftVersion;
      settings.TARGETED_DEVICE_FAMILY = '"1,2"';
      settings.SKIP_INSTALL = 'YES';
      settings.CODE_SIGN_STYLE = 'Automatic';
      settings.LD_RUNPATH_SEARCH_PATHS =
        '"$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"';
      settings.GENERATE_INFOPLIST_FILE = 'NO';
      settings.MARKETING_VERSION = '$(MARKETING_VERSION)';
      settings.CURRENT_PROJECT_VERSION = '$(CURRENT_PROJECT_VERSION)';
    }

    console.log(
      `[withIosShareExtension] Registered target ${EXTENSION_TARGET_NAME} (bundle id ${extensionBundleId})`,
    );

    void APP_GROUP;

    return innerConfig;
  });
};

const withIosShareExtension = (config) => {
  config = withShareExtensionSources(config);
  config = withShareExtensionTarget(config);
  return config;
};

module.exports = withIosShareExtension;
