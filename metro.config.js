// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Disable package exports resolution to suppress @react-native-firebase/app
// warnings about missing dist/ files. Metro already falls back to file-based
// resolution which works correctly.
config.resolver.unstable_enablePackageExports = false;

// make-plural@8 is ESM-only with no "main" field — only an "exports" field.
// Since package exports are disabled above, Metro can't find the entry point.
// Redirect bare "make-plural" imports to the actual plurals file.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'make-plural') {
    return context.resolveRequest(context, 'make-plural/plurals', platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
