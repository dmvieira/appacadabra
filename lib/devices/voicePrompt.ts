/**
 * Encantamento (voice prompt + routing keywords) generation for imbuing —
 * uses the real BYOK OpenRouter pipeline (same chat() the rest of the app
 * uses). Falls back to the static prompt in transmute.ts when no key is
 * configured (user can still imbue).
 */

import { chat } from '../api/openrouter';
import { getPreferredModel } from '../api/modelPreferences';
import { getOpenRouterKey } from '../api/keyStorage';
import type { MinimalSpellApp } from './transmute';

export interface GeneratedEnchantment {
    prompt: string;
    keywords: string[];
}

function buildContext(app: MinimalSpellApp, dataKeys: string[]): string {
    return [
        `Nome da spell: ${app.name}`,
        dataKeys.length ? `Dados que ela guarda (localStorage): ${dataKeys.join(', ')}` : null,
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
    const context = buildContext(app, dataKeys);

    const response = await chat({
        model,
        messages: [
            {
                role: 'user',
                content:
                    'Você define COMO um "familiar" de voz — um dispositivo ao lado do usuário que herda esta ' +
                    'spell do Appacadabra — deve se comportar e quando deve ser usado. Responda SOMENTE com JSON ' +
                    'válido, no formato: {"prompt": "...", "keywords": ["...", ...]}.\n\n' +
                    '- "prompt": system prompt de voz em português do Brasil, 3 a 6 frases, direto, para fala em ' +
                    'alto-falante. O familiar responde perguntas sobre os dados e registra mudanças por voz.\n' +
                    '- "keywords": de 5 a 10 palavras/frases CURTAS (1 a 4 palavras cada) que um usuário diria ao ' +
                    'pedir ESTA spell por voz — sinônimos e perguntas típicas (ex.: para uma checklist da casa: ' +
                    '"tarefas", "afazeres", "o que falta", "minha lista", "pendências", "hoje").\n\n' +
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
        };
        const prompt = typeof parsed.prompt === 'string' ? parsed.prompt.trim() : '';
        const keywords = Array.isArray(parsed.keywords)
            ? parsed.keywords.filter((k): k is string => typeof k === 'string')
            : [];
        return { prompt, keywords };
    } catch {
        return { prompt: text.replace(/^[`"']+|[`"']+$/g, '').trim(), keywords: [] };
    }
}

/** Compat: só o prompt (usado por chamadas antigas). */
export async function generateVoicePrompt(app: MinimalSpellApp, dataKeys: string[]): Promise<string> {
    const gen = await generateVoiceEnchantment(app, dataKeys);
    return gen.prompt;
}
