/**
 * Unit tests for i18n.ts
 */

import i18n, { t, getWebViewTranslations, translations } from '../i18n';

jest.mock('expo-localization', () => ({
    getLocales: () => [{ languageCode: 'en' }]
}));

jest.mock('react-native', () => ({
    I18nManager: {
        allowRTL: jest.fn(),
        isRTL: false,
        forceRTL: jest.fn(),
    }
}));

// Setup i18n for tests
i18n.store(translations);
i18n.locale = 'en';
i18n.defaultLocale = 'en';
i18n.enableFallback = true;

describe('i18n', () => {
    describe('t() translation function', () => {
        it('should return translation for appName', () => {
            const result = t('appName', { locale: 'en' });
            expect(result).toBe('Appacadabra');
        });

        it('should return translation for createApp', () => {
            const result = t('createApp');
            // It could be any language based on device locale, just check it's not empty
            expect(result.length).toBeGreaterThan(0);
        });

        it('should return the key if translation not found', () => {
            const result = t('nonExistentKey');
            // i18n-js returns missing translation format or the key
            expect(result).toContain('nonExistentKey');
        });

        it('should support interpolation', () => {
            const result = t('appReadyNotify', { name: 'Test', locale: 'en' });
            expect(result).toContain('Test');
        });

        it('should have BYOK key-missing translations', () => {
            const title = t('noKeyConfiguredTitle');
            const message = t('noKeyConfiguredFromSpell');

            expect(title.length).toBeGreaterThan(0);
            expect(message.length).toBeGreaterThan(0);
        });
    });

    describe('getWebViewTranslations()', () => {
        it('should return object with WebView-relevant translations', () => {
            const webviewT = getWebViewTranslations();

            expect(typeof webviewT).toBe('object');
            expect(webviewT).toHaveProperty('sharedTextInserted');
            expect(webviewT).toHaveProperty('fileAttached');
        });

        it('should have string values for all keys', () => {
            const webviewT = getWebViewTranslations();

            for (const [key, value] of Object.entries(webviewT)) {
                expect(typeof value).toBe('string');
            }
        });
    });

    describe('Translation keys', () => {
        it('should have app-related translations', () => {
            expect(t('newApp').length).toBeGreaterThan(0);
            expect(t('yourApps').length).toBeGreaterThan(0);
        });

        it('should have action translations', () => {
            expect(t('run').length).toBeGreaterThan(0);
            expect(t('edit').length).toBeGreaterThan(0);
            expect(t('delete').length).toBeGreaterThan(0);
            expect(t('cancel').length).toBeGreaterThan(0);
            expect(t('save').length).toBeGreaterThan(0);
        });

        it('should have error translations', () => {
            expect(t('errorTitle').length).toBeGreaterThan(0);
            expect(t('unknownError').length).toBeGreaterThan(0);
        });

        it('should have backup translations', () => {
            expect(t('exportBackup').length).toBeGreaterThan(0);
            expect(t('importBackup').length).toBeGreaterThan(0);
        });
    });

    describe('MCP keys', () => {
        const LOCALES = ['en', 'pt', 'es', 'fr', 'de', 'it', 'ja', 'zh', 'ko', 'ar', 'hi', 'ru', 'tr', 'nl', 'pl', 'vi', 'th'];
        const MCP_KEYS = Object.keys(translations.en).filter(k => k.startsWith('mcp'));

        it('should define every mcp key in every locale (parity)', () => {
            expect(MCP_KEYS.length).toBeGreaterThanOrEqual(25);
            for (const locale of LOCALES) {
                for (const key of MCP_KEYS) {
                    expect(translations[locale][key]).toBeDefined();
                }
            }
        });

        it('should use %{...} interpolation syntax in parameterized mcp values', () => {
            const parameterized = [
                'mcpToolsCount',
                'mcpConnectTitle',
                'mcpConnectBody',
                'mcpConnectedToast',
                'mcpDisconnectedToast',
                'mcpErrorUnknownServer',
                'mcpErrorMissingArgs',
            ];
            for (const locale of LOCALES) {
                for (const key of parameterized) {
                    const value = translations[locale][key];
                    expect(value).toMatch(/%\{/);
                    // i18n-js only interpolates %{...} or {{...}} — a bare {name}/{count}
                    // would render literally in the UI.
                    expect(value).not.toMatch(/(?<!%)\{(name|count)\}/);
                }
            }
        });

        it('should interpolate mcpConnectTitle and mcpToolsCount', () => {
            expect(t('mcpConnectTitle', { name: 'Notion', locale: 'en' })).toBe('Connect Notion?');
            expect(t('mcpToolsCount', { count: 3, locale: 'en' })).toBe('3 tools');
            for (const locale of LOCALES) {
                const title = t('mcpConnectTitle', { name: 'Notion', locale });
                expect(title).toContain('Notion');
                expect(title).not.toContain('{name}');
                const count = t('mcpToolsCount', { count: 5, locale });
                expect(count).toContain('5');
            }
        });
    });
});
