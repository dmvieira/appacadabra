/**
 * Write-back: merge/set/list-append/list-update no app_storage.
 * Cenário-chave (usuário): finaliza tarefa NO APP e adiciona tarefa POR VOZ —
 * as duas mudanças coexistem (lista nunca é substituída inteira por voz).
 */

import { applyMutations } from '../../lib/devices/writeback';
import type { Mutation } from '../../lib/devices/protocol';

type Row = { id: number; appId: number; key: string; value: string; updatedAt?: number };

function makeIo() {
    const rows = new Map<string, Row>();
    let seq = 1;
    const io = {
        get: async (appId: number, key: string) => rows.get(`${appId}:${key}`)?.value ?? null,
        set: async (appId: number, key: string, value: string, updatedAt?: number) => {
            rows.set(`${appId}:${key}`, { id: seq++, appId, key, value, updatedAt });
        },
        rows,
    };
    return io;
}

const mu = (over: Partial<Mutation>): Mutation => ({
    id: 'm1', enc: 'enc_000001', key: 'tarefas', op: 'merge', value: '{}', ts: 0, ...over,
});

describe('writeback: applyMutations', () => {
    test('merge objeto preserva campos fora do patch', async () => {
        const io = makeIo();
        await io.set(7, 'prefs', '{"tema":"escuro","som":true}');
        const r = await applyMutations(7, [mu({ key: 'prefs', op: 'merge', value: '{"som":false}' })], io);
        expect(r.rejected).toEqual([]);
        expect(JSON.parse(io.rows.get('7:prefs')!.value)).toEqual({ tema: 'escuro', som: false });
    });

    test('CENÁRIO: app finaliza tarefa + voz anexa outra — coexistem', async () => {
        const io = makeIo();
        // estado inicial: duas tarefas
        await io.set(7, 'tarefas', JSON.stringify([
            { id: 1, titulo: 'comprar arroz', feito: false },
            { id: 2, titulo: 'regar planta', feito: false },
        ]));
        // 1) USUÁRIO no app finaliza a tarefa 1 (o runner grava no app_storage)
        await io.set(7, 'tarefas', JSON.stringify([
            { id: 1, titulo: 'comprar arroz', feito: true },
            { id: 2, titulo: 'regar planta', feito: false },
        ]));
        // 2) VOZ adiciona "lavar louça" via list-append
        const r = await applyMutations(7, [
            mu({ id: 'v1', op: 'list-append', value: '{"titulo":"lavar louca","feito":false}' }),
        ], io);
        expect(r.rejected).toEqual([]);
        const list = JSON.parse(io.rows.get('7:tarefas')!.value);
        expect(list).toHaveLength(3);
        expect(list[0]).toEqual({ id: 1, titulo: 'comprar arroz', feito: true }); // edição do app viva
        expect(list[2]).toEqual({ titulo: 'lavar louca', feito: false }); // voz anexada
    });

    test('list-update por match aplica patch no item certo', async () => {
        const io = makeIo();
        await io.set(7, 'tarefas', JSON.stringify([
            { id: 1, titulo: 'comprar arroz', feito: false },
            { id: 2, titulo: 'lavar louca', feito: false },
        ]));
        const r = await applyMutations(7, [
            mu({ id: 'v2', op: 'list-update', value: '{"match":{"titulo":"lavar louca"},"patch":{"feito":true}}' }),
        ], io);
        expect(r.rejected).toEqual([]);
        const list = JSON.parse(io.rows.get('7:tarefas')!.value);
        expect(list[0].feito).toBe(false);
        expect(list[1].feito).toBe(true);
    });

    test('list-update sem match é rejeitado (não cria às cegas)', async () => {
        const io = makeIo();
        await io.set(7, 'tarefas', '[{"titulo":"a"}]');
        const r = await applyMutations(7, [
            mu({ id: 'v3', op: 'list-update', value: '{"match":{"titulo":"inexistente"},"patch":{"feito":true}}' }),
        ], io);
        expect(r.accepted).toEqual([]);
        expect(r.rejected).toEqual(['v3']);
    });

    test('lista nova: list-append cria a chave', async () => {
        const io = makeIo();
        const r = await applyMutations(7, [
            mu({ id: 'v4', op: 'list-append', value: '{"titulo":"primeira"}' }),
        ], io);
        expect(r.rejected).toEqual([]);
        expect(JSON.parse(io.rows.get('7:tarefas')!.value)).toEqual([{ titulo: 'primeira' }]);
    });

    test('SEGURANÇA: merge contra array é rejeitado (nunca substitui lista)', async () => {
        const io = makeIo();
        await io.set(7, 'tarefas', '[{"titulo":"a","feito":true}]');
        const r = await applyMutations(7, [
            mu({ id: 'v5', op: 'merge', value: '[{"titulo":"b"}]' }),
        ], io);
        expect(r.rejected).toEqual(['v5']);
        // lista intacta
        expect(JSON.parse(io.rows.get('7:tarefas')!.value)).toEqual([{ titulo: 'a', feito: true }]);
    });

    test('carimbo updated_at: ts do device (segundos) vira ms; sem hora usa agora', async () => {
        const io = makeIo();
        const deviceEpochSec = Math.floor(Date.now() / 1000); // hora do app espelhada no device
        await applyMutations(7, [mu({ id: 'c1', key: 'a', op: 'set', value: '1', ts: deviceEpochSec })], io);
        await applyMutations(7, [mu({ id: 'c2', key: 'b', op: 'set', value: '2', ts: 0 })], io);
        expect(io.rows.get('7:a')!.updatedAt).toBe(deviceEpochSec * 1000);
        expect(io.rows.get('7:b')!.updatedAt).toBeGreaterThan(0);
    });
});
