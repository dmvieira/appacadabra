/**
 * Encantamento (voice prompt + routing keywords) generation for imbuing —
 * uses the real BYOK OpenRouter pipeline (same chat() the rest of the app
 * uses). Falls back to the static prompt in transmute.ts when no key is
 * configured (user can still imbue).
 */

import { chat } from '../api/openrouter';
import { getPreferredModel } from '../api/modelPreferences';
import { getOpenRouterKey } from '../api/keyStorage';
import { getCurrentLanguage } from '../i18n';
import { extractTextFromHtml, type MinimalSpellApp } from './transmute';
import type { ContractFieldType, DataSchemas } from './protocol';

export interface GeneratedEnchantment {
    prompt: string;
    keywords: string[];
    /** Contrato de dados derivado do código da spell (quando o modelo cooperar). */
    dataSchemas?: DataSchemas;
}

function buildContext(app: MinimalSpellApp, dataKeys: string[], description: string): string {
    const caps = app.requiredCapabilities ?? [];
    return [
        `Nome da spell: ${app.name}`,
        description ? `Descrição/contexto da spell: ${description}` : null,
        dataKeys.length ? `Dados que ela guarda (localStorage): ${dataKeys.join(', ')}` : null,
        caps.length ? `Capacidades usadas: ${caps.join(', ')}` : null,
    ]
        .filter(Boolean)
        .join('\n');
}

/**
 * Gera o encantamento completo: o system prompt de voz e as palavras-chave
 * (frases de exemplo) que o Familiar usa para reconhecer quando aplicar esta
 * spell. Devolve JSON: {"prompt": "...", "keywords": ["...", ...]}.
 */
export async function generateVoiceEnchantment(
    app: MinimalSpellApp,
    dataKeys: string[],
): Promise<GeneratedEnchantment> {
    const key = await getOpenRouterKey();
    if (!key) return { prompt: '', keywords: [] };

    const model = await getPreferredModel('SPELL_S');
    const description = app.description?.trim() || extractTextFromHtml(app.code ?? '');
    const context = buildContext(app, dataKeys, description);
    const lang = getCurrentLanguage();

    const response = await chat({
        model,
        messages: [
            {
                role: 'user',
                content:
                    'Você define COMO um "familiar" de voz — um dispositivo ao lado do usuário que herda esta ' +
                    'spell do Appacadabra — deve se comportar e quando deve ser usado. O familiar recebe um COMANDO ' +
                    'FALADO do usuário, EXECUTA a tarefa correspondente sobre os dados que guarda e RESPONDE em voz ' +
                    'alta, de forma curta e natural para alto-falante. Responda SOMENTE com JSON válido, no formato: ' +
                    '{"prompt": "...", "keywords": ["...", ...], "dataSchemas": {...}}.\n\n' +
                    '- "prompt": system prompt de voz, 3 a 6 frases, direto, para fala em alto-falante. O familiar ' +
                    'recebe comandos falados, executa a tarefa sobre os dados e pode registrar mudanças.\n' +
                    '- "keywords": de 5 a 10 palavras/frases CURTAS (1 a 4 palavras cada) que um usuário diria ao ' +
                    'pedir ESTA spell por voz — sinônimos e perguntas típicas.\n' +
                    `- Idioma: escreva o "prompt" E as "keywords" no idioma do usuário. O código BCP-47 desse ` +
                    `idioma é "${lang}".\n` +
                    `- "dataSchemas": CONTRATO de dados que as mutações de voz devem obedecer, derivado do ` +
                    `código da spell: para cada chave de dado listada no contexto, o tipo ("array" de itens ou ` +
                    `"object") e os campos do item/objeto separados em "required" (a spell PRECISA deles para ` +
                    `renderizar) e "optional" (lidos com default), cada um com seu tipo ("string"|"number"|` +
                    `"boolean"). Ex.: {"tarefas":{"type":"array","item":{"required":{"titulo":"string"},` +
                    `"optional":{"feito":"boolean"}}}}. Só inclua chaves de dado; sem contrato, omita.\n\n` +
                    context +
                    '\n\nSem markdown, sem texto fora do JSON.',
            },
        ],
        max_tokens: 2000,
    });
    const text = (response.choices?.[0]?.message?.content ?? '').trim();
    const jsonStart = text.indexOf('{');
    const jsonEnd = text.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd < jsonStart) {
        // Fallback: trata como prompt puro (modelo ignorou o formato).
        return { prompt: text.replace(/^[`"']+|[`"']+$/g, '').trim(), keywords: [] };
    }
    try {
        const parsed = JSON.parse(text.slice(jsonStart, jsonEnd + 1)) as {
            prompt?: unknown;
            keywords?: unknown;
            dataSchemas?: unknown;
        };
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        const keywords = Array.isArray(parsed.keywords)
            ? parsed.keywords.filter((k): k is string => typeof k === 'string')
            : [];
        const schemas = sanitizeDataSchemas(parsed.dataSchemas);
        return { prompt, keywords, ...(schemas ? { dataSchemas: schemas } : {}) };
    } catch {
        return { prompt: text.replace(/^[`"']+|[`"']+$/g, '').trim(), keywords: [] };
    }
}

/** Valida a forma do mini-schema recebido do modelo (descarta lixo). */
export function sanitizeDataSchemas(raw: unknown): DataSchemas | null {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const out: DataSchemas = {};
    const fieldType = (v: unknown): 'string' | 'number' | 'boolean' | null =>
        v === 'string' || v === 'number' || v === 'boolean' ? v : null;
    const fields = (v: unknown): Record<string, ContractFieldType> | undefined => {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
        const o: Record<string, ContractFieldType> = {};
        for (const [k, fv] of Object.entries(v as Record<string, unknown>)) {
            const t = fieldType(fv);
            if (!t || !k) return undefined;
            o[k] = t;
        }
        return Object.keys(o).length ? o : undefined;
    };
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (!key || !val || typeof val !== 'object' || Array.isArray(val)) continue;
        const v = val as Record<string, unknown>;
        const type = v.type === 'array' ? 'array' : v.type === 'object' ? 'object' : null;
        if (!type) continue;
        if (type === 'array') {
            const item = v.item as Record<string, unknown> | undefined;
            const required = fields(item?.required);
            const optional = fields(item?.optional);
            if (!required && !optional) continue;
            out[key] = { type, item: { ...(required ? { required } : {}), ...(optional ? { optional } : {}) } };
        } else {
            const required = fields(v.required);
            const optional = fields(v.optional);
            if (!required && !optional) continue;
            out[key] = { type, ...(required ? { required } : {}), ...(optional ? { optional } : {}) };
        }
    }
    return Object.keys(out).length ? out : null;
}

/** Compat: só o prompt (usado por chamadas antigas). */
export async function generateVoicePrompt(app: MinimalSpellApp, dataKeys: string[]): Promise<string> {
    const gen = await generateVoiceEnchantment(app, dataKeys);
    return gen.prompt;
}
