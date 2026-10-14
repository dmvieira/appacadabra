import {
    escapeHtml,
    parseStorePath,
    spellMetaEn,
    toSpellView,
    renderListPage,
    renderSpellPage,
    renderSitemapXml,
    SpellView,
} from '../storeSSR';

const BUCKET = 'appacadabra-bee0f.firebasestorage.app';

function makeView(overrides: Partial<SpellView> = {}): SpellView {
    return {
        id: 'abc123',
        name: 'Pomodoro Timer',
        description: 'A focused little timer',
        slug: 'pomodoro-timer',
        authorName: 'Diogo',
        learnCount: 7,
        publishedIso: '2026-10-01T00:00:00.000Z',
        updatedIso: '2026-10-02T00:00:00.000Z',
        iconUrl: `https://storage.googleapis.com/${BUCKET}/store_icons/abc123/icon.png`,
        previewUrl: null,
        spellUrl: `${'https://appacadabra.ai'}/store/abc123/pomodoro-timer`,
        ...overrides,
    };
}

// ============= escapeHtml =============

describe('escapeHtml', () => {
    it('escapes markup-significant characters', () => {
        expect(escapeHtml(`<img src=x onerror="alert('1')">&`)).toBe(
            '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;',
        );
    });

    it('renders null/undefined as empty string', () => {
        expect(escapeHtml(null)).toBe('');
        expect(escapeHtml(undefined)).toBe('');
    });
});

// ============= parseStorePath =============

describe('parseStorePath', () => {
    it('returns null for the store index', () => {
        expect(parseStorePath('/store')).toBeNull();
        expect(parseStorePath('/store/')).toBeNull();
    });

    it('returns the spell id for detail paths (slug is ignored)', () => {
        expect(parseStorePath('/store/abc123/pomodoro-timer')).toBe('abc123');
        expect(parseStorePath('/store/abc123')).toBe('abc123');
    });

    it('normalizes trailing slashes', () => {
        expect(parseStorePath('/store/abc123/')).toBe('abc123');
    });
});

// ============= spellMetaEn =============

describe('spellMetaEn', () => {
    it('prefers the English translation', () => {
        const spell = { name: 'PT name', translations: { pt: { name: 'PT name' }, en: { name: 'EN name' } } };
        expect(spellMetaEn(spell).name).toBe('EN name');
    });

    it('falls back to the original fields when there is no translations map', () => {
        expect(spellMetaEn({ name: 'Legacy', description: 'Old' })).toEqual({ name: 'Legacy', description: 'Old' });
    });
});

// ============= toSpellView =============

describe('toSpellView', () => {
    it('builds public asset URLs from the storage bucket', () => {
        const view = toSpellView('abc123', {
            name: 'X',
            iconPath: 'store_icons/abc123/icon.png',
            previewImagePath: 'store_previews/abc123/preview.png',
            publishedAt: { toDate: () => new Date('2026-10-01T00:00:00Z') },
        }, BUCKET);
        expect(view.iconUrl).toBe(`https://storage.googleapis.com/${BUCKET}/store_icons/abc123/icon.png`);
        expect(view.previewUrl).toBe(`https://storage.googleapis.com/${BUCKET}/store_previews/abc123/preview.png`);
        expect(view.publishedIso).toBe('2026-10-01T00:00:00.000Z');
    });

    it('falls back to a safe slug and zero learnCount', () => {
        const view = toSpellView('abc123', {}, BUCKET);
        expect(view.slug).toBe('spell');
        expect(view.spellUrl).toBe('https://appacadabra.ai/store/abc123/spell');
        expect(view.learnCount).toBe(0);
    });
});

// ============= renderListPage =============

describe('renderListPage', () => {
    it('renders spell cards with ids used by browse.js hydration', () => {
        const html = renderListPage([makeView()], 'new');
        expect(html).toContain('id="spell-grid"');
        expect(html).toContain('href="https://appacadabra.ai/store/abc123/pomodoro-timer"');
        expect(html).toContain('Pomodoro Timer');
        expect(html).toContain('import { initBrowse } from \'/store/js/browse.js\'');
    });

    it('escapes hostile spell names', () => {
        const view = makeView({ name: '<script>alert(1)</script>' });
        const html = renderListPage([view], 'new');
        expect(html).not.toContain('<script>alert(1)</script>');
        expect(html).toContain('&lt;script&gt;');
        expect(html).toContain('\\u003c');
    });

    it('includes ItemList structured data', () => {
        const html = renderListPage([makeView()], 'popular');
        expect(html).toContain('"@type":"ItemList"');
        expect(html).toContain('data-sort="popular"');
    });
});

// ============= renderSpellPage =============

describe('renderSpellPage', () => {
    it('fills title, OG tags and description', () => {
        const html = renderSpellPage(makeView());
        expect(html).toContain('<title>Pomodoro Timer — Appacadabra Store</title>');
        expect(html).toContain('property="og:title" content="Pomodoro Timer"');
        expect(html).toContain('id="spell-description" class="spell-description">A focused little timer</p>');
        expect(html).toContain('rel="canonical" href="https://appacadabra.ai/store/abc123/pomodoro-timer"');
    });

    it('prefers the preview image for og:image', () => {
        const html = renderSpellPage(makeView({ previewUrl: `https://storage.googleapis.com/${BUCKET}/p.png` }));
        expect(html).toContain('property="og:image" content="https://storage.googleapis.com/appacadabra-bee0f.firebasestorage.app/p.png"');
    });

    it('escapes hostile descriptions inside attributes', () => {
        const view = makeView({ description: '" onerror="alert(1)' });
        const html = renderSpellPage(view);
        expect(html).not.toContain('" onerror="alert(1)');
        expect(html).toContain('&quot; onerror=&quot;alert(1)');
    });

    it('keeps detail.js hydration ids', () => {
        const html = renderSpellPage(makeView());
        for (const id of ['spell-icon', 'spell-name', 'spell-author', 'spell-learn-count', 'spell-description', 'learn-btn', 'preview-frame', 'auth-btn']) {
            expect(html).toContain(`id="${id}"`);
        }
    });

    it('links to the Play Store listing', () => {
        expect(renderSpellPage(makeView())).toContain('https://play.google.com/store/apps/details?id=ai.appacadabra.app');
    });
});

// ============= renderSitemapXml =============

describe('renderSitemapXml', () => {
    it('produces a valid urlset with lastmod', () => {
        const xml = renderSitemapXml([makeView()]);
        expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
        expect(xml).toContain('<loc>https://appacadabra.ai/store/abc123/pomodoro-timer</loc>');
        expect(xml).toContain('<lastmod>2026-10-02T00:00:00.000Z</lastmod>');
    });

    it('escapes hostile slugs', () => {
        const xml = renderSitemapXml([makeView({ slug: 'x"&<y', spellUrl: 'https://appacadabra.ai/store/abc123/x"&<y' })]);
        expect(xml).toContain('&amp;&lt;y');
    });
});
