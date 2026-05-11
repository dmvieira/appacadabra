/**
 * Metamorphic AI Quality Tests
 * ============================================================
 * O que são testes metamórficos?
 * Em vez de verificar uma saída exata (impossível para IA generativa),
 * verificamos RELAÇÕES entre saídas: se a mesma entrada produz resultados
 * estruturalmente válidos em múltiplas execuções, e se variações de entrada
 * produzem as transformações esperadas no output.
 *
 * Os testes chamam as MESMAS funções de produção (generators.ts) — qualquer
 * mudança nos prompts, modelos ou pipeline quebra automaticamente os testes.
 *
 * Como rodar:
 *   cd firebase/functions && npm test -- --testPathPattern=ai-quality
 *
 * O que uma falha em cada grupo significa:
 *   1. Criacao – Validade estrutural: HTML sintaticamente inválido ou com erros
 *      que codeValidator/executionValidator detectam na primeira passagem (sem fix loop).
 *   2. Criacao – Capability: modelo não honra a capability solicitada, gerando
 *      código que ignora a API nativa disponível.
 *   3. Edicao – Preservacao de contexto: modelo está destruindo elementos existentes
 *      ao editar (regressão grave de UX).
 *   4. Edicao – Adicionar capability: modelo não consegue introduzir uma capability
 *      nova em código que não a usava.
 *   5. Edicao – Idempotencia: pedidos de não-alteração modificam estrutura do app.
 *   6. WebView AI – JSON estruturado: modelo não respeita o json_schema solicitado,
 *      quebrando apps que dependem de structured output.
 *   7. WebView AI – Busca online: ferramenta de search não está sendo usada ou não
 *      produz resultados com dados reais (cotação deve ser um decimal válido).
 *
 * Onde encontrar os HTMLs/JSONs gerados:
 *   firebase/functions/src/__tests__/ai-quality/results/
 *   (pasta ignorada pelo git — só existe localmente)
 */

import OpenAI from 'openai';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';

import { OR_BASE_URL } from '../../config';
import {
    generateSpellCreate,
    generateSpellEdit,
    generateWebviewAI,
} from '../../generators';

// ============================================================
// Config
// ============================================================

jest.setTimeout(600_000);

const RUNS_CREATION = 3;
const RUNS_EDIT = 2;
const RUNS_WEBVIEW = 3;

const APP_VERSION = '2.0.2';
const RESULTS_DIR = path.join(__dirname, 'results');

// ============================================================
// Fixtures (apps simples sem capabilities)
// ============================================================

const COUNTER_FIXTURE = [
    '<html><head><style>',
    'body{margin:0;padding:16px;font-family:sans-serif;}',
    'button{background:blue;color:white;padding:8px 16px;border:none;border-radius:4px;}',
    '#output{margin-top:16px;font-size:18px;}',
    '</style></head><body>',
    '<h2>Contador</h2>',
    '<button id="btn" onclick="increment()">Incrementar</button>',
    '<div id="output">0</div>',
    '<script>let count=0;function increment(){count++;document.getElementById(\'output\').textContent=count;}</script>',
    '</body></html>',
].join('');

const RANDOM_NUMBER_FIXTURE = [
    '<html><head><style>',
    'body{margin:0;padding:16px;font-family:sans-serif;}',
    'button{background:#4CAF50;color:white;padding:8px 16px;border:none;border-radius:4px;}',
    '#result{margin-top:16px;font-size:24px;font-weight:bold;}',
    '</style></head><body>',
    '<h2>Gerador de Número Aleatório</h2>',
    '<button onclick="generate()">Gerar</button>',
    '<div id="result">-</div>',
    '<script>function generate(){document.getElementById(\'result\').textContent=Math.floor(Math.random()*100)+1;}</script>',
    '</body></html>',
].join('');

// ============================================================
// API key resolution (síncrono — deve rodar antes de qualquer describe)
// ============================================================

let OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY ?? '';
if (!OPENROUTER_API_KEY) {
    try {
        OPENROUTER_API_KEY = execSync(
            'firebase functions:secrets:access OPENROUTER_API_KEY --project appacadabra-bee0f',
            { cwd: path.join(__dirname, '../../../../..'), encoding: 'utf8' }
        ).trim();
    } catch (_e) {
        console.warn('Não foi possível obter OPENROUTER_API_KEY do Firebase. Pulando testes.');
    }
}

// ============================================================
// Helpers
// ============================================================

function saveResult(name: string, content: string, ext = 'html'): string {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filePath = path.join(RESULTS_DIR, `${name}-${timestamp}.${ext}`);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function makeOrClient(): OpenAI {
    return new OpenAI({ apiKey: OPENROUTER_API_KEY, baseURL: OR_BASE_URL });
}

function formatErrors(errors: Array<{ type: string; message: string }>): string {
    return errors.map(e => `[${e.type}] ${e.message}`).join('\n');
}

// ============================================================
// Describe gate: skip all suites when no API key
// ============================================================

const runTests = (suiteName: string, fn: () => void) => {
    if (!OPENROUTER_API_KEY) {
        describe.skip(suiteName + ' (sem OPENROUTER_API_KEY)', fn);
    } else {
        describe(suiteName, fn);
    }
};

// ============================================================
// Suite 1: Criacao — Validade estrutural
// ============================================================

runTests('Criacao — Validade estrutural', () => {
    const prompt = 'calculadora simples com histórico de operações';

    for (let run = 1; run <= RUNS_CREATION; run++) {
        test(`run ${run}/${RUNS_CREATION}: HTML gerado deve ser válido sem fix loop`, async () => {
            const result = await generateSpellCreate(prompt, APP_VERSION, makeOrClient());

            saveResult('creation-valid', result.html);

            if (!result.html) throw new Error(`Run ${run}: nenhum HTML foi extraído da resposta do modelo`);
            if (!result.html.includes('<html')) throw new Error(`Run ${run}: HTML não contém tag <html`);
            if (!result.html.includes('<head')) throw new Error(`Run ${run}: HTML não contém tag <head`);
            if (!result.html.includes('<body')) throw new Error(`Run ${run}: HTML não contém tag <body`);

            if (result.initialValidationErrors.length > 0) {
                throw new Error(
                    `Run ${run}: codeValidator/executionValidator encontrou ${result.initialValidationErrors.length} erro(s) na primeira passagem (fix loop foi necessário):\n` +
                    formatErrors(result.initialValidationErrors)
                );
            }
        });
    }
});

// ============================================================
// Suite 2: Criacao — Uso correto de capability
// ============================================================

// A capability de Audio só tem gravação de voz e TTS — NÃO há player de músicas locais.
const capabilityCases: Array<{ prompt: string; capability: string; description: string }> = [
    {
        prompt: 'app de agenda que busca contatos por nome e exibe a lista de resultados',
        capability: 'AppacadabraContacts',
        description: 'busca de contatos',
    },
    {
        prompt: 'app gravador de voz: botão gravar, botão parar, reproduz o áudio gravado em um elemento <audio>',
        capability: 'AppacadabraAudio',
        description: 'gravação de áudio',
    },
    {
        prompt: 'app que abre a câmera, tira uma foto e exibe a imagem na tela',
        capability: 'AppacadabraCamera',
        description: 'câmera',
    },
];

runTests('Criacao — Uso correto de capability', () => {
    for (const { prompt, capability, description } of capabilityCases) {
        for (let run = 1; run <= RUNS_EDIT; run++) {
            test(`[${capability}] run ${run}/${RUNS_EDIT}: HTML deve usar a capability (${description})`, async () => {
                const result = await generateSpellCreate(prompt, APP_VERSION, makeOrClient());

                saveResult(`creation-capability-${capability.toLowerCase()}`, result.html);

                if (!result.html) throw new Error(`Run ${run} [${capability}]: nenhum HTML extraído`);

                if (!result.html.includes(capability)) {
                    const found = ['AppacadabraContacts', 'AppacadabraAudio', 'AppacadabraCamera',
                        'AppacadabraShare', 'AppacadabraNotify', 'AppacadabraSensors']
                        .filter(c => result.html.includes(c)).join(', ') || 'nenhuma';
                    throw new Error(
                        `Run ${run}: modelo não usou ${capability} para "${description}".\n` +
                        `Capabilities presentes: ${found}`
                    );
                }

                if (result.initialValidationErrors.length > 0) {
                    throw new Error(
                        `Run ${run} [${capability}]: fix loop necessário — ${result.initialValidationErrors.length} erro(s):\n` +
                        formatErrors(result.initialValidationErrors)
                    );
                }
            });
        }
    }
});

// ============================================================
// Suite 3: Edicao — Preservacao de contexto
// ============================================================

runTests('Edicao — Preservacao de contexto', () => {
    const instruction = 'muda a cor do botão para vermelho';

    for (let run = 1; run <= RUNS_EDIT; run++) {
        test(`run ${run}/${RUNS_EDIT}: elementos existentes devem ser preservados e botão deve ficar vermelho`, async () => {
            const result = await generateSpellEdit(
                { currentCode: COUNTER_FIXTURE, instruction },
                APP_VERSION,
                makeOrClient(),
            );

            saveResult('edit-context-preservation', result.html);

            if (!result.html) throw new Error(`Run ${run}: nenhum HTML retornado pela edição`);
            if (!result.html.includes('id="btn"')) throw new Error(`Run ${run}: id="btn" foi removido após edição`);
            if (!result.html.includes('id="output"')) throw new Error(`Run ${run}: id="output" foi removido após edição`);
            if (!result.html.includes('increment')) throw new Error(`Run ${run}: função increment() foi removida após edição`);

            const hasRedColor =
                /background(-color)?\s*:\s*red\b/.test(result.html) ||
                /background(-color)?\s*:\s*#[fF][0-9a-fA-F]{2,5}\b/.test(result.html) ||
                /background(-color)?\s*:\s*rgb\s*\(\s*25[0-5]/.test(result.html);

            if (!hasRedColor) {
                throw new Error(`Run ${run}: botão não ficou vermelho — nenhum padrão de cor vermelha no CSS.`);
            }

            if (result.initialValidationErrors.length > 0) {
                throw new Error(
                    `Run ${run}: fix loop necessário — ${result.initialValidationErrors.length} erro(s):\n` +
                    formatErrors(result.initialValidationErrors)
                );
            }
        });
    }
});

// ============================================================
// Suite 4: Edicao — Adicionar capability nova
// ============================================================

runTests('Edicao — Adicionar capability nova', () => {
    const instruction =
        'adiciona um botão "Compartilhar" que compartilha o número gerado usando a capability de share nativa do Appacadabra';

    for (let run = 1; run <= RUNS_EDIT; run++) {
        test(`run ${run}/${RUNS_EDIT}: AppacadabraShare deve aparecer após edição`, async () => {
            if (RANDOM_NUMBER_FIXTURE.includes('AppacadabraShare')) {
                throw new Error('Pré-condição falhou: fixture já contém AppacadabraShare');
            }

            const result = await generateSpellEdit(
                { currentCode: RANDOM_NUMBER_FIXTURE, instruction },
                APP_VERSION,
                makeOrClient(),
            );

            saveResult('edit-add-capability', result.html);

            if (!result.html) throw new Error(`Run ${run}: nenhum HTML retornado pela edição`);

            if (!result.html.includes('AppacadabraShare')) {
                const found = ['AppacadabraContacts', 'AppacadabraAudio', 'AppacadabraCamera',
                    'AppacadabraShare', 'AppacadabraNotify', 'AppacadabraSensors']
                    .filter(c => result.html.includes(c)).join(', ') || 'nenhuma';
                throw new Error(
                    `Run ${run}: Modelo não adicionou AppacadabraShare ao editar.\n` +
                    `Capabilities encontradas: ${found}`
                );
            }

            if (result.initialValidationErrors.length > 0) {
                throw new Error(
                    `Run ${run}: fix loop necessário — ${result.initialValidationErrors.length} erro(s):\n` +
                    formatErrors(result.initialValidationErrors)
                );
            }
        });
    }
});

// ============================================================
// Suite 5: Edicao — Idempotencia
// ============================================================

runTests('Edicao — Idempotencia', () => {
    const instruction = 'não mude nada, apenas retorne o código como está';

    for (let run = 1; run <= RUNS_EDIT; run++) {
        test(`run ${run}/${RUNS_EDIT}: estrutura deve ser mantida quando instrução pede não alterar`, async () => {
            const result = await generateSpellEdit(
                { currentCode: COUNTER_FIXTURE, instruction },
                APP_VERSION,
                makeOrClient(),
            );

            saveResult('edit-idempotent', result.html);

            if (!result.html) throw new Error(`Run ${run}: nenhum HTML retornado`);
            if (!result.html.includes('id="btn"')) throw new Error(`Run ${run}: id="btn" removido em edição idempotente`);
            if (!result.html.includes('id="output"')) throw new Error(`Run ${run}: id="output" removido em edição idempotente`);
            if (!result.html.includes('increment')) throw new Error(`Run ${run}: increment() removida em edição idempotente`);

            if (result.initialValidationErrors.length > 0) {
                throw new Error(
                    `Run ${run}: fix loop necessário — ${result.initialValidationErrors.length} erro(s):\n` +
                    formatErrors(result.initialValidationErrors)
                );
            }
        });
    }
});

// ============================================================
// Suite 6: WebView AI — JSON estruturado
// ============================================================

const CHARACTER_SCHEMA = {
    type: 'object',
    properties: {
        name: { type: 'string' },
        class: { type: 'string' },
        level: { type: 'integer' },
        hp: { type: 'integer' },
    },
    required: ['name', 'class', 'level', 'hp'],
};

runTests('WebView AI — JSON estruturado', () => {
    const prompt = 'Gere dados de um personagem fictício para um RPG';

    for (let run = 1; run <= RUNS_WEBVIEW; run++) {
        test(`run ${run}/${RUNS_WEBVIEW}: resposta deve ser JSON válido respeitando o schema`, async () => {
            const result = await generateWebviewAI(
                { prompt, schema: CHARACTER_SCHEMA },
                makeOrClient(),
            );

            saveResult('webview-json', result.text, 'json');

            let parsed: Record<string, unknown>;
            try {
                parsed = JSON.parse(result.text);
            } catch (_e) {
                throw new Error(`Run ${run}: a resposta não é JSON válido:\n${result.text.slice(0, 300)}`);
            }

            for (const field of ['name', 'class', 'level', 'hp']) {
                if (!Object.prototype.hasOwnProperty.call(parsed, field)) {
                    throw new Error(`Run ${run}: campo obrigatório "${field}" ausente. Recebido: ${JSON.stringify(parsed)}`);
                }
            }
            if (typeof parsed['level'] !== 'number') {
                throw new Error(`Run ${run}: "level" deveria ser number, recebeu ${typeof parsed['level']}`);
            }
            if (typeof parsed['hp'] !== 'number') {
                throw new Error(`Run ${run}: "hp" deveria ser number, recebeu ${typeof parsed['hp']}`);
            }
        });
    }
});

// ============================================================
// Suite 7: WebView AI — Busca online (metamórfico)
// ============================================================
//
// Relação metamórfica: com search, o modelo deve retornar uma cotação atual (decimal
// como "5.87"). A resposta com search e sem search devem diferir — busca agrega valor real.

runTests('WebView AI — Busca online (metamorfico)', () => {
    // Pede apenas o número decimal para evitar ruído de texto no assert
    const prompt =
        'Qual a taxa de câmbio atual do dólar americano (USD) para o real brasileiro (BRL)? ' +
        'Responda APENAS com o número decimal, sem texto adicional. Exemplo: 5.87';

    // Uma cotação real parece "5.87" ou "5,87" — decimal com 2-4 casas
    function looksLikeExchangeRate(s: string): boolean {
        return /^\s*\d{1,3}[.,]\d{2,4}\s*$/.test(s.trim());
    }

    test('com search: resposta deve ser uma cotação decimal válida', async () => {
        const result = await generateWebviewAI(
            { prompt, useSearch: true },
            makeOrClient(),
        );

        saveResult('webview-search-with-search', result.text, 'txt');

        if (!looksLikeExchangeRate(result.text)) {
            throw new Error(
                'Resposta com search não parece cotação decimal (esperado ex: "5.87").\n' +
                `Recebido: "${result.text.slice(0, 200)}"`
            );
        }
    });

    test('relacao metamorfica: search deve produzir valor diferente do modo offline', async () => {
        const [resultA, resultB] = await Promise.all([
            generateWebviewAI({ prompt, useSearch: true }, makeOrClient()),
            generateWebviewAI({ prompt, useSearch: false }, makeOrClient()),
        ]);

        saveResult('webview-search-metamorphic-with-search', resultA.text, 'txt');
        saveResult('webview-search-metamorphic-no-search', resultB.text, 'txt');

        if (!looksLikeExchangeRate(resultA.text)) {
            throw new Error(
                'Resposta COM search não parece cotação decimal.\n' +
                `Recebido: "${resultA.text.slice(0, 200)}"`
            );
        }

        if (resultA.text.trim() === resultB.text.trim()) {
            throw new Error(
                'Relação metamórfica falhou: search e no-search retornaram exatamente o mesmo valor.\n' +
                `Com search: "${resultA.text}"\n` +
                `Sem search:  "${resultB.text}"`
            );
        }
    });
});
