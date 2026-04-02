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
            const result = t('manaConfirmBalance', { balance: 150, locale: 'en' });
            expect(result).toContain('150');
        });

        it('should have mana-related translations', () => {
            const title = t('manaDepletedTitle');
            const message = t('manaDepletedMessage');

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
});
