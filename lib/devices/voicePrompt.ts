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

/**
 * Código da spell para o contexto do gerador, truncado com PRIORIDADE às
 * linhas que tocam localStorage/estado (onde mora o contrato de dados).
 * Corta o meio quando passa do teto, preservando começo e fim.
 */
function codeForContext(code: string | undefined, max = 24000): string | null {
    if (!code || !code.trim()) return null;
    if (code.length <= max) return code;
    const lines = code.split('\n');
    const relevant: Array<[number, string]> = [];
    lines.forEach((ln, i) => {
        if (/localStorage|JSON\.(parse|stringify)|\btarefas\b|\bstate\b|\bitems\b|\.push\(|\.map\(/i.test(ln)) {
            relevant.push([i, ln]);
        }
    });
    if (!relevant.length) return code.slice(0, max);
    const picked = new Set<number>();
    for (const [i] of relevant) {
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j++) picked.add(j);
    }
    const idx = [...picked].sort((a, b) => a - b);
    let out = '';
    let prev = -2;
    for (const i of idx) {
        if (i !== prev + 1) out += `\n/* ... */\n`;
        out += lines[i] + '\n';
        prev = i;
        if (out.length > max) break;
    }
    return out;
}

function buildContext(app: MinimalSpellApp, dataKeys: string[], description: string): string {
    const caps = app.requiredCapabilities ?? [];
    const code = codeForContext(app.code);
    return [
        `Nome da spell: ${app.name}`,
        description ? `Descrição/contexto da spell: ${description}` : null,
        dataKeys.length ? `Dados que ela guarda (localStorage): ${dataKeys.join(', ')}` : null,
        caps.length ? `Capacidades usadas: ${caps.join(', ')}` : null,
        // O CÓDIGO é a fonte da verdade dos dataSchemas: derive os contratos
        // dos objetos que a spell escreve nessas chaves.
        code ? `Código-fonte da spell (JS, referência para os dataSchemas):\n\`\`\`js\n${code}\n\`\`\`` : null,
        caps.length ? null : null,
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
                    `"boolean"). Os NOMES DE CAMPO vêm EXCLUSIVAMENTE dos objetos que o código escreve nessas ` +
                    `chaves (ex.: se o código cria {texto: ...}, o campo é "texto" — jamais invente sinonimo). ` +
                    `Formato: {"chave":{"type":"array","item":{"required":{"<campo>":"<tipo>"},` +
                    `"optional":{"<campo>":"<tipo>"}}}}. Só inclua chaves de dado; sem contrato, omita.\n\n` +
                    context +
                    '\n\nSem markdown, sem texto fora do JSON.',
            },
        ],
        max_tokens: 2000,
        response_format: { type: 'json_object' },
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
    // Dialeto JSON Schema: {type:'string'} / {type:'array',items:{...}} com
    // properties+required[] — converte pro mini-formato.
    const jsonSchemaFields = (
        v: Record<string, unknown> | undefined,
    ): Record<string, ContractFieldType> | undefined => {
        const props = v?.properties;
        if (!props || typeof props !== 'object' || Array.isArray(props)) return undefined;
        const reqList = Array.isArray(v?.required) ? (v?.required as unknown[]) : [];
        const o: Record<string, ContractFieldType> = {};
        for (const [k, fv] of Object.entries(props as Record<string, unknown>)) {
            if (!fv || typeof fv !== 'object') continue;
            const t = fieldType((fv as Record<string, unknown>).type);
            if (!t || !k) continue;
            o[k] = t;
        }
        const required: Record<string, ContractFieldType> = {};
        const optional: Record<string, ContractFieldType> = {};
        for (const [k, t] of Object.entries(o)) {
            (reqList.includes(k) ? required : optional)[k] = t;
        }
        return Object.keys(required).length || Object.keys(optional).length
            ? { ...required, ...optional, ...(Object.keys(required).length ? {} : optional) }
            : undefined;
    };
    for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
        if (!key || !val || typeof val !== 'object' || Array.isArray(val)) continue;
        const v = val as Record<string, unknown>;
        const type = v.type === 'array' ? 'array' : v.type === 'object' ? 'object' : null;
        if (!type) continue;
        if (type === 'array') {
            // mini-formato
            const item = v.item as Record<string, unknown> | undefined;
            const miniReq = fields(item?.required);
            const miniOpt = fields(item?.optional);
            if (miniReq || miniOpt) {
                out[key] = {
                    type,
                    item: { ...(miniReq ? { required: miniReq } : {}), ...(miniOpt ? { optional: miniOpt } : {}) },
                };
                continue;
            }
            // dialeto JSON Schema: v.items.{properties,required}
            const items = v.items as Record<string, unknown> | undefined;
            const conv = jsonSchemaFields(items);
            if (conv) {
                const required: Record<string, ContractFieldType> = {};
                const optional: Record<string, ContractFieldType> = {};
                const reqList = Array.isArray(items?.required) ? (items?.required as unknown[]) : [];
                const props = (items?.properties ?? {}) as Record<string, unknown>;
                for (const [k, t] of Object.entries(conv)) {
                    (reqList.includes(k) ? required : optional)[k] = t;
                    void props;
                }
                if (Object.keys(required).length || Object.keys(optional).length) {
                    out[key] = { type, item: { required, optional } };
                }
            }
            continue;
        }
        const required = fields(v.required);
        const optional = fields(v.optional);
        if (required || optional) {
            out[key] = { type, ...(required ? { required } : {}), ...(optional ? { optional } : {}) };
            continue;
        }
        // dialeto JSON Schema em objeto
        const conv = jsonSchemaFields(v as Record<string, unknown>);
        if (conv) {
            const required: Record<string, ContractFieldType> = {};
            const optional: Record<string, ContractFieldType> = {};
            const reqList = Array.isArray(v.required) ? (v.required as unknown[]) : [];
            for (const [k, t] of Object.entries(conv)) {
                (reqList.includes(k) ? required : optional)[k] = t;
            }
            if (Object.keys(required).length || Object.keys(optional).length) {
                out[key] = { type, required, optional };
            }
        }
    }
    return Object.keys(out).length ? out : null;
}

/** Compat: só o prompt (usado por chamadas antigas). */
export async function generateVoicePrompt(app: MinimalSpellApp, dataKeys: string[]): Promise<string> {
    const gen = await generateVoiceEnchantment(app, dataKeys);
    return gen.prompt;
}
