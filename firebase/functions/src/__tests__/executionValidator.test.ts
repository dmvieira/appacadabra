import { isJsdomFalsePositive, injectAtStart, buildAppacadraMocks } from '../executionValidator';

describe('isJsdomFalsePositive', () => {
    it('returns true for "not implemented" errors', () => {
        expect(isJsdomFalsePositive('Error: not implemented')).toBe(true);
    });

    it('returns true for CSS parse errors', () => {
        expect(isJsdomFalsePositive('Could not parse CSS: vendor-prefix rule')).toBe(true);
    });

    it('returns true for cross-origin errors', () => {
        expect(isJsdomFalsePositive('Blocked by cross-origin policy')).toBe(true);
    });

    it('returns true for SecurityError', () => {
        expect(isJsdomFalsePositive('SecurityError: operation not permitted')).toBe(true);
    });

    it('returns true for JSX token error', () => {
        expect(isJsdomFalsePositive("Unexpected token '<'")).toBe(true);
    });

    it('is case-insensitive', () => {
        expect(isJsdomFalsePositive('NOT IMPLEMENTED')).toBe(true);
        expect(isJsdomFalsePositive('COULD NOT PARSE CSS')).toBe(true);
    });

    it('returns false for real JS runtime errors', () => {
        expect(isJsdomFalsePositive('TypeError: foo is not a function')).toBe(false);
    });

    it('returns false for reference errors', () => {
        expect(isJsdomFalsePositive('ReferenceError: bar is not defined')).toBe(false);
    });

    it('returns false for empty string', () => {
        expect(isJsdomFalsePositive('')).toBe(false);
    });
});

describe('injectAtStart', () => {
    it('injects right after <head> when head tag exists', () => {
        const html = '<html><head><title>Test</title></head><body></body></html>';
        const result = injectAtStart(html, '<script>injected</script>');
        expect(result).toContain('<head><script>injected</script>');
        expect(result).toContain('<title>Test</title>');
    });

    it('injects before first <script> when there is no <head>', () => {
        const html = '<html><body><script>original()</script></body></html>';
        const result = injectAtStart(html, '<script>before</script>');
        const beforeIdx = result.indexOf('<script>before</script>');
        const originalIdx = result.indexOf('<script>original()</script>');
        expect(beforeIdx).toBeLessThan(originalIdx);
    });

    it('prepends to the whole document as last resort', () => {
        const html = '<html><body><p>No head, no script</p></body></html>';
        const result = injectAtStart(html, '<injected>');
        expect(result.startsWith('<injected>')).toBe(true);
    });

    it('works with <head> tag that has attributes', () => {
        const html = '<html><head lang="en"><meta charset="utf-8"></head></html>';
        const result = injectAtStart(html, '<x>');
        expect(result).toContain('<head lang="en"><x>');
    });

    it('preserves the rest of the document intact', () => {
        const html = '<html><head></head><body><p>hello</p></body></html>';
        const result = injectAtStart(html, '<!-- injected -->');
        expect(result).toContain('<p>hello</p>');
    });
});

describe('buildAppacadraMocks', () => {
    it('returns a <script> block', () => {
        const result = buildAppacadraMocks();
        expect(result).toContain('<script>');
        expect(result).toContain('</script>');
    });

    it('includes ReactNativeWebView mock', () => {
        expect(buildAppacadraMocks()).toContain('ReactNativeWebView');
    });

    it('includes AppacadabraAI special mock with callbacks', () => {
        const result = buildAppacadraMocks();
        expect(result).toContain('AppacadabraAI');
        expect(result).toContain('sampleFromSchema');
        expect(result).toContain('makeAIBuilder');
    });

    it('includes all non-AI capabilities as apiProxy', () => {
        const result = buildAppacadraMocks();
        expect(result).toContain('AppacadabraUI');
        expect(result).toContain('AppacadabraForms');
        expect(result).toContain('AppacadabraClipboard');
        expect(result).toContain('AppacadabraCamera');
        expect(result).toContain('AppacadabraAudio');
    });
});
