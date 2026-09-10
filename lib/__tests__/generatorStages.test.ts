/**
 * State-machine parity coverage for the reified generator pipeline.
 *
 * These tests exercise `generatorStages.ts` at the transition level: each
 * `nextCreateStage`/`nextEditStage` call must return the correct next state
 * (or `done: true` with the completion payload), and `driveInProcess` must
 * compose them into the same happy path that `generators.ts` produces.
 *
 * The OpenRouter HTTP layer and validators are mocked; the point of these
 * tests is orchestration, not model output.
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

jest.mock('../api/modelPreferences', () => ({
    getPreferredModel: jest.fn(async () => 'deepseek/deepseek-v4-flash'),
}));

import * as openrouter from '../api/openrouter';
import * as codeValidator from '../validators/codeValidator';
import * as execValidator from '../validators/executionValidator';
import {
    initCreateState,
    initEditState,
    nextCreateStage,
    nextEditStage,
    driveInProcess,
} from '../api/generatorStages';
import { MODELS } from '../api/pricing';

const mChat = openrouter.chat as jest.MockedFunction<typeof openrouter.chat>;
const mCodeValidate = codeValidator.validateGeneratedCode as jest.MockedFunction<
    typeof codeValidator.validateGeneratedCode
>;
const mExecValidate = execValidator.validateWithExecution as jest.MockedFunction<
    typeof execValidator.validateWithExecution
>;

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
    mCodeValidate.mockReset();
    mExecValidate.mockReset();
    mCodeValidate.mockReturnValue({ valid: true, errors: [], canRetry: false });
    mExecValidate.mockReturnValue({ valid: true, errors: [], canRetry: false });
});

describe('nextCreateStage', () => {
    it('planner → coder', async () => {
        const plan = { appName: 'x', technicalRequirements: { apis: [] } };
        mChat.mockResolvedValueOnce(chatResponse(JSON.stringify(plan)));

        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        const out = await nextCreateStage(state);

        expect(out.done).toBe(false);
        if (!out.done) {
            expect(out.state.stage).toBe('coder');
            expect(out.state.plan).toMatchObject({ appName: 'x' });
        }
        expect(mChat).toHaveBeenCalledTimes(1);
    });

    it('coder → validate with HTML', async () => {
        const html = '<!DOCTYPE html><html><head><title>t</title></head><body/></html>';
        mChat.mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```'));

        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        const out = await nextCreateStage({ ...state, stage: 'coder', plan: { technicalRequirements: { apis: [] } } });

        expect(out.done).toBe(false);
        if (!out.done) {
            expect(out.state.stage).toBe('validate');
            expect(out.state.html).toContain('<title>t</title>');
        }
    });

    it('validate with no errors → done', async () => {
        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        const out = await nextCreateStage({
            ...state,
            stage: 'validate',
            html: '<!DOCTYPE html><html><head><title>Ok</title></head><body/></html>',
        });

        expect(out.done).toBe(true);
        if (out.done) {
            expect(out.result.kind).toBe('create');
            expect(out.result.appName).toBe('Ok');
        }
    });

    it('validate with fixable errors → fix', async () => {
        mCodeValidate.mockReturnValue({
            valid: false,
            errors: [{ type: 'unknown', message: 'boom', fixable: true } as any],
            canRetry: true,
        });
        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        const out = await nextCreateStage({
            ...state,
            stage: 'validate',
            html: '<html/>',
        });

        expect(out.done).toBe(false);
        if (!out.done) expect(out.state.stage).toBe('fix');
    });

    it('validate exhaustion → throws', async () => {
        mCodeValidate.mockReturnValue({
            valid: false,
            errors: [{ type: 'unknown', message: 'boom', fixable: true } as any],
            canRetry: true,
        });
        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        await expect(
            nextCreateStage({ ...state, stage: 'validate', html: '<html/>', fixAttempt: 2 }),
        ).rejects.toThrow(/App generation failed/);
    });
});

describe('driveInProcess (create happy path)', () => {
    it('runs planner → coder → validate → complete', async () => {
        const plan = { appName: 'Calc', technicalRequirements: { apis: [] } };
        const html = '<!DOCTYPE html><html><head><title>Calc</title></head><body/></html>';
        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify(plan), {
                prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0005,
            }))
            .mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```', {
                prompt_tokens: 50, completion_tokens: 100, total_tokens: 150, cost: 0.002,
            }));

        const seen: string[] = [];
        const result = await driveInProcess(
            await initCreateState({ prompt: 'a calculator', appVersion: '3.0.0' }),
            nextCreateStage,
            { onState: (s) => seen.push(s.stage) },
        );

        expect(mChat).toHaveBeenCalledTimes(2);
        expect(result.appName).toBe('Calc');
        expect(result.usage.totalTokens).toBe(180);
        expect(seen).toEqual(expect.arrayContaining(['coder', 'validate']));
    });

    it('retries the whole attempt on network error, up to MAX_OUTER_ATTEMPTS', async () => {
        // First outer attempt: planner throws. Second attempt succeeds.
        const plan = { appName: 'x', technicalRequirements: { apis: [] } };
        const html = '<!DOCTYPE html><html><head><title>x</title></head><body/></html>';
        mChat
            .mockRejectedValueOnce(new Error('boom'))
            .mockResolvedValueOnce(chatResponse(JSON.stringify(plan)))
            .mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```'));

        const result = await driveInProcess(
            await initCreateState({ prompt: 'p', appVersion: '3.0.0' }),
            nextCreateStage,
        );
        expect(result.appName).toBe('x');
    });
});

describe('driveInProcess cost accounting', () => {
    // Same guard as WebView AI: prefer OpenRouter's reported usage.cost when
    // present and > 0 (already accounts for web search + reasoning fees), and
    // fall back to per-token pricing otherwise. Regression bar for the
    // "criação/edição não conta custo" fix.
    it('sums usage.cost from each chat call into result.costUsd', async () => {
        const plan = { appName: 'x', technicalRequirements: { apis: [] } };
        const html = '<!DOCTYPE html><html><head><title>x</title></head><body/></html>';
        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify(plan), {
                prompt_tokens: 10, completion_tokens: 20, total_tokens: 30, cost: 0.0005,
            }))
            .mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```', {
                prompt_tokens: 50, completion_tokens: 100, total_tokens: 150, cost: 0.002,
            }));

        const result = await driveInProcess(
            await initCreateState({ prompt: 'p', appVersion: '3.0.0' }),
            nextCreateStage,
        );
        expect(result.costUsd).toBeCloseTo(0.0025, 6);
    });

    it('falls back to per-token calc when no chat call reports a cost', async () => {
        const plan = { appName: 'x', technicalRequirements: { apis: [] } };
        const html = '<!DOCTYPE html><html><head><title>x</title></head><body/></html>';
        // usage object without a `cost` field — accUsage should treat as 0.
        mChat
            .mockResolvedValueOnce(chatResponse(JSON.stringify(plan), {
                prompt_tokens: 1000, completion_tokens: 2000, total_tokens: 3000,
            }))
            .mockResolvedValueOnce(chatResponse('```html\n' + html + '\n```', {
                prompt_tokens: 3000, completion_tokens: 5000, total_tokens: 8000,
            }));

        const result = await driveInProcess(
            await initCreateState({ prompt: 'p', appVersion: '3.0.0' }),
            nextCreateStage,
        );
        // deepseek-v4-flash: 0.14 in / 0.28 out per M tokens.
        // (4000/1M)*0.14 + (7000/1M)*0.28 = 0.00056 + 0.00196 = 0.00252
        expect(result.costUsd).toBeCloseTo(0.00252, 6);
        expect(result.costUsd).toBeGreaterThan(0);
    });
});

describe('nextEditStage', () => {
    it('planner → patch', async () => {
        const plan = { changes: [{ op: 'replace' }] };
        mChat.mockResolvedValueOnce(chatResponse(JSON.stringify(plan)));

        const state = await initEditState({
            currentCode: '<html><body>orig</body></html>',
            instruction: 'change text',
            appVersion: '3.0.0',
        });
        const out = await nextEditStage(state);

        expect(out.done).toBe(false);
        if (!out.done) expect(out.state.stage).toBe('patch');
    });
});

describe('raceTimeout error shape', () => {
    // Issue #1 / #2 fix: pipeline timeouts and DB tears must both hit the
    // localized "aborted" modal, not the raw unknown-code fallback.
    it('rejects with .code = byok.error.aborted on timeout', async () => {
        jest.useFakeTimers();
        // chat never resolves — race against the 480s timeout.
        mChat.mockImplementation(() => new Promise(() => {}));
        const state = await initCreateState({ prompt: 'p', appVersion: '3.0.0' });
        const pending = nextCreateStage(state);
        jest.advanceTimersByTime(481_000);
        const captured = await pending.catch(e => e);
        expect(captured).toBeInstanceOf(Error);
        expect((captured as Error & { code?: string }).code).toBe('byok.error.aborted');
        expect((captured as Error).message).toMatch(/Timeout/);
        jest.useRealTimers();
    });
});
