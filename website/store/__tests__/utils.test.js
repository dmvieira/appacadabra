import { describe, it, expect } from 'vitest';
import { escapeHtml, getSpellMeta, truncate, formatDate, buildDeepLink, parseSpellId } from '../js/utils.js';

describe('escapeHtml', () => {
  it('escapes &', () => expect(escapeHtml('a&b')).toBe('a&amp;b'));
  it('escapes <', () => expect(escapeHtml('<script>')).toBe('&lt;script&gt;'));
  it('escapes >', () => expect(escapeHtml('a>b')).toBe('a&gt;b'));
  it('escapes "', () => expect(escapeHtml('"hello"')).toBe('&quot;hello&quot;'));
  it('handles empty string', () => expect(escapeHtml('')).toBe(''));
  it('coerces number to string', () => expect(escapeHtml(42)).toBe('42'));
  it('coerces null to string', () => expect(escapeHtml(null)).toBe('null'));
  it('leaves safe strings unchanged', () => expect(escapeHtml('Hello World')).toBe('Hello World'));
  it('handles combined XSS payload', () =>
    expect(escapeHtml('<img src="x" onerror="alert(1)">')).toBe(
      '&lt;img src=&quot;x&quot; onerror=&quot;alert(1)&quot;&gt;'
    ));
});

describe('getSpellMeta', () => {
  it('returns translation for exact lang', () => {
    const spell = { translations: { pt: { name: 'Feitiço', description: 'Desc PT' } } };
    const result = getSpellMeta(spell, 'pt');
    expect(result.name).toBe('Feitiço');
    expect(result.description).toBe('Desc PT');
    expect(result.userLang).toBe('pt');
  });

  it('falls back to en when lang not in translations', () => {
    const spell = { translations: { en: { name: 'Spell', description: 'Desc EN' } } };
    const result = getSpellMeta(spell, 'ja');
    expect(result.name).toBe('Spell');
  });

  it('falls back to raw spell fields when no translations', () => {
    const spell = { name: 'Raw Name', description: 'Raw Desc' };
    const result = getSpellMeta(spell, 'en');
    expect(result.name).toBe('Raw Name');
    expect(result.description).toBe('Raw Desc');
  });

  it('exposes originalLang and userLang', () => {
    const spell = { translations: { en: { name: 'X', description: '' } }, originalLang: 'pt' };
    const result = getSpellMeta(spell, 'en');
    expect(result.originalLang).toBe('pt');
    expect(result.userLang).toBe('en');
  });

  it('handles null translations gracefully', () => {
    const spell = { translations: null, name: 'Fallback', description: '' };
    const result = getSpellMeta(spell, 'es');
    expect(result.name).toBe('Fallback');
  });
});

describe('truncate', () => {
  it('returns string unchanged when shorter than max', () =>
    expect(truncate('hi', 10)).toBe('hi'));
  it('returns string unchanged when exactly max', () =>
    expect(truncate('hello', 5)).toBe('hello'));
  it('truncates and appends ellipsis when over max', () =>
    expect(truncate('hello world', 5)).toBe('hello…'));
  it('returns empty string for empty input', () =>
    expect(truncate('', 10)).toBe(''));
  it('returns empty string for null', () =>
    expect(truncate(null, 10)).toBe(''));
  it('returns empty string for undefined', () =>
    expect(truncate(undefined, 10)).toBe(''));
});

describe('formatDate', () => {
  it('returns empty string for null', () => expect(formatDate(null)).toBe(''));
  it('returns empty string for undefined', () => expect(formatDate(undefined)).toBe(''));

  it('handles Firestore timestamp (object with toDate)', () => {
    const ts = { toDate: () => new Date('2024-06-15') };
    const result = formatDate(ts);
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });

  it('handles numeric timestamp (ms)', () => {
    const result = formatDate(new Date('2024-01-01').getTime());
    expect(result).toBeTruthy();
    expect(typeof result).toBe('string');
  });
});

describe('buildDeepLink', () => {
  it('URL-encodes the spellId', () => {
    const link = buildDeepLink('spell/with spaces');
    expect(link).toContain(encodeURIComponent('spell/with spaces'));
  });

  it('includes the app package', () => {
    const link = buildDeepLink('abc123');
    expect(link).toContain('package=ai.appacadabra.app');
  });

  it('uses intent:// scheme', () => {
    const link = buildDeepLink('abc123');
    expect(link.startsWith('intent://')).toBe(true);
  });

  it('includes browser_fallback_url pointing to Play Store', () => {
    const link = buildDeepLink('abc123');
    expect(link).toContain('play.google.com');
  });
});

describe('parseSpellId', () => {
  it('parses id from normal path', () =>
    expect(parseSpellId('/store/abc123/spell-name')).toBe('abc123'));
  it('handles trailing slash', () =>
    expect(parseSpellId('/store/abc123/')).toBe('abc123'));
  it('returns null for path without id segment', () =>
    expect(parseSpellId('/store')).toBeNull());
  it('returns null for empty path', () =>
    expect(parseSpellId('/')).toBeNull());
  it('handles extra path segments', () =>
    expect(parseSpellId('/store/abc123/slug/extra')).toBe('abc123'));
});
