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

function mergeJson(base: string, incoming: string): string | null {
    let baseDoc: unknown;
    let incDoc: unknown;
    try {
        baseDoc = JSON.parse(base);
        incDoc = JSON.parse(incoming);
    } catch {
        return null;
    }
    if (typeof baseDoc !== 'object' || baseDoc === null || Array.isArray(baseDoc) ||
        typeof incDoc !== 'object' || incDoc === null || Array.isArray(incDoc)) {
        return null; // merge só faz sentido objeto-para-objeto
    }
    return JSON.stringify({ ...(baseDoc as Record<string, unknown>), ...(incDoc as Record<string, unknown>) });
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

        let error: AppliedMutation['error'] | undefined;
        try {
            if (mu.op === 'set') {
                await set(appId, mu.key, mu.value);
            } else {
                const current = await get(appId, mu.key);
                if (current === null) {
                    // chave inexistente: set simples
                    await set(appId, mu.key, mu.value);
                } else {
                    const merged = mergeJson(current, mu.value);
                    if (merged === null) {
                        error = 'invalid-merge';
                    } else {
                        await set(appId, mu.key, merged);
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
