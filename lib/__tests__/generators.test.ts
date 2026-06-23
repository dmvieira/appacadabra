/**
 * Happy-path coverage for the client-side generator pipeline.
 *
 * We mock the OpenRouter HTTP layer (`lib/api/openrouter.chat`) and feed
 * synthetic planner + coder responses. The validators (`codeValidator`,
 * `executionValidator`) are mocked to a "valid" verdict so the fix loop
 * never runs — that's the happy path. Failure / fix-loop coverage stays
 * in the validator-specific tests; here we only verify the orchestration:
 *   1. planner is called first with the planner system prompt,
 *   2. coder is called second with the plan injected,
 *   3. usage is accumulated across both calls,
 *   4. result returns the extracted HTML.
 */

jest.mock('../api/openrouter', () => ({
    chat: jest.fn(),
}));

jest.mock('../validators/codeValidator', () => ({
    validateGeneratedCode: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
    generateFixPrompt: jest.fn(() => 'fix this'),
}));

jest.mock('../validators/executionValidator', () => ({
    validateWithExecution: jest.fn(() => ({ valid: true, errors: [], canRetry: false })),
}));

jest.mock('../capabilities', () => ({
    ALL_CAPABILITIES: [],
}));

import * as openrouter from '../api/openrouter';
import {
    generateSpellCreate,
    generateSpellEdit,
    generateConvert,
    generateWebviewAI,
} from '../api/generators';
import { MODELS } from '../api/pricing';

const mChat = openrouter.chat as jest.MockedFunction<typeof openrouter.chat>;

function chatResponse(content: string, usage?: any) {
    return {
        id: 'cmpl_test',
        model: MODELS.SPELL_S,
        choices: [
            {
                index: 0,
                message: { role: 'assistant', content },
                finish_reason: 'stop',
            },
        ],
        usage: usage ?? {
            prompt_tokens: 100,
            completion_tokens: 200,
            total_tokens: 300,
            cost: 0.0012,
        },
    } as any;
}

beforeEach(() => {
    mChat.mockReset();
});

describe('generateSpellCreate (happy path)', () => {
    it('runs planner then coder, returns valid HTML, accumulates usage', async () => {
        const plan = {
            appName: 'Calculator',
            technicalRequirements: { apis: [] },
            uiLayout: 'single screen',
        };
        const html = `<!DOCTYPE html>\n<html><head><title>Calculator</title></head><body><div>OK</div></body></html>`;

        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify(plan), {
                prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0005,
            }))
            .mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```', {
                prompt_tokens: 50, completion_tokens: 80, total_tokens: 130, cost: 0.001,
            }));

        const result = await generateSpellCreate({
            prompt: 'a calculator',
            appVersion: '2.0.15',
        });

        expect(mChat).toHaveBeenCalledTimes(2);
        // Planner first, coder second.
        const [plannerCall, coderCall] = mChat.mock.calls.map(c => c[0]);
        expect(plannerCall.model).toBe(MODELS.SPELL_S);
        // Coder receives the JSON plan inlined into the user message.
        const coderUserContent = coderCall.messages.find(m => m.role === 'user')?.content as string;
        expect(coderUserContent).toContain('Calculator');

        // Usage is summed across both calls.
        expect(result.usage.promptTokens).toBe(60);
        expect(result.usage.responseTokens).toBe(100);
        expect(result.usage.totalTokens).toBe(160);

        expect(result.html).toContain('<title>Calculator</title>');
        expect(result.appName).toBe('Calculator');
        expect(result.initialValidationErrors).toEqual([]);
    });

    it('emits progress events in the expected order', async () => {
        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify({ appName: 'X', technicalRequirements: { apis: [] } })))
            .mockResolvedValueOnce(chatResponse('```html\n<html><body>X</body></html>\n```'));

        const events: string[] = [];
        await generateSpellCreate({
            prompt: 'x',
            appVersion: '2.0.15',
            onProgress: e => events.push(e.type),
        });

        expect(events).toEqual([
            'plan_started',
            'plan_completed',
            'code_started',
            'code_completed',
            'completed',
        ]);
    });
});

describe('generateSpellEdit (happy path)', () => {
    it('runs planner then patcher and applies patches to current code', async () => {
        const editPlan = { summary: 'add header' };
        // Replace line 2 in the input with a new <header> element.
        const patches = {
            changes: [
                { startLine: 2, endLine: 2, content: '<header>New</header>' },
            ],
        };

        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify(editPlan)))
            .mockResolvedValueOnce(chatResponse(JSON.stringify(patches)));

        const result = await generateSpellEdit({
            currentCode: '<html>\n<body>\n</body>\n</html>',
            instruction: 'add a header',
            appVersion: '2.0.15',
        });

        expect(mChat).toHaveBeenCalledTimes(2);
        expect(result.html).toContain('<header>New</header>');
        // Original closing tags survive.
        expect(result.html).toContain('</body>');
        expect(result.initialValidationErrors).toEqual([]);
    });
});

describe('generateConvert (happy path)', () => {
    it('runs a single chat call and returns extracted HTML', async () => {
        const html = '<!DOCTYPE html><html><body>Converted</body></html>';
        mChat.mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```', {
            prompt_tokens: 200, completion_tokens: 300, total_tokens: 500, cost: 0.003,
        }));

        const result = await generateConvert({
            sourceCode: 'export default function App() {}',
            frameworkHint: 'react',
            appVersion: '2.0.15',
        });

        expect(mChat).toHaveBeenCalledTimes(1);
        expect(result.html).toContain('Converted');
        expect(result.usage.totalTokens).toBe(500);
    });
});

describe('generateWebviewAI (happy path)', () => {
    it('returns text + usage for a plain prompt', async () => {
        mChat.mockResolvedValueOnce(chatResponse('the answer is 42'));
        const result = await generateWebviewAI({ prompt: 'what is the answer?' });
        expect(result.text).toBe('the answer is 42');
        expect(result.usage.promptTokens).toBe(100);
        // costUsd prefers the OpenRouter reported usage.cost when > 0.
        expect(result.costUsd).toBe(0.0012);
    });

    it('attaches a json_schema response_format when a schema is supplied', async () => {
        mChat.mockResolvedValueOnce(chatResponse(JSON.stringify({ score: 7 })));
        const out = await generateWebviewAI({
            prompt: 'rate this',
            schema: { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] },
        });
        // text comes back as a re-stringified JSON for downstream callers.
        expect(JSON.parse(out.text)).toEqual({ score: 7 });

        const sent = mChat.mock.calls[0][0] as any;
        expect(sent.extra.response_format.type).toBe('json_schema');
        expect(sent.extra.response_format.json_schema.schema.properties.score).toEqual({ type: 'number' });
    });

    it('includes images as image_url parts in the user message', async () => {
        mChat.mockResolvedValueOnce(chatResponse('described'));
        await generateWebviewAI({ prompt: 'describe', images: ['ZmFrZWltYWdl'] });
        const sent = mChat.mock.calls[0][0] as any;
        const userMsg = sent.messages.find((m: any) => m.role === 'user');
        const parts = userMsg.content as Array<{ type: string }>;
        expect(parts.some(p => p.type === 'image_url')).toBe(true);
    });

    it('adds googleSearch tool + web-search system note when useSearch=true', async () => {
        mChat.mockResolvedValueOnce(chatResponse('answer'));
        await generateWebviewAI({ prompt: 'fresh news', useSearch: true });
        const sent = mChat.mock.calls[0][0] as any;
        // System message with web-search note is prepended only when search is requested.
        const sysMsg = sent.messages.find((m: any) => m.role === 'system');
        expect(typeof sysMsg.content).toBe('string');
        expect(sysMsg.content).toContain('web search');
        // OR_WEB_SEARCH tools are spread into the request.
        expect(Array.isArray(sent.tools)).toBe(true);
        expect(sent.tools.length).toBeGreaterThan(0);
    });
});
