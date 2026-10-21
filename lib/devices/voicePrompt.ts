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

export interface GeneratedEnchantment {
    prompt: string;
    keywords: string[];
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
                    '{"prompt": "...", "keywords": ["...", ...]}.\n\n' +
                    '- "prompt": system prompt de voz, 3 a 6 frases, direto, para fala em alto-falante. O familiar ' +
                    'recebe comandos falados, executa a tarefa sobre os dados e pode registrar mudanças.\n' +
                    '- "keywords": de 5 a 10 palavras/frases CURTAS (1 a 4 palavras cada) que um usuário diria ao ' +
                    'pedir ESTA spell por voz — sinônimos e perguntas típicas.\n' +
                    `- Idioma: escreva o "prompt" E as "keywords" no idioma do usuário. O código BCP-47 desse ` +
                    `idioma é "${lang}".\n\n` +
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
