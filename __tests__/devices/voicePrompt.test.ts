/**
 * voicePrompt — o encantamento de voz deve carregar CONTEXTO (descrição +
 * capacidades + dados), falar o IDIOMA do usuário (código BCP-47) e deixar claro
 * que é um assistente que recebe COMANDO FALADO e responde em voz alta.
 */

jest.mock('../../lib/api/openrouter', () => ({ chat: jest.fn() }));
jest.mock('../../lib/api/keyStorage', () => ({ getOpenRouterKey: jest.fn(async () => 'sk-test') }));
jest.mock('../../lib/api/modelPreferences', () => ({ getPreferredModel: jest.fn(async () => 'test/model') }));

import { chat } from '../../lib/api/openrouter';
import { transmuteApp, extractTextFromHtml } from '../../lib/devices/transmute';
import { generateVoiceEnchantment } from '../../lib/devices/voicePrompt';

const chatMock = chat as unknown as jest.Mock;

describe('voicePrompt — contexto, idioma e enquadramento de voz', () => {
    beforeEach(() => chatMock.mockReset());

    test('envia descrição, capacidades, dataKeys e o código BCP-47', async () => {
        chatMock.mockResolvedValue({ choices: [{ message: { content: '{"prompt":"p","keywords":["a"]}' } }] });
        const out = await generateVoiceEnchantment(
            {
                id: 7,
                name: 'CheckList da Casa',
                description: 'Organiza as tarefas de manutenção da casa.',
                requiredCapabilities: ['AI', 'Notify'],
            },
            ['tarefas'],
        );
        expect(out.prompt).toBe('p');
        expect(out.keywords).toEqual(['a']);

        const sent = chatMock.mock.calls[0][0].messages[0].content as string;
        expect(sent).toContain('Organiza as tarefas de manutenção da casa.');
        expect(sent).toContain('Capacidades usadas: AI, Notify');
        expect(sent).toContain('Dados que ela guarda (localStorage): tarefas');
        expect(sent).toContain('código BCP-47 desse idioma é "en"');
        expect(sent).toContain('COMANDO FALADO');
        expect(sent).not.toContain('português do Brasil');
    });

    test('usa o texto do HTML como descrição quando shortDescription falta', async () => {
        chatMock.mockResolvedValue({ choices: [{ message: { content: '{"prompt":"p","keywords":[]}' } }] });
        await generateVoiceEnchantment(
            {
                id: 8,
                name: 'Compras',
                code: '<html><head><style>.x{color:red}</style><script>var a=1;</script></head><body><h1>Lista de compras</h1><p>Arroz e café</p></body></html>',
            },
            [],
        );
        const sent = chatMock.mock.calls[0][0].messages[0].content as string;
        expect(sent).toContain('Lista de compras');
        expect(sent).toContain('Arroz e café');
        // descrição é TEXTO extraído (sem tags)…
        const descLine = sent.split('\n').find((l) => l.startsWith('Descrição/contexto')) ?? '';
        expect(descLine).not.toContain('<h1>');
        // …e o CÓDIGO agora via como contexto dos dataSchemas (com tags mesmo).
        expect(sent).toContain('Código-fonte da spell');
        expect(sent).toContain('var a=1');
    });
});

describe('transmute fallback — sem IA ainda carrega descrição e idioma', () => {
    test('fallbackPrompt/Keywords incluem descrição e o código BCP-47', async () => {
        const r = await transmuteApp(
            { id: 9, name: 'Agenda', description: 'Guarda compromissos.' },
            {},
        );
        expect(r.promptGeneratedByAI).toBe(false);
        expect(r.bundle.prompt).toContain('Guarda compromissos.');
        expect(r.bundle.prompt).toContain('código BCP-47');
        expect(r.bundle.prompt).toContain('comando');
        expect(r.bundle.manifest.keywords).toEqual(
            expect.arrayContaining(['agenda', 'guarda', 'compromissos']),
        );
    });
});

describe('extractTextFromHtml', () => {
    test('remove script/style/tags e colapsa espaços', () => {
        const text = extractTextFromHtml(
            '<div><style>p{}</style><script>x()</script>  Olá   <b>mundo</b> <!-- c --> &amp; fim</div>',
        );
        expect(text).toBe('Olá mundo & fim');
    });
});
