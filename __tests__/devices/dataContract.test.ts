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
