import { generateSlug, sanitizeSpellHtml } from '../utils';

// ============= generateSlug =============

describe('generateSlug', () => {
    it('lowercases and hyphenates a basic name', () => {
        expect(generateSlug('My Cool Spell')).toBe('my-cool-spell');
    });

    it('strips diacritics', () => {
        expect(generateSlug('Fábrica de Sonhos')).toBe('fabrica-de-sonhos');
    });

    it('collapses non-alphanumeric runs to a single hyphen', () => {
        expect(generateSlug('Hello!! World??')).toBe('hello-world');
    });

    it('trims leading and trailing hyphens', () => {
        expect(generateSlug('!!!hello!!!')).toBe('hello');
    });

    it('truncates to 60 chars', () => {
        const long = 'a'.repeat(120);
        expect(generateSlug(long).length).toBeLessThanOrEqual(60);
    });

    it('returns an empty string for purely non-alphanumeric input', () => {
        expect(generateSlug('!!!')).toBe('');
    });
});

// ============= sanitizeSpellHtml =============

describe('sanitizeSpellHtml', () => {
    it('flags unclosed <style> tag (regression: spell j6P8qyl7aBskj8SJhT2a rendered as blank page)', () => {
        const html = '<html><head><style>body{background:#fff;}</head><body><h1>hi</h1></body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('unclosed <style>'))).toBe(true);
    });

    it('does not flag a properly closed <style> tag', () => {
        const html = '<html><head><style>body{background:#fff;}</style></head><body><h1>hi</h1></body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('unclosed <style>'))).toBe(false);
    });

    it('flags unclosed <script> tag', () => {
        const html = '<html><head></head><body><script>console.log(1);</body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('unclosed <script>'))).toBe(true);
    });

    it('does not flag a properly closed <script> tag', () => {
        const html = '<html><head></head><body><script>console.log(1);</script></body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('unclosed <script>'))).toBe(false);
    });

    it('does not flag CDN <script src=> tags (open+close pair, both counted)', () => {
        const html = '<html><head><script src="https://cdn.tailwindcss.com"></script></head><body></body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('unclosed <script>'))).toBe(false);
    });

    it('strips disallowed <script src=> domains', () => {
        const html = '<html><head><script src="https://evil.example.com/x.js"></script></head><body></body></html>';
        const { html: sanitized } = sanitizeSpellHtml(html);
        expect(sanitized).not.toContain('evil.example.com');
    });

    it('keeps allowed CDN <script src=>', () => {
        const html = '<html><head><script src="https://cdnjs.cloudflare.com/ajax/libs/jquery/3.6.0/jquery.min.js"></script></head><body></body></html>';
        const { html: sanitized } = sanitizeSpellHtml(html);
        expect(sanitized).toContain('cdnjs.cloudflare.com');
    });

    it('injects a CSP meta tag inside <head>', () => {
        const html = '<html><head></head><body></body></html>';
        const { html: sanitized } = sanitizeSpellHtml(html);
        expect(sanitized).toContain('Content-Security-Policy');
    });

    it('flags possible API key strings', () => {
        const html = '<html><body>sk-abcdefghijklmnopqrstuvwxyz123456</body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('API key'))).toBe(true);
    });

    it('flags file:// references', () => {
        const html = '<html><body><a href="file:///etc/passwd">x</a></body></html>';
        const { violations } = sanitizeSpellHtml(html);
        expect(violations.some(v => v.includes('file://'))).toBe(true);
    });

    it('strips HTML comments', () => {
        const html = '<html><body><!-- secret --><p>x</p></body></html>';
        const { html: sanitized } = sanitizeSpellHtml(html);
        expect(sanitized).not.toContain('secret');
    });
});
