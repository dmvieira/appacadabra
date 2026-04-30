#!/usr/bin/env node
// Prepares the emulator/device for E2E tests:
// 1. Clears app data (clean state)
// 2. Pre-sets AsyncStorage so onboarding is skipped
// 3. Pre-launches app and waits for React Native to finish rendering
// Usage: node .maestro/scripts/setup-device.js

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');

const PACKAGE = 'ai.appacadabra.app';

function findAdb() {
    const candidates = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
        process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, 'platform-tools', 'adb'),
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', 'adb'),
        'adb',
    ].filter(Boolean);

    for (const candidate of candidates) {
        try { execSync(`"${candidate}" version`, { stdio: 'pipe' }); return candidate; } catch {}
    }
    throw new Error('adb not found. Set ANDROID_HOME or install Android SDK.');
}

function adb(...args) {
    const cmd = `"${ADB}" ${args.join(' ')}`;
    return execSync(cmd, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ADB = findAdb();

(async () => {
    console.log('→ Checking connected device...');
    const devices = adb('devices').split('\n').slice(1).filter(l => l.includes('\tdevice'));
    if (devices.length === 0) throw new Error('No device/emulator connected. Run: npm run emulator:start');
    console.log(`  Connected: ${devices[0].split('\t')[0]}`);

    console.log('→ Clearing app data...');
    // pm clear may fail with NullPointerException if system services are still starting up after boot
    for (let attempt = 1; attempt <= 5; attempt++) {
        try { adb(`shell pm clear ${PACKAGE}`); break; }
        catch (e) {
            if (attempt === 5) throw e;
            console.log(`  pm clear failed (system not ready), retrying in 5s... (${attempt}/5)`);
            await sleep(5000);
        }
    }

    console.log('→ Granting runtime permissions...');
    const PERMISSIONS = [
        'android.permission.ACCESS_COARSE_LOCATION',
        'android.permission.ACCESS_FINE_LOCATION',
        'android.permission.ACTIVITY_RECOGNITION',
        'android.permission.CAMERA',
        'android.permission.POST_NOTIFICATIONS',
        'android.permission.READ_CALENDAR',
        'android.permission.READ_CONTACTS',
        'android.permission.RECORD_AUDIO',
        'android.permission.WRITE_CALENDAR',
        'android.permission.WRITE_CONTACTS',
    ];
    for (const perm of PERMISSIONS) {
        try { adb(`shell pm grant ${PACKAGE} ${perm}`); } catch {}
    }

    console.log('→ Setting app locale to pt-BR...');
    try { adb(`shell cmd locale set-app-locales ${PACKAGE} --locales pt-BR`); } catch {}

    console.log('→ Writing AsyncStorage keys (skip onboarding)...');
    // @react-native-async-storage/async-storage v2 uses SQLite at databases/RKStorage
    const SQL = [
        `CREATE TABLE IF NOT EXISTS catalystLocalStorage (key TEXT PRIMARY KEY, value TEXT NOT NULL);`,
        `INSERT OR REPLACE INTO catalystLocalStorage VALUES ('appacadabra_onboarding_seen','true');`,
        `PRAGMA user_version = 1;`,
        `.quit`,
    ].join('\n');
    const DB_PATH = `/data/data/${PACKAGE}/databases/RKStorage`;
    spawnSync(ADB, ['shell', 'run-as', PACKAGE, 'mkdir', '-p', `/data/data/${PACKAGE}/databases`], { encoding: 'utf-8' });
    const result = spawnSync(ADB, ['shell', 'run-as', PACKAGE, 'sqlite3', DB_PATH], { encoding: 'utf-8', input: SQL });
    if (result.status !== 0) {
        console.error('sqlite3 error:', result.stderr || result.stdout);
        process.exit(1);
    }

    // Set up adb reverse so the device connects via the direct tunnel (localhost)
    // instead of the emulator NAT (10.0.2.2) which corrupts chunked HTTP responses.
    console.log('→ Setting up Metro tunnel (adb reverse port 8081)...');
    try { adb('reverse tcp:8081 tcp:8081'); } catch {}

    // Write React Native dev settings SharedPreferences to route Metro via localhost tunnel.
    // Push via /data/local/tmp then run-as cp (avoids shell redirect Permission denied).
    console.log('→ Configuring Metro host to localhost (via adb reverse tunnel)...');
    const PREFS_DIR = `/data/data/${PACKAGE}/shared_prefs`;
    // RN 0.73+: PackagerConnectionSettings uses PreferenceManager.getDefaultSharedPreferences()
    // which creates {packageName}_preferences.xml
    const PREFS_XML = `<?xml version='1.0' encoding='utf-8' standalone='yes' ?>\r\n<map>\r\n    <string name="debug_http_host">localhost:8081</string>\r\n</map>`;
    const tmpXml = path.join(os.tmpdir(), 'devsettings.xml');
    fs.writeFileSync(tmpXml, PREFS_XML, 'utf-8');
    spawnSync(ADB, ['push', tmpXml, '/data/local/tmp/devsettings.xml'], { encoding: 'utf-8' });
    spawnSync(ADB, ['shell', 'run-as', PACKAGE, 'mkdir', '-p', PREFS_DIR], { encoding: 'utf-8' });
    // Write to both possible filenames (old and new RN naming)
    for (const fname of [`${PACKAGE}_preferences.xml`, 'com.facebook.react.devsettings.xml']) {
        spawnSync(ADB, ['shell', 'run-as', PACKAGE, 'cp', '/data/local/tmp/devsettings.xml',
            `${PREFS_DIR}/${fname}`], { encoding: 'utf-8' });
    }
    console.log('  Metro host set to localhost:8081');

    // Launch app — first attempt may show black screen if Metro had a cold-start race.
    // If not rendering after 30s, force-stop and relaunch (retry always works).
    const DUMP_PATH = '/data/local/tmp/uidump.xml';
    const APP_KEYWORDS = ['Fazer Fei', 'Cast Spell', 'Mana Acab', 'Out of Mana', 'Como funciona', 'Appacadabra'];

    function checkAppReady() {
        try {
            spawnSync(ADB, ['shell', 'uiautomator', 'dump', DUMP_PATH], { encoding: 'utf-8' });
            const dump = spawnSync(ADB, ['shell', 'cat', DUMP_PATH], { encoding: 'utf-8' }).stdout || '';
            if (dump.includes('aerr_wait') || dump.includes('aerr_close')) {
                adb('shell input tap 540 1359');
            }
            return APP_KEYWORDS.some(k => dump.includes(k));
        } catch { return false; }
    }

    for (let attempt = 1; attempt <= 2; attempt++) {
        console.log(`→ Launching app (attempt ${attempt})...`);
        try { adb(`shell am force-stop ${PACKAGE}`); } catch {}
        await sleep(1000);
        adb(`shell am start -n "${PACKAGE}/${PACKAGE}.MainActivity"`);

        const deadline = Date.now() + 45000;
        let ready = false;
        while (Date.now() < deadline) {
            await sleep(3000);
            try { adb('shell am broadcast -a android.intent.action.CLOSE_SYSTEM_DIALOGS'); } catch {}
            if (checkAppReady()) { ready = true; break; }
        }
        if (ready) {
            console.log('  App rendered and ready.');
            break;
        }
        if (attempt < 2) console.log('  Not ready yet — retrying with force-stop...');
        else console.log('  Warning: app may not be fully loaded after 2 attempts.');
    }

    console.log('→ Checking Google test account on device...');
    const TEST_ACCOUNT = 'support@appacadabra.ai';
    const accounts = spawnSync(ADB, ['shell', 'dumpsys', 'account'], { encoding: 'utf-8' }).stdout || '';
    if (!accounts.includes(TEST_ACCOUNT)) {
        console.warn(`
⚠️  Google account '${TEST_ACCOUNT}' not found on emulator.
    Flow 03_login_logout.yaml will fail without it.
    To add: open emulator → Settings → Accounts → Add account → Google
    Sign in with ${TEST_ACCOUNT} once, then re-run this script.
`);
    } else {
        console.log(`  ✓ Account ${TEST_ACCOUNT} found.`);
    }

    console.log('✓ Device ready. Run: npm run test:e2e');
})();
