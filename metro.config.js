// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Enable package exports resolution so @react-native-firebase/app v23+ modules
// (functions, app-check, etc.) resolve to dist/commonjs/ instead of lib/,
// which ensures a single FirebaseModule instance and prevents "module could not
// be found" errors at runtime.
config.resolver.unstable_enablePackageExports = true;

// make-plural@8 is ESM-only with no "main" field — only an "exports" field.
// Redirect bare "make-plural" imports to the actual plurals file so Metro
// can resolve it without issues.
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'make-plural') {
    return context.resolveRequest(context, 'make-plural/plurals', platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
