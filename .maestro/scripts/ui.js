#!/usr/bin/env node
// ui.js — automação de UI via adb + uiautomator (substitui o Maestro, que não
// tem instalação nativa no Windows). Exporta helpers de tap/assert por texto
// ou content-desc, input de texto, screenshot e espera.

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

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
const OUT_DIR = '/mnt/c/dev/appa/e2e';
fs.mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UI {
    constructor(serial) {
        this.serial = serial;
        this.S = serial ? ['-s', serial] : [];
    }

    adb(...args) {
        const r = spawnSync(ADB, [...this.S, ...args], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        return (r.stdout || '').toString();
    }

    dumpRaw() {
        this.adb('shell', 'uiautomator', 'dump', '/data/local/tmp/ui.xml');
        const r = spawnSync(ADB, [...this.S, 'exec-out', 'cat', '/data/local/tmp/ui.xml'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
        return (r.stdout || '').toString();
    }

    /** Lista de nodes {text, desc, bounds:[x1,y1,x2,y2]} */
    nodes() {
        const xml = this.dumpRaw();
        const out = [];
        const re = /<node[^>]*>/g;
        let m;
        while ((m = re.exec(xml))) {
            const tag = m[0];
            const get = (attr) => {
                const r = new RegExp(`${attr}="([^"]*)"`).exec(tag);
                return r ? r[1].replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>') : '';
            };
            const bounds = get('bounds');
            const bm = /\[(\d+),(\d+)\]\[(\d+),(\d+)\]/.exec(bounds);
            out.push({
                text: get('text'),
                desc: get('content-desc'),
                cls: get('class'),
                bounds: bm ? [Number(bm[1]), Number(bm[2]), Number(bm[3]), Number(bm[4])] : null,
            });
        }
        return out;
    }

    find(label) {
        const want = label.toLowerCase();
        const ns = this.nodes().map((n) => ({ ...n, lt: (n.text || '').toLowerCase(), ld: (n.desc || '').toLowerCase() }));
        // prioriza match exato de texto, depois content-desc, depois contem
        // (case-insensitive: textTransform uppercase muda o texto renderizado)
        for (const n of ns) if (n.lt === want) return n;
        for (const n of ns) if (n.ld === want) return n;
        for (const n of ns) if (n.lt.includes(want)) return n;
        for (const n of ns) if (n.ld.includes(want)) return n;
        return null;
    }

    async waitFor(label, timeoutMs = 15000) {
        const t0 = Date.now();
        for (;;) {
            if (this.find(label)) return true;
            if (Date.now() - t0 > timeoutMs) return false;
            await sleep(500);
        }
    }

    async assertVisible(label, timeoutMs = 10000) {
        const ok = await this.waitFor(label, timeoutMs);
        if (!ok) throw new Error(`assert falhou: "${label}" não visível (${timeoutMs}ms)`);
    }

    async tap(label, timeoutMs = 10000) {
        if (!(await this.waitFor(label, timeoutMs))) throw new Error(`tap: "${label}" não encontrado`);
        const n = this.find(label);
        const [x1, y1, x2, y2] = n.bounds;
        this.adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
        await sleep(500);
    }

    async tapIfPresent(label, timeoutMs = 2500) {
        const ok = await this.waitFor(label, timeoutMs);
        if (ok) {
            const n = this.find(label);
            const [x1, y1, x2, y2] = n.bounds;
            this.adb('shell', 'input', 'tap', String(Math.round((x1 + x2) / 2)), String(Math.round((y1 + y2) / 2)));
            await sleep(400);
        }
        return ok;
    }

    async clearAndType(text) {
        // foca já estando; limpa com DELs e digita
        for (let i = 0; i < 24; i++) this.adb('shell', 'input', 'keyevent', 'KEYCODE_DEL');
        this.adb('shell', 'input', 'text', text.replace(/ /g, '%s'));
        await sleep(400);
    }

    hideKeyboard() {
        this.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }

    back() {
        this.adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
    }

    screenshot(name) {
        const r = spawnSync(ADB, [...this.S, 'exec-out', 'screencap', '-p'], { encoding: null, maxBuffer: 64 * 1024 * 1024 });
        const file = path.join(OUT_DIR, `${name}.png`);
        fs.writeFileSync(file, r.stdout);
        console.log(`  screenshot: ${file}`);
    }

    launch(pkg) {
        this.adb('shell', 'monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1');
    }

    /** Deep link (expo-router scheme) — ex.: appacadabra://devices */
    deepLink(url) {
        this.adb('shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', url);
    }

    forceStop(pkg) {
        this.adb('shell', 'am', 'force-stop', pkg);
    }
}

module.exports = { UI, findAdb, sleep, ADB };
