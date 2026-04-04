import {
    applyPatches,
    extractHtml,
    extractJson,
    fixCallbackPatterns,
    calculateCostUsd,
    computeManaCost,
    sanitizeForFirestore,
    withRetry,
    Patch,
} from '../utils';

// ============= applyPatches =============

describe('applyPatches', () => {
    it('applies a normal single-line patch', () => {
        const src = 'line1\nline2\nline3';
        const result = applyPatches(src, [{ startLine: 2, endLine: 2, content: 'replaced' }]);
        expect(result).toBe('line1\nreplaced\nline3');
    });

    it('applies multiple non-overlapping patches in reverse order', () => {
        const src = 'a\nb\nc\nd';
        const patches: Patch[] = [
            { startLine: 1, endLine: 1, content: 'A' },
            { startLine: 3, endLine: 3, content: 'C' },
        ];
        const result = applyPatches(src, patches);
        expect(result).toBe('A\nb\nC\nd');
    });

    it('skips out-of-bounds patches silently', () => {
        const src = 'line1\nline2';
        const result = applyPatches(src, [{ startLine: 5, endLine: 6, content: 'x' }]);
        expect(result).toBe('line1\nline2');
    });

    it('returns source unchanged for empty patches array', () => {
        const src = 'unchanged';
        expect(applyPatches(src, [])).toBe('unchanged');
    });

    it('replaces a multi-line range with multi-line content', () => {
        const src = 'a\nb\nc';
        const result = applyPatches(src, [{ startLine: 1, endLine: 2, content: 'x\ny\nz' }]);
        expect(result).toBe('x\ny\nz\nc');
    });

    it('normalises CRLF in source and patch content', () => {
        const src = 'a\r\nb\r\nc';
        const result = applyPatches(src, [{ startLine: 2, endLine: 2, content: 'B\r\n' }]);
        // After normalisation the patch content "B\r\n" splits into ["B", ""]
        expect(result).toContain('B');
    });
});

// ============= extractHtml =============

describe('extractHtml', () => {
    it('extracts HTML from ```html fence', () => {
        const input = '```html\n<h1>Hello</h1>\n```';
        expect(extractHtml(input)).toBe('<h1>Hello</h1>');
    });

    it('extracts HTML from plain ``` fence', () => {
        const input = '```\n<p>World</p>\n```';
        expect(extractHtml(input)).toBe('<p>World</p>');
    });

    it('falls back to <!DOCTYPE html> when no fence', () => {
        const input = 'Sure, here it is:\n<!DOCTYPE html>\n<html></html>';
        expect(extractHtml(input)).toBe('<!DOCTYPE html>\n<html></html>');
    });

    it('returns trimmed raw HTML when no fence and no DOCTYPE', () => {
        const input = '  <div>plain</div>  ';
        expect(extractHtml(input)).toBe('<div>plain</div>');
    });

    it('handles truncated fence (no closing ```)', () => {
        const input = '```html\n<h1>Truncated';
        expect(extractHtml(input)).toBe('<h1>Truncated');
    });
});

// ============= extractJson =============

describe('extractJson', () => {
    it('parses JSON inside ```json fence', () => {
        expect(extractJson('```json\n{"key":"value"}\n```')).toEqual({ key: 'value' });
    });

    it('parses raw JSON without fence', () => {
        expect(extractJson('{"a":1}')).toEqual({ a: 1 });
    });

    it('uses last ``` as closing delimiter', () => {
        const input = '```json\n{"msg":"contains ` backtick"}\n```';
        expect(extractJson(input)).toEqual({ msg: 'contains ` backtick' });
    });

    it('repairs literal newlines inside string values', () => {
        const broken = '{"line":"first\nsecond"}';
        expect(extractJson(broken)).toEqual({ line: 'first\nsecond' });
    });

    it('throws when no JSON object is found', () => {
        expect(() => extractJson('no json here')).toThrow();
    });

    it('throws on genuinely malformed JSON', () => {
        expect(() => extractJson('{bad json: true}')).toThrow();
    });
});

// ============= fixCallbackPatterns =============

describe('fixCallbackPatterns', () => {
    it('extracts inline function callback to global window function', () => {
        const html = `<html><body><script>
AppacadabraAI.generate("prompt", function(ok, result) {
  console.log(result);
});
</script></body></html>`;
        const result = fixCallbackPatterns(html);
        expect(result).toContain('window.appCallback_1 = function(ok, result)');
        expect(result).toContain('AppacadabraAI.generate("prompt", "appCallback_1")');
        // The inline callback is no longer passed directly in the API call
        expect(result).not.toContain('AppacadabraAI.generate("prompt", function');
    });

    it('extracts arrow function callback to global window function', () => {
        const html = `<html><body><script>
AppacadabraNotify.request("perm", (ok) => {
  alert(ok);
});
</script></body></html>`;
        const result = fixCallbackPatterns(html);
        expect(result).toContain('window.appCallback_1');
        expect(result).not.toContain('(ok) =>');
    });

    it('returns HTML unchanged when no Appacadabra pattern is present', () => {
        const html = '<html><body><script>console.log("hi");</script></body></html>';
        expect(fixCallbackPatterns(html)).toBe(html);
    });

    it('handles multiple callbacks in the same script block', () => {
        const html = `<html><body><script>
AppacadabraAI.generate("p1", function(ok1, r1) { console.log(r1); });
AppacadabraAI.generate("p2", function(ok2, r2) { console.log(r2); });
</script></body></html>`;
        const result = fixCallbackPatterns(html);
        expect(result).toContain('appCallback_1');
        expect(result).toContain('appCallback_2');
    });
});

// ============= calculateCostUsd =============

describe('calculateCostUsd', () => {
    it('returns 0 for unknown model', () => {
        expect(calculateCostUsd('unknown-model', { promptTokens: 1000, responseTokens: 1000 })).toBe(0);
    });

    it('calculates standard input + output cost', () => {
        // gemini-2.5-flash: 0.30/M input, 2.50/M output
        const cost = calculateCostUsd('gemini-2.5-flash', {
            promptTokens: 1_000_000,
            responseTokens: 1_000_000,
        });
        expect(cost).toBeCloseTo(0.30 + 2.50, 5);
    });

    it('charges thinking tokens at output price', () => {
        const cost = calculateCostUsd('gemini-2.5-flash', {
            promptTokens: 0,
            responseTokens: 0,
            thoughtsTokens: 1_000_000,
        });
        expect(cost).toBeCloseTo(2.50, 5);
    });

    it('charges cached tokens at 25% of input price', () => {
        // 1M cached tokens, 0 non-cached → 1 * 0.30 * 0.25 = 0.075
        const cost = calculateCostUsd('gemini-2.5-flash', {
            promptTokens: 1_000_000,
            responseTokens: 0,
            cachedTokens: 1_000_000,
        });
        expect(cost).toBeCloseTo(0.075, 5);
    });

    it('includes audio input cost', () => {
        // gemini-2.5-flash audioInputPerMToken=1.00
        const cost = calculateCostUsd('gemini-2.5-flash', {
            promptTokens: 0,
            responseTokens: 0,
        }, { audioTokens: 1_000_000 });
        expect(cost).toBeCloseTo(1.00, 5);
    });

    it('includes search query cost', () => {
        // gemini-2.5-flash searchPerQuery=0.035
        const cost = calculateCostUsd('gemini-2.5-flash', {
            promptTokens: 0,
            responseTokens: 0,
        }, { searchQueries: 10 });
        expect(cost).toBeCloseTo(0.35, 5);
    });
});

// ============= computeManaCost =============

describe('computeManaCost', () => {
    it('returns positive mana value for generate type', () => {
        const result = computeManaCost('generate', { prompt: 'hello', images: [], videos: [], audios: [] });
        expect(result.value).toBeGreaterThan(0);
        expect(result.mana).toMatch(/^~/);
    });

    it('returns expected mana for image type with no input images', () => {
        // USD_IMAGE_PER_UNIT=0.04, MANA_VALUE_USD=0.06 → 0.04/0.06 ≈ 0.6667
        const result = computeManaCost('image', { images: [] });
        expect(result.value).toBeCloseTo(0.04 / 0.06, 3);
    });

    it('adds MANA_PER_INPUT_IMAGE for each input image', () => {
        // 2 input images: 0.04/0.06 + 2*0.1
        const result = computeManaCost('image', { images: ['a', 'b'] });
        expect(result.value).toBeCloseTo(0.04 / 0.06 + 0.2, 3);
    });

    it('returns positive mana for video type', () => {
        const result = computeManaCost('video', { images: [] });
        expect(result.value).toBeGreaterThan(0);
    });

    it('returns at least 0.01 mana for audio type', () => {
        const result = computeManaCost('audio', { text: '' });
        expect(result.value).toBeGreaterThanOrEqual(0.01);
    });

    it('returns at least 0.01 mana for similarity type', () => {
        const result = computeManaCost('similarity', { items: ['hello', 'world'] });
        expect(result.value).toBeGreaterThanOrEqual(0.01);
    });

    it('returns default ~1 mana for unknown type', () => {
        const result = computeManaCost('unknown', {});
        expect(result.value).toBe(1.0);
        expect(result.mana).toBe('~1');
    });
});

// ============= sanitizeForFirestore =============

describe('sanitizeForFirestore', () => {
    it('passes through plain primitives', () => {
        expect(sanitizeForFirestore(42)).toBe(42);
        expect(sanitizeForFirestore('text')).toBe('text');
        expect(sanitizeForFirestore(true)).toBe(true);
    });

    it('converts NaN to 0', () => {
        expect(sanitizeForFirestore(NaN)).toBe(0);
    });

    it('converts Infinity to 0', () => {
        expect(sanitizeForFirestore(Infinity)).toBe(0);
    });

    it('returns null for null/undefined', () => {
        expect(sanitizeForFirestore(null)).toBeNull();
        expect(sanitizeForFirestore(undefined)).toBeNull();
    });

    it('passes through plain objects', () => {
        expect(sanitizeForFirestore({ a: 1, b: 'x' })).toEqual({ a: 1, b: 'x' });
    });

    it('rejects class instances', () => {
        class Foo { x = 1; }
        expect(sanitizeForFirestore(new Foo())).toBeNull();
    });

    it('sanitizes arrays recursively', () => {
        expect(sanitizeForFirestore([1, 'a', null])).toEqual([1, 'a', null]);
    });

    it('filters out function values from objects', () => {
        expect(sanitizeForFirestore({ fn: () => {}, val: 1 })).toEqual({ val: 1 });
    });

    it('sanitizes nested plain objects', () => {
        expect(sanitizeForFirestore({ nested: { x: 2 } })).toEqual({ nested: { x: 2 } });
    });

    it('rejects Dates and Maps', () => {
        expect(sanitizeForFirestore(new Date())).toBeNull();
        expect(sanitizeForFirestore(new Map())).toBeNull();
    });
});

// ============= withRetry =============

describe('withRetry', () => {
    it('succeeds on first attempt without any retry', async () => {
        const fn = jest.fn().mockResolvedValue('ok');
        await expect(withRetry(fn)).resolves.toBe('ok');
        expect(fn).toHaveBeenCalledTimes(1);
    });

    it('retries on DEADLINE_EXCEEDED and eventually succeeds', async () => {
        const spy = jest
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((cb: any) => { cb(); return 0 as unknown as NodeJS.Timeout; });

        let calls = 0;
        const fn = async () => {
            if (++calls < 2) throw new Error('DEADLINE_EXCEEDED');
            return 'recovered';
        };

        await expect(withRetry(fn, 1)).resolves.toBe('recovered');
        expect(calls).toBe(2);
        spy.mockRestore();
    });

    it('retries on UNAVAILABLE and eventually succeeds', async () => {
        const spy = jest
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((cb: any) => { cb(); return 0 as unknown as NodeJS.Timeout; });

        let calls = 0;
        const fn = async () => {
            if (++calls < 3) throw new Error('UNAVAILABLE');
            return 'ok';
        };

        await expect(withRetry(fn, 2)).resolves.toBe('ok');
        expect(calls).toBe(3);
        spy.mockRestore();
    });

    it('exhausts all retries and re-throws the last error', async () => {
        const spy = jest
            .spyOn(globalThis, 'setTimeout')
            .mockImplementation((cb: any) => { cb(); return 0 as unknown as NodeJS.Timeout; });

        let calls = 0;
        const fn = async () => { calls++; throw new Error('UNAVAILABLE'); };

        await expect(withRetry(fn, 2)).rejects.toThrow('UNAVAILABLE');
        expect(calls).toBe(3); // 1 initial + 2 retries
        spy.mockRestore();
    });

    it('throws immediately for non-retryable errors without retry', async () => {
        let calls = 0;
        const fn = async () => { calls++; throw new Error('Something went wrong'); };

        await expect(withRetry(fn, 2)).rejects.toThrow('Something went wrong');
        expect(calls).toBe(1);
    });
});
