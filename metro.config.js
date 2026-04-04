// Learn more https://docs.expo.io/guides/customizing-metro
const { getDefaultConfig } = require('expo/metro-config');

/** @type {import('expo/metro-config').MetroConfig} */
const config = getDefaultConfig(__dirname);

// Disable package exports resolution to suppress @react-native-firebase/app
// warnings about missing dist/ files. Metro already falls back to file-based
// resolution which works correctly.
config.resolver.unstable_enablePackageExports = false;

module.exports = config;
