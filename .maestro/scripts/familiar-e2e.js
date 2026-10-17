#!/usr/bin/env node
// Familiar E2E orchestrator — app Android (emulador/celular) x appa-sim.
//
// Sequência:
//   1. (opcional) adb install do APK passado em --apk
//   2. setup-device.js (limpa estado, pula onboarding, locale pt-BR)
//   3. primeiro boot (cria o SQLite) + seed da spell fixture
//   4. flow 10 — conectar no appa-sim (host 10.0.2.2:7788)
//   5. flow 11 — imbuir com permissionamento (fallback prompt, zero IA)
//   6. MUTATE no cmdfile do sim.exe → flow 12 valida o write-back aplicado
//
// Uso: node .maestro/scripts/familiar-e2e.js [--apk <path>]
// Requisitos: emulador/celular conectado + appa-sim.exe rodando no host Windows
// (C:\dev\appa\appa-sim.exe --port 7788 --storage C:\dev\appa\sim-e2e --cmdfile C:\dev\appa\cmds.txt)

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE = 'ai.appacadabra.app';
const HERE = __dirname;

function findAdb() {
    const { execFileSync } = require('child_process');
    const candidates = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        '/tmp/opencode/android-sdk-bridge/platform-tools/adb',
        'adb',
    ].filter(Boolean);
    for (const c of candidates) {
        try { execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch {}
    }
    throw new Error('adb not found');
}

const ADB = findAdb();
const adb = (...args) => execSync(`"${ADB}" ${args.join(' ')}`, { encoding: 'utf8', stdio: 'pipe' }).trim();

// cmd.exe do WSL: recebe a linha de comando pronta (paths Windows)
const cmd = (line) => execSync(`cmd.exe /c ${line}`, { encoding: 'utf8', stdio: 'pipe' }).toString();

const FLOWS = ['10_familiar_connect.yaml', '11_familiar_imbue.yaml', '12_familiar_writeback.yaml'];

function maestroFlow(flowWinPath) {
    console.log(`→ maestro: ${path.basename(flowWinPath)}`);
    execSync(`cmd.exe /c "%USERPROFILE%\\.maestro\\maestro\\bin\\maestro.bat" test "${flowWinPath}"`, { stdio: 'inherit' });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    const args = process.argv.slice(2);
    const apk = args.includes('--apk') ? args[args.indexOf('--apk') + 1] : null;

    const devices = adb('devices').split('\n').filter((l) => l.includes('\tdevice'));
    if (devices.length === 0) throw new Error('nenhum device/emulador conectado');
    console.log('→ device:', devices[0].split('\t')[0]);

    if (apk) {
        console.log('→ instalando APK...');
        adb('install -r', `"${apk}"`);
    }

    // Permissões BLE concedidas sem dialog (Nível 2 usa depois)
    for (const p of ['android.permission.BLUETOOTH_SCAN', 'android.permission.BLUETOOTH_CONNECT']) {
        try { adb(`shell pm grant ${PACKAGE} ${p}`); } catch {}
    }

    console.log('→ setup-device (limpa estado, pula onboarding, pt-BR)...');
    execSync(`node ${path.join(HERE, 'setup-device.js')}`, { stdio: 'inherit' });

    console.log('→ primeiro boot (cria SQLite)...');
    adb(`shell monkey -p ${PACKAGE} -c android.intent.category.LAUNCHER 1`);
    await sleep(12000);
    adb(`shell am force-stop ${PACKAGE}`);
    await sleep(1000);

    console.log('→ seed spell fixture...');
    execSync(`node ${path.join(HERE, 'seed-familiar.js')}`, { stdio: 'inherit' });

    // flows copiados para o Windows (cmd.exe não roda de UNC \\wsl.localhost)
    cmd('if not exist C:\\dev\\appa\\e2e mkdir C:\\dev\\appa\\e2e');
    for (const f of FLOWS) {
        fs.copyFileSync(path.join(HERE, '..', 'flows', f), `/mnt/c/dev/appa/e2e/${f}`);
    }

    maestroFlow('C:\\dev\\appa\\e2e\\10_familiar_connect.yaml');
    maestroFlow('C:\\dev\\appa\\e2e\\11_familiar_imbue.yaml');

    // Extrai o encId imbuído do log do sim e injeta a mutação "por voz"
    const log = cmd('type C:\\dev\\appa\\sim.log');
    const encIds = [...log.matchAll(/encantamento armazenado: (enc_[a-z0-9]+)/g)].map((m) => m[1]);
    const encId = encIds[encIds.length - 1];
    if (!encId) throw new Error('encId não encontrado no sim.log — imbue falhou?');
    console.log('→ MUTATE (por voz) no encantamento', encId);
    cmd('type nul > C:\\dev\\appa\\cmds.txt');
    cmd(`echo MUTATE ${encId} tarefas merge {"itens":["lampada da sala"]}>> C:\\dev\\appa\\cmds.txt`);
    await sleep(2500);

    maestroFlow('C:\\dev\\appa\\e2e\\12_familiar_writeback.yaml');

    console.log('\nOK — E2E Familiar completo: conectar -> imbuir -> write-back');
}

main().catch((e) => { console.error('FALHOU:', e.message); process.exit(1); });
