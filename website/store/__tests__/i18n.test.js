import { describe, it, expect } from 'vitest';

Object.defineProperty(globalThis, 'navigator', {
  value: { language: 'en' },
  configurable: true,
});

const { t, lang, STORE_STRINGS } = await import('../js/store-i18n.js');

const LOCALES = Object.keys(STORE_STRINGS);
const EN_KEYS = Object.keys(STORE_STRINGS['en']);
const FUNCTION_KEYS = EN_KEYS.filter(k => typeof STORE_STRINGS['en'][k] === 'function');
const STRING_KEYS = EN_KEYS.filter(k => typeof STORE_STRINGS['en'][k] === 'string');

describe('store-i18n — locale completeness', () => {
  for (const locale of LOCALES) {
    it(`${locale}: has all en keys`, () => {
      for (const key of EN_KEYS) {
        expect(
          STORE_STRINGS[locale][key],
          `${locale}.${key} is missing`
        ).toBeDefined();
      }
    });

    it(`${locale}: no string key is empty`, () => {
      for (const key of STRING_KEYS) {
        const val = STORE_STRINGS[locale][key];
        expect(
          typeof val === 'string' && val.length > 0,
          `${locale}.${key} is empty or not a string`
        ).toBe(true);
      }
    });

    it(`${locale}: function keys return non-empty strings`, () => {
      for (const key of FUNCTION_KEYS) {
        const fn = STORE_STRINGS[locale][key];
        expect(typeof fn, `${locale}.${key} should be a function`).toBe('function');
        const result = fn('English');
        expect(typeof result, `${locale}.${key}('English') should return string`).toBe('string');
        expect(result.length, `${locale}.${key}('English') should not be empty`).toBeGreaterThan(0);
      }
    });
  }
});

describe('store-i18n — t() function', () => {
  it('returns string for every en key', () => {
    for (const key of STRING_KEYS) {
      expect(typeof t(key)).toBe('string');
    }
  });

  it('resolves function keys to strings', () => {
    for (const key of FUNCTION_KEYS) {
      const val = t(key, 'English');
      expect(typeof val).toBe('string');
      expect(val.length).toBeGreaterThan(0);
    }
  });

  it('falls back for unknown key without throwing', () => {
    expect(() => t('nonExistentKey_xyz')).not.toThrow();
    expect(typeof t('nonExistentKey_xyz')).toBe('string');
  });

  it('lang export is a string', () => {
    expect(typeof lang).toBe('string');
  });
});
