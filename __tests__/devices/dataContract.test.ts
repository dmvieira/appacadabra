/**
 * Contrato de dados (dataSchemas): validação das mutações de voz contra o
 * schema da spell — append conforme, missing/bad-type/unknown-field, set em
 * array proibido, e permissividade quando a spell não tem contrato.
 */

import { applyMutations, validateAgainstContract } from '../../lib/devices/writeback';
import type { DataSchemas, Mutation } from '../../lib/devices/protocol';

const SCHEMAS: DataSchemas = {
    tarefas: {
        type: 'array',
        item: { required: { titulo: 'string' }, optional: { feito: 'boolean' } },
    },
    prefs: { type: 'object', required: { tema: 'string' }, optional: { som: 'boolean' } },
};

const mu = (over: Partial<Mutation>): Mutation => ({
    id: 'm1', enc: 'enc_000001', key: 'tarefas', op: 'list-append', value: '{}', ts: 0, ...over,
});

function makeIo() {
    const rows = new Map<string, string>();
    return {
        get: async (appId: number, key: string) => rows.get(`${appId}:${key}`) ?? null,
        set: async (appId: number, key: string, value: string) => {
            rows.set(`${appId}:${key}`, value);
        },
        rows,
    };
}

describe('validateAgainstContract', () => {
    test('append conforme passa', () => {
        const errs = validateAgainstContract(
            mu({ value: '{"titulo":"lavar o carro","feito":false}' }),
            SCHEMAS,
        );
        expect(errs).toEqual([]);
    });

    test('tipo errado em obrigatória', () => {
        const errs = validateAgainstContract(mu({ value: '{"titulo":42}' }), SCHEMAS);
        expect(errs).toEqual(['contract:bad-type:titulo']);
    });

    test('campo obrigatório ausente', () => {
        const errs = validateAgainstContract(mu({ value: '{"feito":true}' }), SCHEMAS);
        expect(errs).toEqual(['contract:missing-field:titulo']);
    });

    test('campo desconhecido rejeita (contrato exato)', () => {
        const errs = validateAgainstContract(
            mu({ value: '{"titulo":"x","cor":"azul"}' }),
            SCHEMAS,
        );
        expect(errs).toContain('contract:unknown-field:cor');
    });

    test('set em array é proibido', () => {
        const errs = validateAgainstContract(mu({ op: 'set', value: '[]' }), SCHEMAS);
        expect(errs).toContain('contract:set-array');
    });

    test('list-update: match/patch fora do contrato rejeita', () => {
        const errs = validateAgainstContract(
            mu({ op: 'list-update', value: '{"match":{"cor":"azul"},"patch":{"xx":1}}' }),
            SCHEMAS,
        );
        expect(errs).toContain('contract:unknown-field:cor');
        expect(errs).toContain('contract:unknown-field:xx');
    });

    test('chave sem contrato é permissiva (spells antigas)', () => {
        expect(validateAgainstContract(mu({ key: 'outra' }), SCHEMAS)).toEqual([]);
    });
});

describe('applyMutations com contrato', () => {
    test('mutação fora do contrato é rejeitada e não toca o storage', async () => {
        const io = makeIo();
        await io.set(7, 'tarefas', '[{"titulo":"a"}]');
        const r = await applyMutations(
            7,
            [mu({ id: 'v1', value: '{"titulo":123}' })],
            io,
            SCHEMAS,
        );
        expect(r.rejected).toEqual(['v1']);
        expect(JSON.parse(io.rows.get('7:tarefas')!)).toEqual([{ titulo: 'a' }]);
    });

    test('mutação conforme com contrato aplica normal', async () => {
        const io = makeIo();
        const r = await applyMutations(
            7,
            [mu({ id: 'v2', value: '{"titulo":"b"}' })],
            io,
            SCHEMAS,
        );
        expect(r.accepted).toEqual(['v2']);
    });

    test('reflection: valor corrigido pelo modelo entra no lugar do inválido', async () => {
        const io = makeIo();
        const invalid = mu({ id: 'v3', value: '{"titulo":123}' });
        // o que o reflection devolveria:
        const fixed: Mutation = { ...invalid, value: '{"titulo":"lavar o carro"}' };
        const errs = validateAgainstContract(invalid, SCHEMAS);
        expect(errs.length).toBeGreaterThan(0);
        const errsFix = validateAgainstContract(fixed, SCHEMAS);
        expect(errsFix).toEqual([]);
        const r = await applyMutations(7, [fixed], io, SCHEMAS);
        expect(r.accepted).toEqual(['v3']);
    });
});

import { deriveSchemasFromCode, deriveSchemasFromData } from '../../lib/devices/transmute';
import { sanitizeDataSchemas } from '../../lib/devices/voicePrompt';

describe('derivação determinística de contrato', () => {
    test('dados reais (ground truth): campos em todos os itens = required', () => {
        const io = {
            'tarefas': JSON.stringify([
                { id: 'a', texto: 'x', concluida: false },
                { id: 'b', texto: 'y', concluida: true, prazo: '2026-01-01' },
            ]),
        };
        const s = deriveSchemasFromData(io, ['tarefas']);
        const item = s.tarefas!.item!;
        expect(item.required).toMatchObject({ id: 'string', texto: 'string' });
        expect(item.optional!.prazo).toBe('string');
    });

    test('código da spell: literal push na lista com tipos inferidos', () => {
        const code = `
            function add(texto, dataHora) {
                var novaTarefa = {
                    id: generateId(),
                    texto: texto,
                    concluida: false,
                    dataHora: dataHora,
                    notificationId: null,
                    criadaEm: new Date().toISOString()
                };
                tarefas.push(novaTarefa);
                localStorage.setItem('tarefas', JSON.stringify(tarefas));
            }
        `;
        const s = deriveSchemasFromCode(code, ['tarefas']);
        const item = s.tarefas!.item!;
        // literais/params = required-string por inferência; notificationId
        // (null) = optional
        expect(item.required).toMatchObject({
            id: 'string',
            texto: 'string',
            concluida: 'boolean',
            dataHora: 'string',
            criadaEm: 'string',
        });
        expect(item.optional).toEqual({ notificationId: 'string' });
        expect(item.required.texto).toBe('string');
    });

    test('merge de camadas: dados reais vencem o código', () => {
        const dataDerived = deriveSchemasFromData(
            { tarefas: '[{"id":"a","texto":"x","concluida":false}]' },
            ['tarefas'],
        );
        const codeDerived = deriveSchemasFromCode(
            `tarefas.push({titulo:"x"}); localStorage.setItem('tarefas', JSON.stringify(tarefas));`,
            ['tarefas'],
        );
        const merged = { ...codeDerived, ...dataDerived };
        expect(merged.tarefas!.item!.required).toHaveProperty('texto');
        expect(merged.tarefas!.item!.required).not.toHaveProperty('titulo');
    });
});

describe('sanitizeDataSchemas: dialeto JSON Schema', () => {
    test('converte {items:{properties,required[]}} pro mini-formato', () => {
        const s = sanitizeDataSchemas({
            tarefas: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: { texto: { type: 'string' }, feito: { type: 'boolean' } },
                    required: ['texto'],
                },
            },
        });
        expect(s!.tarefas!.item!.required).toEqual({ texto: 'string' });
        expect(s!.tarefas!.item!.optional).toEqual({ feito: 'boolean' });
    });

    test('objeto com properties/required[]', () => {
        const s = sanitizeDataSchemas({
            prefs: {
                type: 'object',
                properties: { tema: { type: 'string' } },
                required: ['tema'],
            },
        });
        expect(s!.prefs!.required).toEqual({ tema: 'string' });
    });

    test('mini-formato continua funcionando', () => {
        const s = sanitizeDataSchemas({
            tarefas: { type: 'array', item: { required: { titulo: 'string' } } },
        });
        expect(s!.tarefas!.item!.required).toEqual({ titulo: 'string' });
    });
});
