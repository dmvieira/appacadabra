/**
 * Write-back: aplica mutações que o Familiar enfileirou (WRITEBACK do
 * protocolo appa) no app_storage da spell de origem.
 *
 * `op: "merge"` faz merge objeto-para-objeto (chaves novas ganham, escalares
 * e arrays sobrescrevem — decisão v0.1 documentada); `op: "set"` substitui a
 * chave inteira. Valores são strings JSON (app_storage é TEXT).
 */

import type { Mutation } from './protocol';
import { getStorageItem, setStorageItem } from '../database/db';

function parseJson(s: string): unknown {
    try {
        return JSON.parse(s);
    } catch {
        return undefined;
    }
}

function mergeJson(base: string, incoming: string): string | null {
    const baseDoc = parseJson(base);
    const incDoc = parseJson(incoming);
    if (typeof baseDoc !== 'object' || baseDoc === null || Array.isArray(baseDoc) ||
        typeof incDoc !== 'object' || incDoc === null || Array.isArray(incDoc)) {
        return null; // merge só faz sentido objeto-para-objeto
    }
    return JSON.stringify({ ...(baseDoc as Record<string, unknown>), ...(incDoc as Record<string, unknown>) });
}

/**
 * list-append: anexa UM item na lista. Conflito-proof: a lista existente é
 * preservada — o item entra no fim (edições do app nos outros itens ficam).
 * Lista inexistente é criada com o item.
 */
function listAppend(base: string | null, itemJson: string): string | null {
    const item = parseJson(itemJson);
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return null;
    const list = base === null ? [] : parseJson(base);
    if (!Array.isArray(list)) return null; // chave existe e não é lista: nunca substitui
    return JSON.stringify([...list, item]);
}

/**
 * list-update: altera UM item da lista (match por campo + patch de campos).
 * Item não encontrado = erro (não cria às cegas).
 */
function listUpdate(base: string, specJson: string): string | null {
    const list = parseJson(base);
    if (!Array.isArray(list)) return null;
    const spec = parseJson(specJson);
    if (typeof spec !== 'object' || spec === null) return null;
    const { match, patch } = spec as { match?: Record<string, unknown>; patch?: Record<string, unknown> };
    if (!match || typeof match !== 'object' || !patch || typeof patch !== 'object') return null;
    const idx = list.findIndex((it) => {
        if (typeof it !== 'object' || it === null) return false;
        return Object.entries(match).every(([k, v]) => (it as Record<string, unknown>)[k] === v);
    });
    if (idx < 0) return null;
    const item = { ...list[idx] as Record<string, unknown>, ...patch };
    const out = [...list];
    out[idx] = item;
    return JSON.stringify(out);
}

export interface AppliedMutation {
    id: string;
    ok: boolean;
    error?: 'unknown-key' | 'invalid-merge';
}

/**
 * Applies mutations to the spell's app_storage. Returns per-mutation results
 * so the caller can build a WRITEBACK_ACK with accepted/rejected.
 */
export async function applyMutations(
    appId: number,
    mutations: Mutation[],
    io: { get?: typeof getStorageItem; set?: typeof setStorageItem } = {},
): Promise<{ accepted: string[]; rejected: string[]; applied: AppliedMutation[] }> {
    const get = io.get ?? getStorageItem;
    const set = io.set ?? setStorageItem;

    const accepted: string[] = [];
    const rejected: string[] = [];
    const applied: AppliedMutation[] = [];

    const seen = new Set<string>();
    for (const mu of mutations) {
        if (!mu || typeof mu.id !== 'string' || !mu.id || seen.has(mu.id)) continue;
        seen.add(mu.id);

        // Carimbo de data: ts do device em epoch SECONDS (hora do app via
        // SET_CONFIG); sem hora confiável, usa a hora local do app.
        const tsMs = mu.ts > 1577836800 ? mu.ts * 1000 : Date.now();
        let error: AppliedMutation['error'] | undefined;
        try {
            if (mu.op === 'set') {
                await set(appId, mu.key, mu.value, tsMs);
            } else if (mu.op === 'list-append') {
                const current = await get(appId, mu.key);
                const next = listAppend(current, mu.value);
                if (next === null) {
                    error = 'invalid-merge';
                } else {
                    await set(appId, mu.key, next, tsMs);
                }
            } else if (mu.op === 'list-update') {
                const current = await get(appId, mu.key);
                if (current === null) {
                    error = 'unknown-key';
                } else {
                    const next = listUpdate(current, mu.value);
                    if (next === null) {
                        error = 'invalid-merge';
                    } else {
                        await set(appId, mu.key, next, tsMs);
                    }
                }
            } else {
                const current = await get(appId, mu.key);
                if (current === null) {
                    // chave inexistente: set simples
                    await set(appId, mu.key, mu.value, tsMs);
                } else {
                    const merged = mergeJson(current, mu.value);
                    if (merged === null) {
                        error = 'invalid-merge';
                    } else {
                        await set(appId, mu.key, merged, tsMs);
                    }
                }
            }
        } catch {
            error = 'invalid-merge';
        }

        if (error) {
            rejected.push(mu.id);
            applied.push({ id: mu.id, ok: false, error });
        } else {
            accepted.push(mu.id);
            applied.push({ id: mu.id, ok: true });
        }
    }
    return { accepted, rejected, applied };
}
