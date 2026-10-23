/**
 * Write-back: aplica mutações que o Familiar enfileirou (WRITEBACK do
 * protocolo appa) no app_storage da spell de origem.
 *
 * `op: "merge"` faz merge objeto-para-objeto (chaves novas ganham, escalares
 * e arrays sobrescrevem — decisão v0.1 documentada); `op: "set"` substitui a
 * chave inteira. Valores são strings JSON (app_storage é TEXT).
 */

import type { DataSchema, DataSchemas, Mutation } from './protocol';
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

export type ContractError =
    | 'contract:missing-field'
    | 'contract:bad-type'
    | 'contract:unknown-field'
    | 'contract:set-array'
    | 'contract:not-array';

function fieldTypeOk(value: unknown, t: 'string' | 'number' | 'boolean'): boolean {
    if (t === 'string') return typeof value === 'string';
    if (t === 'number') return typeof value === 'number' && Number.isFinite(value);
    return typeof value === 'boolean';
}

function unknownFields(obj: Record<string, unknown>, fields: Record<string, string>): string[] {
    return Object.keys(obj).filter((k) => !(k in fields));
}

/**
 * Valida a mutação contra o contrato da chave. Retorna lista de erros
 * ("contract:<motivo>[:campo]") — vazia quando conforme. Sem contrato para a
 * chave = conforme (permissivo, compatibilidade com spells antigas).
 */
export function validateAgainstContract(
    mu: Pick<Mutation, 'op' | 'key' | 'value'>,
    schemas: DataSchemas | undefined,
): string[] {
    const schema: DataSchema | undefined = schemas?.[mu.key];
    if (!schema) return [];
    const value = parseJson(mu.value);
    if (value === undefined) return ['contract:bad-type'];

    if (mu.op === 'set' && schema.type === 'array') return ['contract:set-array'];

    if (mu.op === 'list-append' || mu.op === 'list-update') {
        const itemSpec = schema.item;
        if (!itemSpec) return ['contract:bad-type'];

        if (mu.op === 'list-append') {
            if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['contract:bad-type'];
            const errors: string[] = [];
            const required = itemSpec.required ?? {};
            const optional = itemSpec.optional ?? {};
            const all = { ...required, ...optional };
            for (const [k, t] of Object.entries(required)) {
                if (!(k in value)) errors.push(`contract:missing-field:${k}`);
                else if (!fieldTypeOk((value as Record<string, unknown>)[k], t)) errors.push(`contract:bad-type:${k}`);
            }
            for (const [k, t] of Object.entries(optional)) {
                if (k in value && !fieldTypeOk((value as Record<string, unknown>)[k], t)) errors.push(`contract:bad-type:${k}`);
            }
            for (const k of unknownFields(value as Record<string, unknown>, all)) errors.push(`contract:unknown-field:${k}`);
            return errors;
        }

        // list-update: value = {match:{...}, patch:{...}}
        if (typeof value !== 'object' || value === null) return ['contract:bad-type'];
        const { match, patch } = value as { match?: unknown; patch?: unknown };
        const errors: string[] = [];
        const required = itemSpec.required ?? {};
        const optional = itemSpec.optional ?? {};
        const all = { ...required, ...optional };
        if (typeof match === 'object' && match !== null) {
            for (const [k, t] of Object.entries(match as Record<string, unknown>)) {
                if (!(k in all)) errors.push(`contract:unknown-field:${k}`);
                else if (!fieldTypeOk(t, all[k])) errors.push(`contract:bad-type:${k}`);
            }
        }
        if (typeof patch === 'object' && patch !== null) {
            for (const [k, t] of Object.entries(patch as Record<string, unknown>)) {
                if (!(k in all)) errors.push(`contract:unknown-field:${k}`);
                else if (!fieldTypeOk(t, all[k])) errors.push(`contract:bad-type:${k}`);
            }
        }
        return errors;
    }

    // merge / set em objeto
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return ['contract:bad-type'];
    const required = schema.required ?? {};
    const optional = schema.optional ?? {};
    const all = { ...required, ...optional };
    const errors: string[] = [];
    const obj = value as Record<string, unknown>;
    for (const [k, t] of Object.entries(all)) {
        if (k in obj && !fieldTypeOk(obj[k], t)) errors.push(`contract:bad-type:${k}`);
    }
    for (const k of unknownFields(obj, all)) errors.push(`contract:unknown-field:${k}`);
    if (mu.op === 'set') {
        for (const k of Object.keys(required)) {
            if (!(k in obj)) errors.push(`contract:missing-field:${k}`);
        }
    }
    return errors;
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
    error?: 'unknown-key' | 'invalid-merge' | 'contract';
    /** Detalhe dos erros de contrato ("contract:missing-field:titulo,..."). */
    detail?: string;
}

/**
 * Applies mutations to the spell's app_storage. Returns per-mutation results
 * so the caller can build a WRITEBACK_ACK with accepted/rejected.
 */
export async function applyMutations(
    appId: number,
    mutations: Mutation[],
    io: { get?: typeof getStorageItem; set?: typeof setStorageItem } = {},
    schemas?: DataSchemas,
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
        // CONTRATO: fora do schema da spell = rejeita (o caller pode tentar o
        // reflection antes; aqui é a porta final que protege a spell).
        const contractErrors = validateAgainstContract(mu, schemas);
        if (contractErrors.length > 0) {
            rejected.push(mu.id);
            applied.push({ id: mu.id, ok: false, error: 'contract', detail: contractErrors.join(',') });
            continue;
        }
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
