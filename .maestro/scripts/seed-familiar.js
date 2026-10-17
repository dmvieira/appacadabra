#!/usr/bin/env node
// Seeds the Familiar E2E fixture: one spell ("Tarefas da Casa") using
// AppacadabraAI, with a `tarefas` relic in app_storage — so the imbue flow
// exercises capability mapping + relics without any AI cost.
// Usage: node .maestro/scripts/seed-familiar.js [--storage <json>]
//   --storage <json>  optional extra app_storage rows (key->value object)

const { execSync, spawnSync } = require('child_process');
const os = require('os');
const path = require('path');

const PACKAGE = 'ai.appacadabra.app';
const APP_ID = 900;

function findAdb() {
    const candidates = [
        process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, 'platform-tools', 'adb'),
        path.join(os.homedir(), 'AppData', 'Local', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        '/tmp/opencode/android-sdk-bridge/platform-tools/adb',
        'adb',
    ].filter(Boolean);
    const { execFileSync } = require('child_process');
    for (const c of candidates) {
        try { execFileSync(c, ['version'], { stdio: 'pipe' }); return c; } catch {}
    }
    throw new Error('adb not found');
}

const ADB = findAdb();
const DB = `/data/data/${PACKAGE}/files/SQLite/appacadabra.db`;

function sql(statements) {
    const input = statements.join('\n') + '\n.quit\n';
    const r = spawnSync(ADB, ['shell', 'run-as', PACKAGE, 'sqlite3', DB], { encoding: 'utf8', input });
    if (r.status !== 0) {
        console.error('sqlite3 error:', r.stderr || r.stdout);
        process.exit(1);
    }
    return r.stdout;
}

const html = `<html><body><h1>Tarefas da Casa</h1><script>AppacadabraAI.generate({prompt:"lista de tarefas",callback:"done"});</script></body></html>`;
const now = Date.now();
const extraStorage = process.argv.includes('--storage')
    ? JSON.parse(process.argv[process.argv.indexOf('--storage') + 1])
    : {};

sql([
    // Limpa fixtures anteriores (re-executável)
    `DELETE FROM generated_apps WHERE id = ${APP_ID};`,
    `DELETE FROM app_storage WHERE appId = ${APP_ID};`,
    `INSERT INTO generated_apps (name, code, currentVersion, iconPath, lastUpdated, createdAt, consoleLogs, totalSpendUsd, jobId, requiresBiometric, shortDescription, sortOrder, source, required_capabilities, required_mcps, mcp_pending_fix) VALUES (`,
    `  'Tarefas da Casa',`,
    `  '${html.replace(/'/g, "''")}',`,
    `  1, '', ${now}, ${now}, '', 0, '', 0, 'Encantamento de teste', 0, 'local',`,
    `  '["AI"]', '[]', NULL);`,
    `INSERT INTO app_storage (appId, key, value) VALUES (${APP_ID}, 'tarefas', '{"itens":["trocar filtro do ar"]}');`,
    ...Object.entries(extraStorage).map(
        ([k, v]) => `INSERT OR REPLACE INTO app_storage (appId, key, value) VALUES (${APP_ID}, '${k}', '${String(v).replace(/'/g, "''")}');`
    ),
]);

const id = sql([`SELECT id FROM generated_apps WHERE id = ${APP_ID};`]);
console.log('→ seed ok:', id.trim() ? `spell #${APP_ID} "Tarefas da Casa" + relíquia tarefas` : 'FALHOU');
