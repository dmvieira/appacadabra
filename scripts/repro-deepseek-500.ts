/**
 * Reproduces the OpenRouter DeepSeek call used by generateSpellEdit, with a
 * matrix over the noCache header and other knobs, so we can isolate what
 * triggers the 500 reported for spell edit.
 *
 * Not part of the app — scaffolding for investigation. Delete after.
 *
 * Constants copied verbatim from:
 *   lib/api/openrouter.ts       (APP_REFERRER, APP_TITLE, buildHeaders)
 *   lib/api/pricing.ts          (OR_BASE_URL, MODELS.SPELL_S, OR_REASONING_HIGH, OR_WEB_SEARCH)
 *   lib/api/generatorStages.ts  (SPELL_MAX_TOKENS)
 *
 * Run:
 *   OPENROUTER_KEY=sk-or-v1-... node --require ./scripts/sucrase-register.js scripts/repro-deepseek-500.ts
 */

import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const OR_BASE_URL = 'https://openrouter.ai/api/v1';
const MODEL_SPELL_S = 'deepseek/deepseek-v4-flash';
const SPELL_MAX_TOKENS = 32_000;
const APP_REFERRER = 'https://appacadabra.ai';
const APP_TITLE = 'Appacadabra';
const DEFAULT_TIMEOUT_MS = 120_000;

const KEY = process.env.OPENROUTER_KEY;
if (!KEY) {
    console.error('Missing OPENROUTER_KEY env var');
    process.exit(1);
}

// The real planner/patcher system prompt is thousands of tokens (capability docs
// injected in). DeepSeek's prompt cache typically engages only above ~1024
// tokens, so a truly minimal system prompt would leave cache dormant and
// mask any cache-driven bug. We pad the system prompt with structured
// lorem-ipsum so cache has something to key off. The user prompt stays
// minimal (matches "HTML mínimo sintético").
const FILLER_LINE =
    'Follow standard patterns, avoid deprecated APIs, always emit valid JSON, ' +
    'never invent capability names, keep line numbers stable across edits. ';
const CHUNKY_SYS =
    'You are an HTML patcher. Return {"changes":[{"startLine":N,"endLine":N,"content":"..."}]}.\n\n' +
    'Reference material (verbose on purpose so the prefix engages the prompt cache):\n' +
    FILLER_LINE.repeat(400);

const MINIMAL_SYS = 'You are an HTML patcher. Return {"changes":[]} only.';

const MINIMAL_USER =
    'Change "oi" to "olá" in this numbered HTML. Return only {"changes":[...]}:\n' +
    '```html\n1| <html><body>oi</body></html>\n```';

interface Variant {
    label: string;
    noCache: boolean;
    withReasoning: boolean;
    withWebSearch: boolean;
    systemPrompt: string;
    userPrompt: string;
}

const variants: Variant[] = [
    { label: 'A: MINIMAL sys, cache=true, reasoning=high, web=on (mimics prod, cache likely dormant)',
      noCache: false, withReasoning: true,  withWebSearch: true,  systemPrompt: MINIMAL_SYS, userPrompt: MINIMAL_USER },
    { label: 'B: MINIMAL sys, cache=false, reasoning=high, web=on',
      noCache: true,  withReasoning: true,  withWebSearch: true,  systemPrompt: MINIMAL_SYS, userPrompt: MINIMAL_USER },
    { label: 'C: CHUNKY sys (~4k tokens), cache=true, reasoning=high, web=on (cache should engage)',
      noCache: false, withReasoning: true,  withWebSearch: true,  systemPrompt: CHUNKY_SYS,  userPrompt: MINIMAL_USER },
    { label: 'D: CHUNKY sys, cache=false, reasoning=high, web=on',
      noCache: true,  withReasoning: true,  withWebSearch: true,  systemPrompt: CHUNKY_SYS,  userPrompt: MINIMAL_USER },
    { label: 'E: CHUNKY sys, cache=true, reasoning=high, NO web',
      noCache: false, withReasoning: true,  withWebSearch: false, systemPrompt: CHUNKY_SYS,  userPrompt: MINIMAL_USER },
    { label: 'F: CHUNKY sys, cache=true, NO reasoning, web=on',
      noCache: false, withReasoning: false, withWebSearch: true,  systemPrompt: CHUNKY_SYS,  userPrompt: MINIMAL_USER },
    { label: 'G: CHUNKY sys, cache=true, NO reasoning, NO web (bare baseline)',
      noCache: false, withReasoning: false, withWebSearch: false, systemPrompt: CHUNKY_SYS,  userPrompt: MINIMAL_USER },
];

interface Result {
    label: string;
    status: number | string;
    headers: Record<string, string>;
    body: string;
    ms: number;
}

function buildBody(v: Variant): object {
    const body: Record<string, unknown> = {
        model: MODEL_SPELL_S,
        messages: [
            { role: 'system', content: v.systemPrompt },
            { role: 'user', content: v.userPrompt },
        ],
        max_tokens: SPELL_MAX_TOKENS,
        usage: { include: true },
    };
    if (v.withReasoning) body.reasoning = { effort: 'high' };
    if (v.withWebSearch) body.plugins = [{ id: 'web', max_results: 10 }];
    return body;
}

function buildHeaders(v: Variant): Record<string, string> {
    return {
        Authorization: `Bearer ${KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': APP_REFERRER,
        'X-Title': APP_TITLE,
        'X-OpenRouter-Cache': v.noCache ? 'false' : 'true',
    };
}

function runOne(v: Variant): Promise<Result> {
    const body = JSON.stringify(buildBody(v));
    const headers = buildHeaders(v);
    (headers as Record<string, string>)['Content-Length'] = String(Buffer.byteLength(body));

    const start = Date.now();
    return new Promise<Result>((resolve) => {
        const req = httpsRequest(
            {
                hostname: 'openrouter.ai',
                path: '/api/v1/chat/completions',
                method: 'POST',
                headers,
                timeout: DEFAULT_TIMEOUT_MS,
            },
            (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    resolve({
                        label: v.label,
                        status: res.statusCode ?? 'no-status',
                        headers: Object.fromEntries(
                            Object.entries(res.headers).map(([k, val]) => [k, String(val ?? '')]),
                        ),
                        body: data,
                        ms: Date.now() - start,
                    });
                });
            },
        );
        req.on('error', (err) => {
            resolve({ label: v.label, status: `ERR ${err.message}`, headers: {}, body: '', ms: Date.now() - start });
        });
        req.on('timeout', () => {
            req.destroy(new Error('timeout'));
        });
        req.write(body);
        req.end();
    });
}

function summarize(r: Result): void {
    console.log('\n============================================================');
    console.log(r.label);
    console.log('============================================================');
    console.log(`status: ${r.status}   elapsed: ${r.ms}ms`);
    const interesting = Object.entries(r.headers)
        .filter(([k]) => /openrouter|cache|content-type|x-/i.test(k))
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');
    if (interesting) console.log('response headers (filtered):\n' + interesting);

    let bodyForDisplay = r.body;
    try {
        const parsed = JSON.parse(r.body);
        if (parsed?.choices?.[0]?.message?.content) {
            const content = String(parsed.choices[0].message.content);
            const trimmedContent = content.length > 300 ? content.slice(0, 300) + '…' : content;
            parsed.choices[0].message.content = trimmedContent;
        }
        bodyForDisplay = JSON.stringify(parsed, null, 2);
    } catch {
        // leave raw
    }

    const snippet = bodyForDisplay.length > 1600 ? bodyForDisplay.slice(0, 1600) + `\n... [truncated ${bodyForDisplay.length} total]` : bodyForDisplay;
    console.log('body:\n' + snippet);
}

// Real payload replicating generateSpellEdit for the "Tecla Fácil" spell +
// "add falling keys visualization" edit request. HTML lives beside this file.
function buildRealVariant(noCache: boolean, label: string): Variant {
    const htmlPath = join(__dirname, 'repro-html.txt');
    const rawCode = readFileSync(htmlPath, 'utf8');
    const numberedCode = rawCode
        .replace(/\r\n/g, '\n')
        .split('\n')
        .map((l, i) => `${i + 1}| ${l}`)
        .join('\n');

    // Simulate ALL_CAPABILITIES.docs + planner instructions size (~15-20KB of
    // real capability documentation gets injected in production).
    const CAPABILITY_FILLER =
        'Capabilities available on window.Appacadabra*: ai, audio, calendar, camera, ' +
        'clipboard, contacts, device, docs, forms, health, notify, screen, sensors, ' +
        'share, sheets, ui. Each exposes typed callbacks; always use string callback ' +
        'names, never inline closures. Never invent capability names. Prefer localStorage ' +
        'for user data. Preserve existing DOM ids so localStorage keys survive edits. ';

    const systemPrompt =
        'You are an HTML patcher for a micro-app generator. Return a JSON object with ' +
        'shape {"changes":[{"startLine":N,"endLine":N,"content":"..."}]}. Line numbers ' +
        'refer to the numbered code block below. Preserve indentation. Never remove or ' +
        'rename localStorage keys.\n\n' +
        CAPABILITY_FILLER.repeat(60);

    const editInstruction =
        'quero que tenha uma forma de ver as teclas caindo para saber o momento da ' +
        'música que preciso apertar elas (estilo Piano Tiles / Synthesia)';

    const userPrompt =
        `User's edit request: ${editInstruction}\n\nFull code:\n\`\`\`html\n${numberedCode}\n\`\`\``;

    return {
        label,
        noCache,
        withReasoning: true,
        withWebSearch: true,
        systemPrompt,
        userPrompt,
    };
}

(async () => {
    console.log(`Model: ${MODEL_SPELL_S}`);
    console.log(`Base:  ${OR_BASE_URL}`);

    const mode = process.argv[2] ?? 'matrix';

    if (mode === 'real-create') {
        // Reproduce SpellCreate: small user prompt but huge system prompt
        // (planner + ALL_CAPABILITIES docs). Same web+size hypothesis.
        const CAPABILITY_FILLER =
            'Capability docs: window.AppacadabraAudio.record(cb), .play(url). ' +
            'window.AppacadabraCamera.take(cb). window.AppacadabraContacts.search(q, cb). ' +
            'window.AppacadabraCalendar.addEvent(evt, cb). window.AppacadabraNotify.schedule(n, cb). ' +
            'window.AppacadabraShare.receive(cb). window.AppacadabraSheets.create(cb). ' +
            'window.AppacadabraDocs.create(cb). window.AppacadabraForms.create(cb). ';
        const bigSys =
            'You are an app planner. Return a JSON plan for an HTML micro-app.\n\n' +
            CAPABILITY_FILLER.repeat(120);
        const smallUser =
            'Faz um feitiço que me ajude a salvar coisas na minha agenda através de prints, áudio, voz ou texto';

        const createOn: Variant = {
            label: 'REAL-CREATE: small user + big sys, web=on',
            noCache: true, withReasoning: true, withWebSearch: true,
            systemPrompt: bigSys, userPrompt: smallUser,
        };
        const createOff: Variant = {
            label: 'REAL-CREATE: small user + big sys, web=OFF',
            noCache: true, withReasoning: true, withWebSearch: false,
            systemPrompt: bigSys, userPrompt: smallUser,
        };
        const sysBytes = Buffer.byteLength(bigSys);
        console.log(`system prompt: ${sysBytes} bytes (~${Math.round(sysBytes/4)} tokens)`);
        console.log(`user prompt:   ${Buffer.byteLength(smallUser)} bytes`);

        const r1 = await runOne(createOn);
        summarize(r1);
        await new Promise((r) => setTimeout(r, 1500));
        const r2 = await runOne(createOff);
        summarize(r2);
        return;
    }

    if (mode === 'real-matrix') {
        // Bisect the flag matrix on the REAL payload to find which combination
        // triggers the 500. Each variant sends the same real prompt.
        const base = buildRealVariant(true, 'ignored');
        const flagMatrix: Variant[] = [
            { ...base, label: 'M1: reasoning=high, web=on   (mirrors production)', withReasoning: true,  withWebSearch: true  },
            { ...base, label: 'M2: reasoning=high, web=OFF',                        withReasoning: true,  withWebSearch: false },
            { ...base, label: 'M3: reasoning=OFF, web=on',                          withReasoning: false, withWebSearch: true  },
            { ...base, label: 'M4: reasoning=OFF, web=OFF  (bare baseline)',        withReasoning: false, withWebSearch: false },
        ];
        for (const v of flagMatrix) {
            const r = await runOne(v);
            summarize(r);
            await new Promise((r) => setTimeout(r, 1500));
        }
        return;
    }

    if (mode === 'real') {
        // Two calls: first is production-shape (cache=true — could HIT a
        // poisoned entry), second forces cache=false (matches retry behavior).
        const realCacheOn  = buildRealVariant(false, 'REAL: Tecla Fácil + falling-keys edit, cache=true, reasoning=high, web=on');
        const realCacheOff = buildRealVariant(true,  'REAL: Tecla Fácil + falling-keys edit, cache=false, reasoning=high, web=on');
        const sysBytes = Buffer.byteLength(realCacheOn.systemPrompt);
        const userBytes = Buffer.byteLength(realCacheOn.userPrompt);
        console.log(`system prompt: ${sysBytes} bytes (~${Math.round(sysBytes/4)} tokens)`);
        console.log(`user prompt:   ${userBytes} bytes (~${Math.round(userBytes/4)} tokens)`);

        console.log('\n>>> Call 1 (cache=true, mimics prod first attempt)');
        const r1 = await runOne(realCacheOn);
        summarize(r1);

        console.log('\n>>> Sleeping 2s, then call 2 (cache=false, mimics retry attempt)');
        await new Promise((r) => setTimeout(r, 2000));
        const r2 = await runOne(realCacheOff);
        summarize(r2);

        console.log('\n>>> Sleeping 2s, then call 3 (cache=true again — replay to test cache HIT)');
        await new Promise((r) => setTimeout(r, 2000));
        const r3 = await runOne(realCacheOn);
        summarize(r3);
        return;
    }

    if (mode === 'hit') {
        // Two identical requests back-to-back. First should MISS, second should
        // HIT (cache TTL is 300s). If the HIT returns a 500 or bad payload, we
        // have direct proof that a bad cache entry is behind the reported bug.
        const hitVariant: Variant = {
            label: 'HIT-TEST: CHUNKY sys, cache=true, reasoning=high, web=on',
            noCache: false,
            withReasoning: true,
            withWebSearch: true,
            systemPrompt: CHUNKY_SYS,
            userPrompt: MINIMAL_USER,
        };
        console.log('\n>>> First call (expect MISS)');
        const r1 = await runOne(hitVariant);
        summarize(r1);
        console.log('\n>>> Sleeping 2s, then second call (expect HIT)');
        await new Promise((r) => setTimeout(r, 2000));
        const r2 = await runOne(hitVariant);
        summarize(r2);
        console.log('\n>>> Sleeping 2s, then third call (also expect HIT)');
        await new Promise((r) => setTimeout(r, 2000));
        const r3 = await runOne(hitVariant);
        summarize(r3);
        return;
    }

    console.log(`Variants: ${variants.length}`);
    for (const v of variants) {
        try {
            const r = await runOne(v);
            summarize(r);
        } catch (err) {
            console.error(`[${v.label}] threw: ${err instanceof Error ? err.message : String(err)}`);
        }
        await new Promise((r) => setTimeout(r, 1500));
    }
})();
