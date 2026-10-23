/**
 * Reflection de mutação fora do contrato: 1 retry. Quando o contrato da spell
 * rejeita a mutação da IA, pede ao MODELO (com o erro exato + o comando
 * falado) uma mutação corrigida — com structured output (json_schema strict)
 * quando o modelo suporta, fallback prompt-JSON quando não. Nunca mais de 1
 * retry; se ainda violar, o caller rejeita de vez.
 */

import { chat } from '../api/openrouter';
import { validateAgainstContract } from './writeback';
import type { DataSchemas, Mutation } from './protocol';

export type ReflectFn = typeof reflectMutation;

/** Chat default: BYOK + modelo do WebView (o mesmo que gerou a mutação). */
export async function reflectMutation(
    model: string,
    apiKey: string,
    args: {
        schemas: DataSchemas;
        key: string;
        op: Mutation['op'];
        value: string;
        utterance?: string;
        errors: string[];
    },
): Promise<{ value: string } | null> {
    const contract = JSON.stringify(args.schemas[args.key] ?? {}, null, 0);
    const schemaShape =
        args.op === 'list-append'
            ? 'o OBJETO do item (mesma forma do contrato)'
            : args.op === 'list-update'
              ? '{"match":{...},"patch":{...}}'
              : 'o objeto/valor conforme o contrato';

    const sys =
        'Você corrige mutações de dados que violaram um contrato. Responda SOMENTE com JSON ' +
        'válido: {"key":"...","op":"...","value":<corrigido>} — sem markdown, sem texto fora do JSON.';

    const user =
        `Contrato da chave "${args.key}": ${contract}\n` +
        `Op exigida: "${args.op}". Forma do value: ${schemaShape}.\n` +
        `Comando falado pelo usuário: ${args.utterance ?? '(não registrado)'}\n` +
        `Mutação rejeitada: ${args.value}\n` +
        `Erros de validação: ${args.errors.join('; ')}\n\n` +
        `Devolva a mutação CORRIGIDA, obedecendo exatamente o contrato.`;

    const response = await chat({
        model,
        messages: [
            { role: 'system', content: sys },
            { role: 'user', content: user },
        ],
        max_tokens: 800,
        // Structured output quando o modelo suporta; modelos sem suporte
        // geralmente ignoram o campo (o parse tolerante abaixo cobre).
        response_format: {
            type: 'json_schema',
            json_schema: {
                name: 'mutation_fix',
                strict: true,
                schema: {
                    type: 'object',
                    properties: {
                        key: { type: 'string' },
                        op: { type: 'string', enum: ['merge', 'set', 'list-append', 'list-update'] },
                        value: {},
                    },
                    required: ['key', 'op', 'value'],
                    additionalProperties: false,
                },
            },
        },
    } as Parameters<typeof chat>[0]);

    const text = (response.choices?.[0]?.message?.content ?? '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    let parsed: { key?: unknown; op?: unknown; value?: unknown };
    try {
        parsed = JSON.parse(text.slice(start, end + 1)) as typeof parsed;
    } catch {
        return null;
    }
    if (typeof parsed.key !== 'string' || typeof parsed.op !== 'string' || parsed.value === undefined) {
        return null;
    }
    const value = typeof parsed.value === 'string' ? parsed.value : JSON.stringify(parsed.value);
    const fixed: Mutation = {
        key: parsed.key,
        op: parsed.op as Mutation['op'],
        value,
        id: '', // o caller preserva o id original
        enc: '',
        ts: 0,
    };
    const errors = validateAgainstContract(fixed, args.schemas);
    if (errors.length > 0) return null; // reflection não resolveu
    return { value };
}
