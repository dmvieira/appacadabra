export function escapeHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function getSpellMeta(spell, lang) {
  const t = spell.translations;
  const meta = (t && t[lang]) || (t && t['en']) || { name: spell.name, description: spell.description };
  return { name: meta.name, description: meta.description, originalLang: spell.originalLang, userLang: lang };
}

export function truncate(str, max) {
  if (!str) return '';
  return str.length > max ? str.slice(0, max) + '…' : str;
}

export function formatDate(ts) {
  if (!ts) return '';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function buildDeepLink(spellId) {
  const playUrl = 'https://play.google.com/store/apps/details?id=ai.appacadabra.app';
  return `intent://store?spellId=${encodeURIComponent(spellId)}#Intent;scheme=appacadabra;package=ai.appacadabra.app;S.browser_fallback_url=${encodeURIComponent(playUrl)};end`;
}

export function parseSpellId(pathname) {
  return pathname.replace(/\/$/, '').split('/')[2] || null;
}
