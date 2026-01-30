/**
 * Pre-build script that regenerates local.properties for Android builds
 * Run before expo prebuild to ensure SDK path is set
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const androidDir = path.join(__dirname, '..', 'android');
const localPropertiesPath = path.join(androidDir, 'local.properties');

// Determine Android SDK path based on platform
let sdkPath;
if (os.platform() === 'win32') {
    sdkPath = path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk');
} else if (os.platform() === 'darwin') {
    sdkPath = path.join(os.homedir(), 'Library', 'Android', 'sdk');
} else {
    sdkPath = path.join(os.homedir(), 'Android', 'Sdk');
}

// Check if SDK exists
if (!fs.existsSync(sdkPath)) {
    console.warn(`Warning: Android SDK not found at ${sdkPath}`);
    console.warn('Please set ANDROID_HOME environment variable or update this script.');
} else {
    // Ensure android directory exists
    if (!fs.existsSync(androidDir)) {
        fs.mkdirSync(androidDir, { recursive: true });
    }

    // Write local.properties
    const content = `sdk.dir=${sdkPath.replace(/\\/g, '\\\\')}`;
    fs.writeFileSync(localPropertiesPath, content);
    console.log(`Created ${localPropertiesPath}`);
    console.log(`SDK path: ${sdkPath}`);
}
