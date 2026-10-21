/**
 * L2-live: the real forja — OpenRouter (BYOK) transmutes a spoken-assistant
 * prompt, the mini-forja wraps it into a bundle, and the real C++ appa-sim
 * stores it as an encantamento. Closes the spell -> AI -> bundle -> device
 * loop with zero hardware.
 *
 * Guardrails (per plan):
 * - opt-in only: RUN_LIVE=1 (default suite never touches the network)
 * - key from OPENROUTER_API_KEY env var or ../appa/.env.local (gitignored);
 *   never written to a tracked file, never logged
 * - cost guardrail: single cheap SPELL_S call, asserted < $0.50
 */

import * as fs from 'fs';
import * as path from 'path';

import { AppaClient } from '../../lib/devices/appaClient';
import { transmuteSpell, validateBundle } from '../../lib/devices/transmute';
import { TcpTransport } from '../../lib/devices/transport';
import { hasAppaRepo, startSim, type SimHandle } from './simHarness';

const RUN_LIVE = process.env.RUN_LIVE === '1';

function loadKey(): string | null {
    if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
    const envLocal = path.resolve(__dirname, '..', '..', '..', 'appa', '.env.local');
    if (fs.existsSync(envLocal)) {
        const match = fs.readFileSync(envLocal, 'utf8').match(/^OPENROUTER_API_KEY=(.+)$/m);
        if (match) return match[1].trim();
    }
    return null;
}

const liveKey = RUN_LIVE ? loadKey() : null;
const describeLive = RUN_LIVE && liveKey && hasAppaRepo ? describe : describe.skip;

// Feed the real pipeline (lib/api/openrouter -> keyStorage) without touching
// SecureStore: the factory reads the key from globalThis at call time, so it
// is never part of any snapshot, log, or fixture.
(globalThis as Record<string, unknown>).__APPA_LIVE_KEY = liveKey;
jest.mock('expo-secure-store', () => ({
    getItemAsync: jest.fn(async () => (globalThis as Record<string, unknown>).__APPA_LIVE_KEY ?? null),
    setItemAsync: jest.fn(async () => {}),
    deleteItemAsync: jest.fn(async () => {}),
}));

describeLive('appa L2-live — forja OpenRouter -> encantamento no device', () => {
    jest.setTimeout(120_000);

    let sim: SimHandle | null = null;

    beforeAll(async () => {
        sim = await startSim('fofura-sim');
    });

    afterAll(() => {
        sim?.stop();
    });

    test('transmuta um pedido em prompt de voz e encanta o appa-sim', async () => {
        // Require dinâmico: carrega o pipeline real depois do mock de SecureStore.
        const { chat } = require('../../lib/api/openrouter');
        const { getPreferredModel } = require('../../lib/api/modelPreferences');

        const model = await getPreferredModel('SPELL_S');
        const response = await chat({
            model,
            messages: [
                {
                    role: 'user',
                    content:
                        'Escreva um system prompt curto (3 a 6 frases, português do Brasil) para o guardião de voz ' +
                        'de uma casa chamado "fofura". Ele responde sobre tarefas de manutenção da casa, é direto e ' +
                        'fala em voz alta. Devolva APENAS o texto do prompt, sem títulos, sem aspas, sem markdown.',
                },
            ],
            // Reasoning models burn budget on reasoning_tokens before content.
            max_tokens: 2000,
        });

        const rawPrompt = (response.choices?.[0]?.message?.content ?? '').trim();
        const prompt = rawPrompt.replace(/^[`"']+|[`"']+$/g, '').trim();
        expect(prompt.length).toBeGreaterThanOrEqual(80);
        expect(prompt.length).toBeLessThanOrEqual(8192);

        const bundle = transmuteSpell({
            spellId: 'app_live01',
            name: 'Guardião da Casa',
            prompt,
            data: { tarefas: [{ id: 1, t: 'trocar filtro do ar' }] },
            capabilities: [
                { id: 'ai', status: 'granted', powers: ['openrouter'], requires: ['net'] },
            ],
        });
        expect(validateBundle(bundle)).toBeNull();

        const client = new AppaClient(new TcpTransport('127.0.0.1', sim!.port));
        const portrait = await client.connect();
        expect(portrait.proto).toBe(1);
        expect(portrait.device.capabilities).toContain('ai');

        // Ritual: concede o poder openrouter (chave de teste, cap $50)
        await client.grantPower('openrouter', liveKey as string);

        const ack = await client.enchant(bundle);
        expect(ack).toMatchObject({ id: bundle.manifest.id, version: 1, stored: true });

        // Loop de voz no device: ASK roteia -> prompt+reliquias -> OpenRouter real
        const answers: Array<{ enc: string; q: string; a: string }> = [];
        client.queryResultHandler = (qr) => answers.push(qr);
        sim!.write('ASK o que eu tenho pra fazer de tarefa?');
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('QUERY_RESULT nao chegou (30s)')), 30_000);
            const poll = setInterval(() => {
                if (answers.length > 0) {
                    clearTimeout(t);
                    clearInterval(poll);
                    resolve();
                }
            }, 200);
        });
        expect(answers[0].enc).toBe(bundle.manifest.id);
        expect(answers[0].a.length).toBeGreaterThan(10);

        client.close();

        const cost = (response.usage as { cost?: number } | undefined)?.cost;
        if (typeof cost === 'number') {
            expect(cost).toBeLessThan(0.5);
        }
    });

    test('wake custom + VOICE: acorda com "Appa" e responde o encantamento certo (IA real)', async () => {
        const bundle = transmuteSpell({
            encId: 'enc_l1ve01',
            spellId: 'app_live02',
            name: 'Lista de Compras',
            prompt: 'Você é o guardião da lista de compras. Responda em uma frase curta, em português.',
            data: { lista: JSON.stringify(['arroz', 'café']) },
            keywords: ['lista de compras', 'mercado'],
            capabilities: [
                { id: 'ai', status: 'granted', powers: ['openrouter'], requires: ['net'] },
            ],
        });
        expect(validateBundle(bundle)).toBeNull();

        const client = new AppaClient(new TcpTransport('127.0.0.1', sim!.port));
        await client.connect();
        // A wakeword custom é configurada pelo app (nome É a wakeword).
        await client.setConfig({ name: 'Appa', wake: { mode: 'flex', phrase: 'Appa' } });
        await client.grantPower('openrouter', liveKey as string);
        const ack = await client.enchant(bundle);
        expect(ack).toMatchObject({ id: 'enc_l1ve01', stored: true });

        const answers: Array<{ enc: string; q: string; a: string }> = [];
        client.queryResultHandler = (qr) => answers.push(qr);

        // Acorda pela frase e faz a pergunta (STT injetado; a rota é determinística).
        sim!.write('WAKE Appa');
        await new Promise((r) => setTimeout(r, 400));
        sim!.write('VOICE qual é a minha lista de compras?');
        await new Promise<void>((resolve, reject) => {
            const t = setTimeout(() => reject(new Error('QUERY_RESULT nao chegou (60s)')), 60_000);
            const poll = setInterval(() => {
                if (answers.length > 0) {
                    clearTimeout(t);
                    clearInterval(poll);
                    resolve();
                }
            }, 200);
        });
        expect(answers[0].enc).toBe('enc_l1ve01');
        expect(answers[0].a.length).toBeGreaterThan(10);

        client.close();
    });
});
