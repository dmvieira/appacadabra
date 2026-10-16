/**
 * Coverage for the pure helpers in `generationUtils.ts` that carry error
 * codes the modal reclassification path depends on.
 *
 * Issue #2 fix: an empty AI response used to bubble up as a raw string
 * in the modal because `withRetry` propagated the error without a
 * `.code`. Now `makeRetryableEmptyResponseError` stamps
 * `byok.error.parse` so the modal renders the localized message.
 */

import { makeRetryableEmptyResponseError, withRetry } from '../generationUtils';

describe('makeRetryableEmptyResponseError', () => {
    it('stamps byok.error.parse and retryable=true', () => {
        const err = makeRetryableEmptyResponseError('tool_calls');
        expect((err as Error & { code?: string }).code).toBe('byok.error.parse');
        expect((err as Error & { retryable?: boolean }).retryable).toBe(true);
        expect(err.message).toContain('tool_calls');
    });

    it('handles null/undefined reason by falling back to "unknown"', () => {
        expect(makeRetryableEmptyResponseError(null).message).toContain('unknown');
        expect(makeRetryableEmptyResponseError(undefined).message).toContain('unknown');
    });
});

describe('withRetry', () => {
    it('preserves the error.code on final failure so the modal reclassifies correctly', async () => {
        const err = makeRetryableEmptyResponseError('length');
        const captured = await withRetry(async () => { throw err; }, 1).catch(e => e);
        expect(captured).toBe(err);
        expect((captured as Error & { code?: string }).code).toBe('byok.error.parse');
    });

    it('does not retry non-retryable errors', async () => {
        const err = Object.assign(new Error('boom'), { retryable: false });
        let calls = 0;
        await withRetry(async () => { calls++; throw err; }, 3).catch(() => {});
        expect(calls).toBe(1);
    });
});

describe('boundDebugLogs', () => {
    const bound = require('../generationUtils').boundDebugLogs as (s: string | null | undefined, a?: number, b?: number) => string;

    it('returns empty for null/undefined/empty input', () => {
        expect(bound(null)).toBe('');
        expect(bound(undefined)).toBe('');
        expect(bound('')).toBe('');
        expect(bound('\n \n')).toBe('');
    });

    it('keeps the last N non-empty lines', () => {
        const logs = Array.from({ length: 150 }, (_, i) => `line ${i}`).join('\n');
        const out = bound(logs, 100);
        expect(out.split('\n')).toHaveLength(100);
        expect(out).toContain('line 149');
        expect(out).not.toContain('line 10\n');
    });

    it('caps total size keeping the tail (newest entries)', () => {
        const logs = Array.from({ length: 100 }, () => 'x'.repeat(200)).join('\n'); // 20KB
        const out = bound(logs, 100, 8000);
        expect(out.length).toBeLessThanOrEqual(8000 + 30);
        expect(out).toContain('older lines truncated');
        expect(out.endsWith('xxxx')).toBe(true);
    });
});
