#!/usr/bin/env node
// Starts the appacadabra_test emulator, waits for boot, disables lock screen
// Usage: node .maestro/scripts/start-emulator.js

const { execSync, execFileSync, spawn } = require('child_process');
const os = require('os');
const path = require('path');
const fs = require('fs');

const AVD = 'appacadabra_test';

function findSdkTool(tool) {
    const candidates = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', tool),
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'emulator', tool),
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', tool + '.exe'),
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'emulator', tool + '.exe'),
        path.join(os.homedir(), 'Library', 'Android', 'sdk', 'platform-tools', tool),
        path.join(os.homedir(), 'Library', 'Android', 'sdk', 'emulator', tool),
    ].filter(Boolean);
    for (const c of candidates) {
        try { execSync(`"${c}" -help 2>nul || "${c}" --help 2>/dev/null`, { stdio: 'pipe' }); return c; } catch {}
    }
    throw new Error(`${tool} not found. Install Android SDK.`);
}

function adb(...args) {
    return execSync(`"${ADB}" ${args.join(' ')}`, { encoding: 'utf-8', stdio: 'pipe' }).trim();
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const ADB = findSdkTool('adb');
const EMULATOR = findSdkTool('emulator');

(async () => {
    // Kill existing emulator if any
    try {
        const running = adb('devices').split('\n').filter(l => l.startsWith('emulator'));
        if (running.length > 0) {
            const serial = running[0].split('\t')[0];
            console.log(`→ Stopping existing emulator ${serial}...`);
            try { adb(`-s ${serial} emu kill`); } catch {}
            await sleep(3000);
        }
    } catch {}

    // Set window position and scale before launching (emulator overwrites ini on close)
    const avdUserIni = path.join(os.homedir(), '.android', 'avd', `${AVD}.avd`, 'emulator-user.ini');
    try {
        let ini = fs.readFileSync(avdUserIni, 'utf-8');
        ini = ini.replace(/window\.x\s*=.*/g, 'window.x = 600');
        ini = ini.replace(/window\.y\s*=.*/g, 'window.y = 30');
        ini = ini.replace(/window\.scale\s*=.*/g, 'window.scale = 0.350000');
        fs.writeFileSync(avdUserIni, ini, 'utf-8');
    } catch {}

    console.log(`→ Starting emulator '${AVD}'...`);
    const proc = spawn(`"${EMULATOR}"`, [`-avd ${AVD} -no-snapshot-load -no-boot-anim -gpu host`], {
        shell: true, detached: true, stdio: 'ignore'
    });
    proc.unref();

    console.log('→ Waiting for boot (this takes ~30s)...');
    const timeout = 120000;
    const start = Date.now();
    let booted = false;

    while (Date.now() - start < timeout) {
        await sleep(4000);
        try {
            const val = adb('shell getprop sys.boot_completed');
            process.stdout.write(`\r  [${Math.round((Date.now() - start) / 1000)}s] boot_completed=${val}   `);
            if (val === '1') { booted = true; break; }
        } catch {}
    }

    if (!booted) { console.error('\nEmulator did not boot in time.'); process.exit(1); }

    console.log('\n→ Configuring for testing (no lock screen, no animations)...');
    await sleep(2000);
    try { adb('reverse tcp:8081 tcp:8081'); console.log('→ Metro reverse tunnel set (port 8081).'); } catch {}
    adb('shell settings put secure lockscreen.disabled 1');
    adb('shell settings put global stay_on_while_plugged_in 3');
    adb('shell settings put global window_animation_scale 0');
    adb('shell settings put global transition_animation_scale 0');
    adb('shell settings put global animator_duration_scale 0');
    adb('shell input keyevent 82');

    // Move emulator window to center after it finishes repositioning itself
    await sleep(2000);
    try {
        execSync(`powershell -NoProfile -Command "
Add-Type @'
using System; using System.Runtime.InteropServices;
public class W {
  [DllImport(\\"user32.dll\\")] public static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lp);
  [DllImport(\\"user32.dll\\")] public static extern int GetWindowText(IntPtr h, System.Text.StringBuilder s, int n);
  [DllImport(\\"user32.dll\\")] public static extern bool SetWindowPos(IntPtr h, IntPtr i, int x, int y, int cx, int cy, uint f);
  [DllImport(\\"user32.dll\\")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumWindowsProc(IntPtr h, IntPtr lp);
}
'@
[W]::EnumWindows({param($h,$l) $s=New-Object System.Text.StringBuilder 256; [W]::GetWindowText($h,$s,256)|Out-Null; if($s.ToString() -match 'Emulator'){[W]::SetWindowPos($h,[IntPtr]::Zero,600,30,0,0,0x0001)|Out-Null}; return $true}, [IntPtr]::Zero) | Out-Null
"`, { stdio: 'pipe' });
        console.log('→ Emulator window repositioned.');
    } catch {}

    console.log('✓ Emulator ready.');
    console.log('  Next steps:');
    console.log('    npm run android   (installs/updates the app)');
    console.log('    npm run test:e2e  (runs E2E tests)');
})();
