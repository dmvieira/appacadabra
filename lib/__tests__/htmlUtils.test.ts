import { ensureViewportMeta } from '../htmlUtils';

const CORRECT_VIEWPORT = '<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">';

describe('ensureViewportMeta', () => {
    it('returns HTML unchanged when correct viewport already exists', () => {
        const html = `<html><head>${CORRECT_VIEWPORT}</head><body></body></html>`;
        expect(ensureViewportMeta(html)).toBe(html);
    });

    it('accepts any viewport with width=device-width and initial-scale as already correct', () => {
        const html = '<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0"></head></html>';
        expect(ensureViewportMeta(html)).toBe(html);
    });

    it('replaces incomplete viewport tag (no initial-scale)', () => {
        const html = '<html><head><meta name="viewport" content="width=device-width"></head><body></body></html>';
        const result = ensureViewportMeta(html);
        expect(result).toContain('initial-scale');
        expect(result).not.toContain('content="width=device-width"');
    });

    it('replaces wrong viewport tag entirely', () => {
        const html = '<html><head><meta name="viewport" content="width=1024"></head></html>';
        const result = ensureViewportMeta(html);
        expect(result).toContain('width=device-width');
        expect(result).not.toContain('width=1024');
    });

    it('inserts viewport right after <head> when no viewport exists', () => {
        const html = '<html><head><title>App</title></head><body></body></html>';
        const result = ensureViewportMeta(html);
        expect(result).toContain('<head>\n' + CORRECT_VIEWPORT);
        expect(result).toContain('<title>App</title>');
    });

    it('creates <head> before <body> when no head tag exists', () => {
        const html = '<html><body><p>Hello</p></body></html>';
        const result = ensureViewportMeta(html);
        expect(result).toContain('<head>');
        expect(result).toContain('width=device-width');
        expect(result).toContain('<p>Hello</p>');
    });

    it('prepends viewport at document start as last resort', () => {
        const html = '<p>No head or body</p>';
        const result = ensureViewportMeta(html);
        expect(result.startsWith('<meta name="viewport"')).toBe(true);
        expect(result).toContain('<p>No head or body</p>');
    });

    it('replaces all multiple incorrect viewport tags', () => {
        const html = '<html><head><meta name="viewport" content="width=1024"><meta name="viewport" content="height=768"></head></html>';
        const result = ensureViewportMeta(html);
        const matches = result.match(/<meta[^>]*name\s*=\s*["']viewport["'][^>]*>/gi) ?? [];
        expect(matches.length).toBeGreaterThan(0);
        expect(matches.every(m => m.includes('width=device-width'))).toBe(true);
    });

    it('handles empty string input', () => {
        const result = ensureViewportMeta('');
        expect(result).toContain('viewport');
    });

    it('regression: inserts viewport after uppercase <HEAD> tag (case-insensitive)', () => {
        // Regression guard: the head-insertion path uses a case-insensitive regex,
        // so uppercase or mixed-case <HEAD> must still be detected and have the
        // viewport injected right after it (not fall through to the body/prepend branch).
        const html = '<html><HEAD><title>App</title></HEAD><body><p>Hi</p></body></html>';
        const result = ensureViewportMeta(html);
        expect(result).toContain('width=device-width');
        expect(result).toContain('<HEAD>');
        // Viewport must appear after <HEAD>, before <title>
        const headIdx = result.indexOf('<HEAD>');
        const viewportIdx = result.indexOf('width=device-width');
        const titleIdx = result.indexOf('<title>');
        expect(headIdx).toBeLessThan(viewportIdx);
        expect(viewportIdx).toBeLessThan(titleIdx);
        // Should not have prepended at document start
        expect(result.startsWith('<meta')).toBe(false);
    });
});
