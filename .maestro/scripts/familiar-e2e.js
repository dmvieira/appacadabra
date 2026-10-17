#!/usr/bin/env node
// Familiar E2E orchestrator — app Android (emulador OU celular físico) x appa-sim.
// Automação de UI via adb + uiautomator (sem Maestro).
//
// Sequência:
//   1. (opcional) adb install do APK passado em --apk
//   2. celular físico: adb reverse 7788 (sim)
//   3. setup-device.js (limpa estado, pula onboarding, pt-BR, reverse 8081)
//   4. primeiro boot + seed da spell fixture
//   5. conecta no appa-sim (FAMILIAR_HOST), imbuir, MUTATE por voz, write-back
//
// Uso: node .maestro/scripts/familiar-e2e.js [--apk <path>] [--serial <sn>] [--skip-setup]

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { UI, sleep } = require('./ui.js');

const PACKAGE = 'ai.appacadabra.app';
const HERE = __dirname;

function findAdb() {
    const { execFileSync } = require('child_process');
    const candidates = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
        '/tmp/opencode/android-sdk-bridge/platform-tools/adb',
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        'adb',
    ].filter(Boolean);
    for (const c of candidates) {
        try { execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch {}
    }
    throw new Error('adb not found');
}

const ADB = findAdb();
const adb = (...args) => execSync(`"${ADB}" ${args.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' }).trim();
const cmd = (line) => execSync(`cmd.exe /c ${line}`, { encoding: 'utf8', stdio: 'pipe' }).toString();

async function openFamilyScreenAndConnect(ui, FAMILIAR_HOST) {
    // home → tela Familiares (🐾 na header, accessibilityLabel "Imbuir Familiar")
    await ui.tap('Imbuir Familiar', 20000);
    await ui.assertVisible('Conectar', 15000);
    // host default = 10.0.2.2; troca para FAMILIAR_HOST
    await ui.tap('10.0.2.2', 10000);
    await ui.clearAndType(FAMILIAR_HOST);
    ui.hideKeyboard();
    await sleep(400);
    await ui.tap('Conectar', 10000);
    await ui.assertVisible('fofura-sim', 12000);
}


function readEncIdFromApp(serial) {
    // puxa o db do app, lê app_settings 'devices.encIndex' e devolve o ultimo enc id
    const { spawnSync } = require('child_process');
    const tmp = '/mnt/c/dev/appa/.e2e/encindex.db';
    const r = spawnSync(ADB, ['-s', serial, 'exec-out', 'run-as', PACKAGE, 'cat', 'files/SQLite/appacadabra.db'], { maxBuffer: 64 * 1024 * 1024 });
    if (!r.stdout || r.stdout.length === 0) return null;
    fs.writeFileSync(tmp, r.stdout);
    try {
        const out = execSync(`python3 -c "import sqlite3,json;c=sqlite3.connect('${tmp}');r=c.execute(\"select value from app_settings where key='devices.encIndex'\").fetchone();print(list(json.loads(r[0]).keys())[-1] if r else '')"`, { encoding: 'utf8' }).trim();
        return out || null;
    } catch { return null; }
}

async function main() {
    const args = process.argv.slice(2);
    const apk = args.includes('--apk') ? args[args.indexOf('--apk') + 1] : null;
    const serialArg = args.includes('--serial') ? args[args.indexOf('--serial') + 1] : null;
    const skipSetup = args.includes('--skip-setup');

    const lines = adb('devices').split('\n').filter((l) => l.includes('\tdevice'));
    if (lines.length === 0) throw new Error('nenhum device/emulador conectado');
    const serial = serialArg || lines[0].split('\t')[0];
    const isEmulator = serial.startsWith('emulator-');
    console.log(`→ device: ${serial} (${isEmulator ? 'emulador' : 'celular físico'})`);

    const FAMILIAR_HOST = isEmulator ? '10.0.2.2' : '127.0.0.1';
    console.log(`→ FAMILIAR_HOST=${FAMILIAR_HOST}`);

    if (apk) {
        console.log('→ instalando APK...');
        adb(`-s ${serial} install -r "${apk}"`);
    }
    if (!isEmulator) {
        console.log('→ adb reverse tcp:7788 (sim) ...');
        adb(`-s ${serial} reverse tcp:7788 tcp:7788`);
    }
    // Metro sempre via reverse (device debug carrega o bundle do dev server)
    try { adb(`-s ${serial} reverse tcp:8081 tcp:8081`); } catch {}
    for (const p of ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT']) {
        try { adb(`-s ${serial} shell pm grant ${PACKAGE} ${p}`); } catch {}
    }

    if (!skipSetup) {
        console.log('→ setup-device (limpa estado, pula onboarding, pt-BR)...');
        execSync(`node ${path.join(HERE, 'setup-device.js')}`, {
            stdio: 'inherit',
            env: { ...process.env, ANDROID_HOME: '/tmp/opencode/android-sdk-bridge', ANDROID_SERIAL: serial },
        });
        console.log('→ primeiro boot (cria SQLite)...');
        adb(`-s ${serial} shell am force-stop ${PACKAGE}`);
        adb(`-s ${serial} shell monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`);
        await sleep(15000);
        adb(`-s ${serial} shell am force-stop ${PACKAGE}`);
        await sleep(1200);
        console.log('→ seed spell fixture...');
        execSync(`node ${path.join(HERE, 'seed-familiar.js')} --serial ${serial}`, { stdio: 'inherit' });
    }

    const ui = new UI(serial);

    // ---- Fluxo 1: conectar no Familiar (deep link /devices) ----------------
    console.log('→ [1/3] abrir app + conectar no Familiar...');
    ui.forceStop(PACKAGE);
    ui.launch(PACKAGE);
    await ui.assertVisible('Imbuir Familiar', 120000);   // home pronta
    await ui.tapIfPresent('Ignorar backup', 4000);
    ui.deepLink('appacadabra://devices');
    await ui.assertVisible('Conectar', 15000);
    await ui.tap('10.0.2.2', 10000);
    await ui.clearAndType(FAMILIAR_HOST);
    ui.hideKeyboard();
    await sleep(400);
    await ui.tap('Conectar', 10000);
    await ui.assertVisible('fofura-sim', 12000);
    await ui.assertVisible('Poderes concedidos', 8000);   // matches PODERES CONCEDIDOS
    await ui.assertVisible('AI', 8000);
    await ui.assertVisible('Sheets', 8000);
    await ui.assertVisible('Sem encantamentos', 8000);
    ui.screenshot('familiar_conectado');
    console.log('  ✓ conectado ao appa-sim');

    // ---- Fluxo 2: imbuir a spell (deep link /devices/imbue) ----------------
    console.log('→ [2/3] imbuir a spell (permissionamento + relíquias)...');
    ui.deepLink('appacadabra://devices/imbue?appId=900');
    await ui.assertVisible('Poderes que viajam com ela', 30000);
    await ui.assertVisible('openrouter', 8000);
    await ui.assertVisible('Relíquias (dados)', 8000);
    await ui.assertVisible('tarefas', 8000);
    await ui.assertVisible('Prompt de voz', 8000);
    ui.screenshot('imbue_revisao');
    await ui.tap('Imbuir!', 10000);
    await ui.assertVisible('Encantado!', 30000);
    ui.screenshot('imbue_encantado');
    console.log('  ✓ encantamento imbuído');

    // ---- Mutação "por voz" no device ---------------------------------------
    // encId: lido do índice persistido no app (app_settings.devices.encIndex)
    const encId = readEncIdFromApp(serial);
    if (!encId) throw new Error('encId não encontrado (devices.encIndex) — imbue falhou?');
    console.log(`→ MUTATE (por voz) em ${encId}...`);
    // Escreve direto no spool (sem escaping do cmd); o sim drena o arquivo
    fs.appendFileSync('/mnt/c/dev/appa/cmds.txt', `MUTATE ${encId} tarefas merge {"itens":["lampada da sala"]}\n`);
    await sleep(3500);

    // ---- Fluxo 3: validar o write-back no retrato do device ----------------
    console.log('→ [3/3] validar o write-back aplicado...');
    ui.deepLink('appacadabra://devices');
    await ui.assertVisible('mutações aplicadas', 15000);
    ui.screenshot('familiar_writeback');
    console.log('  ✓ write-back aplicado');

    console.log('\nOK — E2E Familiar completo: conectar -> imbuir -> write-back');
}

main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
