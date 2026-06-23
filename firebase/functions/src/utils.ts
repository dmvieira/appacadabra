/**
 * Pure utility functions used by the surviving callables in index.ts.
 * No Firebase or external dependencies — all functions are side-effect-free.
 */

// ============= SPELL STORE HELPERS =============

export function generateSlug(name: string): string {
    return name
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '')
        .slice(0, 60);
}

const SPELL_HTML_ALLOWED_SCRIPT_DOMAINS = [
    'cdnjs.cloudflare.com',
    'cdn.jsdelivr.net',
    'unpkg.com',
    'fonts.googleapis.com',
    'cdn.tailwindcss.com',
];

const SPELL_CSP_META = `<meta http-equiv="Content-Security-Policy" content="default-src 'self' 'unsafe-inline' 'unsafe-eval' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net https://unpkg.com https://fonts.googleapis.com https://fonts.gstatic.com https://cdn.tailwindcss.com; connect-src 'none'; form-action 'none'; navigate-to 'self' blob: data:;">`;

export function sanitizeSpellHtml(html: string): { html: string; violations: string[] } {
    let sanitized = html;
    const violations: string[] = [];

    sanitized = sanitized.replace(/<!--[\s\S]*?-->/g, '');

    sanitized = sanitized.replace(/<script\b[^>]*\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')[^>]*>\s*<\/script>/gi,
        (match, dq, sq) => {
            const src = dq ?? sq ?? '';
            try {
                const url = new URL(src, 'https://placeholder.invalid');
                const host = url.hostname.toLowerCase();
                const allowed = SPELL_HTML_ALLOWED_SCRIPT_DOMAINS.some(
                    d => host === d || host.endsWith('.' + d)
                );
                return allowed ? match : '';
            } catch {
                return '';
            }
        }
    );

    if (/<head\b[^>]*>/i.test(sanitized)) {
        sanitized = sanitized.replace(/<head\b[^>]*>/i, (m) => `${m}\n${SPELL_CSP_META}`);
    } else {
        sanitized = `${SPELL_CSP_META}\n${sanitized}`;
    }

    const apiKeyPatterns = [
        /sk-[A-Za-z0-9]{20,}/g,
        /Bearer\s+[A-Za-z0-9\-._~+/]+=*/g,
    ];
    for (const pattern of apiKeyPatterns) {
        if (pattern.test(sanitized)) {
            violations.push('possible API key or bearer token');
            break;
        }
    }

    if (/file:\/\//i.test(sanitized)) {
        violations.push('file:// URL reference');
    }

    // Unclosed <style> swallows the rest of the document as CSS text → page renders white.
    // Caught a real production bug (spell j6P8qyl7aBskj8SJhT2a "Fábrica de Sonhos") where the
    // edit pipeline dropped </style> and the spell shipped to the store as a blank page.
    const styleOpenCount = (sanitized.match(/<style\b/gi) || []).length;
    const styleCloseCount = (sanitized.match(/<\/style\s*>/gi) || []).length;
    if (styleOpenCount > styleCloseCount) {
        violations.push(`unclosed <style> tag (${styleOpenCount} open, ${styleCloseCount} closed)`);
    }
    const scriptOpenCount = (sanitized.match(/<script\b(?![^>]*\/>)/gi) || []).length;
    const scriptCloseCount = (sanitized.match(/<\/script\s*>/gi) || []).length;
    if (scriptOpenCount > scriptCloseCount) {
        violations.push(`unclosed <script> tag (${scriptOpenCount} open, ${scriptCloseCount} closed)`);
    }

    const dataImageRegex = /data:image\/[a-zA-Z+]+;base64,[A-Za-z0-9+/=]+/g;
    let m: RegExpExecArray | null;
    while ((m = dataImageRegex.exec(sanitized)) !== null) {
        if (m[0].length > 67000) {
            violations.push('inline base64 image larger than 50KB');
            break;
        }
    }

    return { html: sanitized, violations };
}
