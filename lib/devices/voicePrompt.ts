/**
 * Voice prompt generation for imbuing — uses the real BYOK OpenRouter
 * pipeline (same chat() the rest of the app uses). Falls back to the static
 * prompt in transmute.ts when no key is configured (user can still imbue).
 */

import { chat } from '../api/openrouter';
import { getPreferredModel } from '../api/modelPreferences';
import { getOpenRouterKey } from '../api/keyStorage';
import type { MinimalSpellApp } from './transmute';

export async function generateVoicePrompt(app: MinimalSpellApp, dataKeys: string[]): Promise<string> {
    const key = await getOpenRouterKey();
    if (!key) return ''; // sem chave: transmuteApp usa o fallback estático

    const model = await getPreferredModel('SPELL_S');
    const context = [
        `Nome da spell: ${app.name}`,
        dataKeys.length ? `Dados que ela guarda (localStorage): ${dataKeys.join(', ')}` : null,
    ]
        .filter(Boolean)
        .join('\n');

    const response = await chat({
        model,
        messages: [
            {
                role: 'user',
                content:
                    'Escreva um system prompt de voz (português do Brasil, 3 a 6 frases, direto, para fala em ' +
                    'alto-falante) para um "familiar" — um dispositivo que vive ao lado do usuário e herda esta ' +
                    'spell do Appacadabra. O familiar responde perguntas sobre os dados e registra mudanças por ' +
                    'voz.\n\n' +
                    context +
                    '\n\nDevolva APENAS o texto do prompt, sem títulos, sem aspas, sem markdown.',
            },
        ],
        max_tokens: 2000,
    });
    const text = (response.choices?.[0]?.message?.content ?? '').trim();
    return text.replace(/^[`"']+|[`"']+$/g, '').trim();
}
