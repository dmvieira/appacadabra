/**
 * Permissionamento tests: capability map (17 capabilities), transmuteApp
 * (forja real com capabilities + relíquias) e write-back (merge/set no
 * app_storage).
 */

import { CapabilityEntry } from '../../lib/devices/protocol';
import { CAPABILITY_MAP, displayNameToId, mapRequirements } from '../../lib/devices/capabilityMap';
import { transmuteApp, transmuteSpell, validateBundle } from '../../lib/devices/transmute';
import { applyMutations } from '../../lib/devices/writeback';

describe('capabilityMap — as 17 capabilities mapeadas', () => {
    const expectedIds = [
        'clipboard', 'share', 'screen', 'device', 'calendar', 'notify', 'health',
        'contacts', 'sensors', 'ui', 'camera', 'audio', 'forms', 'docs', 'sheets', 'ai', 'mcp',
    ];
    test('cobre exatamente as capabilities do index.ts', () => {
        expect(Object.keys(CAPABILITY_MAP).sort()).toEqual([...expectedIds].sort());
    });

    test('display names normalizam para ids', () => {
        expect(displayNameToId('Sheets')).toBe('sheets');
        expect(displayNameToId('AI')).toBe('ai');
        expect(displayNameToId('Health')).toBe('health');
        expect(displayNameToId('MCP')).toBe('mcp');
        expect(displayNameToId('NãoExiste')).toBeNull();
    });

    test('powers derivam das capabilities granted', () => {
        const r = mapRequirements(['AI', 'Sheets', 'Docs']);
        expect(r.powersToGrant.sort()).toEqual(['google', 'openrouter']);
        expect(r.unsupported).toEqual([]);
        const byId = Object.fromEntries(r.entries.map((e) => [e.id, e]));
        expect(byId.ai).toEqual({ id: 'ai', status: 'granted', powers: ['openrouter'], requires: ['net'] });
        expect(byId.sheets).toEqual({ id: 'sheets', status: 'granted', powers: ['google'], requires: ['net'] });
    });

    test('capabilities device-bound ficam not-supported com motivo', () => {
        const r = mapRequirements(['Camera', 'Contacts', 'Health', 'Notify']);
        expect(r.powersToGrant).toEqual([]);
        expect(r.unsupported.map((u) => u.id).sort()).toEqual(['camera', 'contacts', 'health', 'notify']);
        expect(r.unsupported.every((u) => u.reason)).toBe(true);
    });

    test('entrada duplicada (display name e id) colapsa', () => {
        const r = mapRequirements(['Sheets', 'sheets']);
        expect(r.entries).toHaveLength(1);
    });

    test('desconhecidas são ignoradas silenciosamente', () => {
        expect(mapRequirements(['WarpDrive']).entries).toEqual([]);
    });
});

describe('transmuteSpell v0.2 — capabilities no bundle', () => {
    test('capabilities viajam validadas no manifest', () => {
        const capabilities: CapabilityEntry[] = [
            { id: 'ai', status: 'granted', powers: ['openrouter'], requires: ['net'] },
            { id: 'camera', status: 'not-supported', powers: [], requires: ['camera'] },
        ];
        const bundle = transmuteSpell({
            spellId: 'app_1',
            name: 'Spell',
            prompt: 'p'.repeat(50),
            capabilities,
        });
        expect(bundle.manifest.capabilities).toEqual(capabilities);
        // powers do manifest incluem os das capabilities granted
        expect(bundle.manifest.requiredPowers).toEqual(['openrouter']);
        expect(validateBundle(bundle)).toBeNull();
    });

    test('validação rejeita capabilities malformadas', () => {
        const bad = (capabilities: unknown) =>
            validateBundle({
                manifest: { id: 'enc_ab12cd', spellId: 's', name: 'n', version: 1, requiredPowers: [], createdAt: 0, capabilities: capabilities as CapabilityEntry[] },
                prompt: 'p',
                data: {},
                config: { refreshPolicy: 'manual' },
            });
        expect(bad([{ id: 'BAD-ID', status: 'granted', powers: [], requires: [] }])).toContain('id invalido');
        expect(bad([{ id: 'ai', status: 'maybe', powers: [], requires: [] }])).toContain('status');
        expect(bad([{ id: 'ai', status: 'granted', powers: ['NOT_A_POWER'], requires: [] }])).toContain('poder');
        expect(bad([{ id: 'ai', status: 'granted', powers: [], requires: ['antenna'] }])).toContain('require');
        expect(bad([{ id: 'ai', status: 'granted', powers: [], requires: [] }, { id: 'ai', status: 'granted', powers: [], requires: [] }])).toContain('duplicado');
    });
});

describe('transmuteApp — a forja real', () => {
    test('deriva capabilities, relíquias e prompt de voz', async () => {
        const storage = [
            { id: 1, appId: 7, key: 'tarefas', value: '[{"id":1,"t":"trocar filtro"}]' },
            { id: 2, appId: 7, key: 'notas', value: '"texto"' },
            { id: 3, appId: 7, key: '__interno', value: 'x' },
        ];
        const result = await transmuteApp(
            { id: 7, name: 'Gestão da Casa', requiredCapabilities: ['AI', 'Sheets', 'Camera'] },
            {
                getStorage: async () => storage,
                generatePrompt: async (app, keys) => `Prompt de voz para ${app.name} sobre ${keys.join('/')}`,
                encId: 'enc_forja01',
            },
        );
        expect(result.promptGeneratedByAI).toBe(true);
        expect(result.bundle.manifest.id).toBe('enc_forja01');
        expect(result.bundle.manifest.spellId).toBe('app_7');
        expect(result.bundle.manifest.capabilities).toHaveLength(3);
        expect(result.mapping.powersToGrant).toEqual(['google', 'openrouter']);
        expect(result.mapping.unsupported.map((u) => u.id)).toEqual(['camera']);
        // relíquias: strings do storage, sem chaves internas
        expect(result.bundle.data).toEqual({ tarefas: '[{"id":1,"t":"trocar filtro"}]', notas: '"texto"' });
        expect(result.bundle.prompt).toContain('Gestão da Casa');
        expect(validateBundle(result.bundle)).toBeNull();
    });

    test('sem IA disponível usa fallback prompt e ainda valida', async () => {
        const result = await transmuteApp({ id: 9, name: 'Lista', requiredCapabilities: [] }, { encId: 'enc_forja02' });
        expect(result.promptGeneratedByAI).toBe(false);
        expect(result.bundle.prompt).toContain('Lista');
        expect(result.bundle.manifest.capabilities).toEqual([]);
        expect(validateBundle(result.bundle)).toBeNull();
    });

    test('spell nova sem storage: semeia data das chaves localStorage do código', async () => {
        const code = `<script>
            const t = JSON.parse(localStorage.getItem('tarefas') ?? '[]');
            const cfg = JSON.parse(localStorage.getItem('__snapshot') ?? '{}');
            localStorage.setItem('concluidas', []);
            function f() { return localStorage.getItem('outra'); }
        </script>`;
        const result = await transmuteApp(
            { id: 11, name: 'Tarefa+', code, requiredCapabilities: [] },
            { encId: 'enc_forja04', getStorage: async () => [] },
        );
        // semeia chaves de localStorage com defaults inferidos; __interno fora
        expect(result.bundle.data['tarefas']).toBe('[]');
        expect(result.bundle.data['concluidas']).toBe('{}');
        expect(result.bundle.data['outra']).toBe('{}');
        expect(result.bundle.data['__snapshot']).toBeUndefined();
        // prompt menciona as chaves semeadas -> o protocolo @@APPA engata
        expect(Object.keys(result.bundle.data)).toContain('tarefas');
        expect(validateBundle(result.bundle)).toBeNull();
    });

    test('storage real sobrescreve sementes do código', async () => {
        const code = `localStorage.getItem('tarefas') ?? []`;
        const result = await transmuteApp(
            { id: 12, name: 'L', code, requiredCapabilities: [] },
            { encId: 'enc_forja05', getStorage: async () => [{ id: 1, appId: 12, key: 'tarefas', value: '[{"t":"x"}]' }] },
        );
        expect(result.bundle.data['tarefas']).toBe('[{"t":"x"}]');
    });

    test('prompt IA curto demais cai no fallback', async () => {
        const result = await transmuteApp(
            { id: 10, name: 'X', requiredCapabilities: [] },
            { generatePrompt: async () => 'curto', encId: 'enc_forja03' },
        );
        expect(result.promptGeneratedByAI).toBe(false);
    });
});

describe('writeback — merge/set no app_storage', () => {
    function makeIo(initial: Record<string, string>) {
        const store = new Map(Object.entries(initial));
        return {
            store,
            get: async (appId: number, key: string) => (store.has(key) ? store.get(key)! : null),
            set: async (appId: number, key: string, value: string) => {
                store.set(key, value);
            },
        };
    }

    test('merge mescla objeto-para-objeto', async () => {
        const io = makeIo({ lista: '{"a":1,"b":2}' });
        const r = await applyMutations(
            1,
            [{ id: 'm1', enc: 'enc_x', key: 'lista', op: 'merge', value: '{"b":9,"c":3}', ts: 1 }],
            io,
        );
        expect(r.accepted).toEqual(['m1']);
        expect(JSON.parse(io.store.get('lista')!)).toEqual({ a: 1, b: 9, c: 3 });
    });

    test('set sobrescreve a chave inteira', async () => {
        const io = makeIo({ lista: '{"a":1}' });
        await applyMutations(1, [{ id: 'm1', enc: 'enc_x', key: 'lista', op: 'set', value: '[1,2]', ts: 1 }], io);
        expect(io.store.get('lista')).toBe('[1,2]');
    });

    test('merge em valor escalar é rejeitado; set em chave nova é aceito', async () => {
        const io = makeIo({ escalar: '"texto"' });
        const r = await applyMutations(
            1,
            [
                { id: 'm1', enc: 'e', key: 'escalar', op: 'merge', value: '{"x":1}', ts: 1 },
                { id: 'm2', enc: 'e', key: 'nova', op: 'set', value: '"v"', ts: 2 },
            ],
            io,
        );
        expect(r.accepted).toEqual(['m2']);
        expect(r.rejected).toEqual(['m1']);
        expect(r.applied.find((a) => a.id === 'm1')?.error).toBe('invalid-merge');
        expect(io.store.get('escalar')).toBe('"texto"');
    });

    test('merge em chave inexistente cria; ids duplicados ignorados', async () => {
        const io = makeIo({});
        const r = await applyMutations(
            1,
            [
                { id: 'm1', enc: 'e', key: 'k', op: 'merge', value: '{"a":1}', ts: 1 },
                { id: 'm1', enc: 'e', key: 'k', op: 'set', value: '"dup"', ts: 2 },
            ],
            io,
        );
        expect(r.accepted).toEqual(['m1']);
        expect(io.store.get('k')).toBe('{"a":1}');
    });
});
