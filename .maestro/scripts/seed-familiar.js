#!/usr/bin/env node
// Seeds the Familiar E2E fixture by patching the app's REAL SQLite:
//   1. pull appacadabra.db (+ WAL/SHM) via `adb exec-out run-as cat`
//   2. python3 patch_appdb.py insere a spell + relíquias e consolida o WAL
//   3. push de volta para files/SQLite/appacadabra.db (e limpa wal/shm)
//
// Uso: node .maestro/scripts/seed-familiar.js [--serial <sn>]
// (o device nao tem o binario sqlite3; por isso o patch acontece no WSL)

const { execFileSync, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const PACKAGE = 'ai.appacadabra.app';
const APP_ID = 900;
const APP_NAME = 'Tarefas da Casa';
const WIN_TMP = '/mnt/c/dev/appa/.e2e';
const WIN_TMP_ADB = 'C:\\dev\\appa\\.e2e';

function findAdb() {
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
const serial = process.argv.includes('--serial')
    ? process.argv[process.argv.indexOf('--serial') + 1]
    : process.env.ANDROID_SERIAL || null;
const S = serial ? ['-s', serial] : [];

const DB_REL = `files/SQLite/appacadabra.db`;
const DB_ABS = `/data/data/${PACKAGE}/${DB_REL}`;

function run(args, opts = {}) {
    return spawnSync(ADB, [...S, ...args], { maxBuffer: 64 * 1024 * 1024, ...opts });
}

function pull(devicePath, localPath) {
    const r = run(['exec-out', 'run-as', PACKAGE, 'cat', devicePath], { encoding: null });
    if (r.status !== 0 || !r.stdout || r.stdout.length === 0) return false;
    fs.writeFileSync(localPath, r.stdout);
    return true;
}

function push(localPath, devicePath) {
    run(['push', path.join(WIN_TMP_ADB, path.basename(localPath)), '/data/local/tmp/seedfile']);
    const r = run(['shell', 'run-as', PACKAGE, 'cp', '/data/local/tmp/seedfile', devicePath], { encoding: 'utf8' });
    return r.status === 0;
}

async function main() {
    fs.mkdirSync(WIN_TMP, { recursive: true });

    console.log('→ pull appacadabra.db (real, criado pelo app)...');
    const localDb = path.join(WIN_TMP, 'appacadabra.db');
    if (!pull(DB_ABS, localDb)) throw new Error('falha ao puxar o appacadabra.db (primeiro boot rodou?)');
    pull(DB_ABS + '-wal', localDb + '-wal');
    pull(DB_ABS + '-shm', localDb + '-shm');

    const html = `<html><body><h1>Tarefas da Casa</h1><script>AppacadabraAI.generate({prompt:"lista de tarefas",callback:"ok"});</script></body></html>`;
    const codeFile = path.join(WIN_TMP, 'code.html');
    fs.writeFileSync(codeFile, html, 'utf8');

    const storage = JSON.stringify({ tarefas: JSON.stringify({ itens: ['trocar filtro do ar'] }) });
    console.log('→ patch (spell + relíquia)...');
    const py = execFileSync('python3', [path.join(__dirname, 'patch_appdb.py'), localDb, String(APP_ID), APP_NAME, codeFile, storage], { encoding: 'utf8' });
    process.stdout.write('  ' + py);

    console.log('→ push de volta...');
    if (!push(localDb, DB_ABS)) throw new Error('falha ao devolver o db');
    run(['shell', 'run-as', PACKAGE, 'rm', '-f', DB_ABS + '-wal', DB_ABS + '-shm']);

    // verificação
    const verify = path.join(WIN_TMP, 'verify.db');
    pull(DB_ABS, verify);
    const out = execFileSync('python3', ['-c',
        `import sqlite3,sys;c=sqlite3.connect(sys.argv[1]);print(c.execute("select id,name,required_capabilities from generated_apps where id=900").fetchall());print(c.execute("select key,value from app_storage where appId=900").fetchall())`,
        verify], { encoding: 'utf8' });
    console.log('→ verificado:', out.trim().replace(/\n/g, ' | '));
}

main().catch((e) => { console.error('seed FALHOU:', e.message); process.exit(1); });
