import {
  getFirestore, doc, getDoc, collection, query, where, orderBy, limit, getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL }
  from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js';
import { app, auth, getCurrentUser, onAuthChange, requireAuth, signIn } from './auth.js';
import { learnSpell, unpublishSpell } from './api.js';
import { t } from './store-i18n.js';
import { escapeHtml, getSpellMeta, buildDeepLink, parseSpellId } from './utils.js';

const db = getFirestore(app);
const storage = getStorage(app);

function getPlatform() {
  const ua = navigator.userAgent || '';
  if (/iPhone|iPad|iPod/i.test(ua)) return 'ios';
  if (/android/i.test(ua)) return 'android';
  return 'desktop';
}

async function initDetail() {
  const spellId = parseSpellId(location.pathname);

  if (!spellId) { showError('Spell not found.'); return; }

  let spell, spellSnap;
  try {
    spellSnap = await getDoc(doc(db, 'store_spells', spellId));
  } catch (err) {
    showError('Failed to load spell. Please try again.');
    return;
  }

  if (!spellSnap.exists() || spellSnap.data().status !== 'active') {
    showError('Este feitiço foi removido ou não existe.');
    return;
  }

  // Localize static button labels
  const copyBtn = document.getElementById('copy-link-btn');
  const shareBtn = document.getElementById('share-btn');
  const unpublishBtn = document.getElementById('unpublish-btn');
  if (copyBtn) copyBtn.textContent = t('copyLink');
  if (shareBtn) shareBtn.textContent = t('share');
  if (unpublishBtn) unpublishBtn.textContent = t('unpublishBtn');

  spell = spellSnap.data();
  renderSpellMeta(spell, spellId);
  loadPreview(spell.htmlStoragePath);
  setupLearnButton(spellId, spell);
  setupShareButtons(spellId, spell);
  setupOwnerControls(spellId, spell);
  setupAppBanner();
  renderVariantBadge(spell);
  renderVariants(spellId, spell);
}

function renderSpellMeta(spell, spellId) {
  const meta = getSpellMeta(spell, (navigator.language || 'en').split('-')[0]);
  const pageTitle = `${meta.name || 'Spell'} — Appacadabra Store`;
  document.title = pageTitle;
  setText('spell-name', meta.name || 'Untitled');
  if (spell.authorName) {
    setText('spell-author', spell.authorName);
  } else {
    const byline = document.querySelector('.spell-byline');
    if (byline) byline.style.display = 'none';
  }
  setText('spell-learn-count', `${spell.learnCount || 0} ${t('learnCountSuffix')}`);
  setText('spell-description', meta.description || '');

  // Populate OG metadata (improves share previews where JS runs)
  const ogTitle = document.getElementById('og-title');
  if (ogTitle) ogTitle.setAttribute('content', pageTitle);
  const ogDesc = document.getElementById('og-description');
  if (ogDesc) ogDesc.setAttribute('content', meta.description || 'Aprenda este feitiço no Appacadabra.');

  // Show original-language note when the spell was published in a different locale
  if (meta.originalLang && meta.originalLang !== meta.userLang) {
    const langNames = {
      en: 'English', pt: 'Português', es: 'Español', fr: 'Français', de: 'Deutsch',
      it: 'Italiano', ja: '日本語', zh: '中文', ko: '한국어', ar: 'عربي',
      hi: 'हिन्दी', ru: 'Русский', tr: 'Türkçe', nl: 'Nederlands',
      pl: 'Polski', vi: 'Tiếng Việt', th: 'ภาษาไทย',
    };
    const langName = langNames[meta.originalLang] || meta.originalLang.toUpperCase();
    const learnSection = document.querySelector('.learn-section');
    if (learnSection && !learnSection.querySelector('.lang-note')) {
      const note = document.createElement('p');
      note.className = 'lang-note';
      note.textContent = t('langNote', langName);
      learnSection.appendChild(note);
    }
  }

  if (spell.iconPath) {
    getDownloadURL(ref(storage, spell.iconPath))
      .then(url => {
        const img = document.getElementById('spell-icon');
        if (img) img.src = url;
        // Also update og:image once we have the real URL
        let ogImg = document.getElementById('og-image');
        if (!ogImg) {
          ogImg = document.createElement('meta');
          ogImg.id = 'og-image';
          ogImg.setAttribute('property', 'og:image');
          document.head.appendChild(ogImg);
        }
        ogImg.setAttribute('content', url);
      })
      .catch(() => {});
  }
}

async function loadPreview(htmlStoragePath) {
  const frame = document.getElementById('preview-frame');
  const container = document.getElementById('preview-container');
  if (!htmlStoragePath || !frame || !container) return;

  const loader = document.createElement('div');
  loader.className = 'preview-loader';
  loader.setAttribute('aria-hidden', 'true');
  loader.innerHTML = '<div class="preview-spinner"></div>';
  container.appendChild(loader);

  try {
    const url = await getDownloadURL(ref(storage, htmlStoragePath));
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('fetch failed');
    const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
    if (contentLength > 300000) throw new Error('too large');
    const html = await resp.text();
    if (html.length > 300000) throw new Error('too large');
    loader.remove();
    frame.srcdoc = html;
  } catch {
    loader.remove();
    container.innerHTML = `<p class="preview-unavailable">${t('previewUnavailable')}</p>`;
  }
}

function setupLearnButton(spellId, spell) {
  const btn = document.getElementById('learn-btn');
  const statusEl = document.getElementById('learn-status');
  if (!btn) return;

  const platform = getPlatform();
  const learnLabel = () => (platform === 'android' ? t('learnBtnAndroid') : t('learnBtn'));

  btn.textContent = t('learnGuest');

  // Morph the learn button into "Open in app" on Android (deepLink) or into the disabled
  // "Learned" state on iOS (deepLink === null). Replaces the previous pattern of a
  // disabled learn button + separate .btn-open-app injected into #learn-status.
  function setLearnedState(deepLink, justLearned) {
    btn.classList.add('learned');
    if (deepLink) {
      btn.classList.add('open-app');
      btn.textContent = t('openInApp');
      btn.disabled = false;
      btn.dataset.deepLink = deepLink;
    } else {
      btn.classList.remove('open-app');
      btn.textContent = t('learned');
      btn.disabled = true;
      delete btn.dataset.deepLink;
    }
    if (statusEl) {
      statusEl.textContent = justLearned ? t('learnedStatus') : t('alreadyLearnedStatus');
    }
  }

  function setUnlearnedState() {
    btn.classList.remove('learned', 'open-app');
    btn.textContent = learnLabel();
    btn.disabled = false;
    delete btn.dataset.deepLink;
    if (statusEl) statusEl.textContent = '';
  }

  async function checkAlreadyLearned(user) {
    if (!user) {
      const learnSection = document.querySelector('.learn-section');
      if (learnSection) learnSection.style.display = '';
      btn.textContent = t('learnGuest');
      btn.disabled = false;
      btn.classList.remove('learned', 'open-app');
      delete btn.dataset.deepLink;
      return;
    }
    if (user.uid === spell.authorUid) {
      const learnSection = document.querySelector('.learn-section');
      if (learnSection) learnSection.style.display = 'none';
      return;
    }
    try {
      const snap = await getDoc(doc(db, 'users', user.uid, 'learned_spells', spellId));
      if (snap.exists()) {
        const deepLink = platform === 'android' ? buildDeepLink(spellId) : null;
        setLearnedState(deepLink, false);
      } else {
        setUnlearnedState();
      }
    } catch { /* ignore */ }
  }

  async function triggerLearn() {
    btn.disabled = true;
    btn.textContent = t('learning');
    try {
      const result = await learnSpell(spellId);
      const deepLink = platform === 'android' ? buildDeepLink(spellId) : null;
      // alreadyLearned and freshly learned share the same end state; only the microtext differs.
      setLearnedState(deepLink, !result.alreadyLearned);
    } catch (err) {
      btn.textContent = learnLabel();
      btn.disabled = false;
      btn.classList.remove('learned', 'open-app');
      delete btn.dataset.deepLink;
      if (statusEl) statusEl.textContent = t('learnError') + (err.message || t('retryHint'));
    }
  }

  // After redirect-based login, auto-resume pending learn
  onAuthChange(async (user) => {
    checkAlreadyLearned(user);
    if (user && sessionStorage.getItem('pendingLearn') === spellId) {
      sessionStorage.removeItem('pendingLearn');
      triggerLearn();
    }
  });
  checkAlreadyLearned(getCurrentUser());

  btn.addEventListener('click', () => {
    if (btn.disabled) return;
    // Post-learn morph: button now opens the app instead of triggering a learn round-trip.
    if (btn.classList.contains('open-app')) {
      const deepLink = btn.dataset.deepLink;
      if (deepLink) window.location.href = deepLink;
      return;
    }
    const user = getCurrentUser();
    if (!user) {
      sessionStorage.setItem('pendingLearn', spellId);
      signIn();
      return;
    }
    triggerLearn();
  });
}

function setupShareButtons(spellId, spell) {
  const pageUrl = `${location.origin}/store/${spellId}/${spell.slug || 'spell'}`;

  document.getElementById('copy-link-btn')?.addEventListener('click', async () => {
    const btn = document.getElementById('copy-link-btn');
    try {
      await navigator.clipboard.writeText(pageUrl);
      btn.textContent = t('copied');
    } catch {
      const inp = document.createElement('input');
      inp.value = pageUrl;
      document.body.appendChild(inp);
      inp.select();
      document.execCommand('copy');
      document.body.removeChild(inp);
      btn.textContent = t('copied');
    }
    setTimeout(() => { btn.textContent = t('copyLink'); }, 2000);
  });

  document.getElementById('share-btn')?.addEventListener('click', () => {
    const shareTitle = getSpellMeta(spell).name || 'Spell';
    if (navigator.share) {
      navigator.share({ title: shareTitle, url: pageUrl }).catch(() => {});
    } else {
      navigator.clipboard.writeText(pageUrl).catch(() => {});
    }
  });
}

function setupOwnerControls(spellId, spell) {
  const ownerSection = document.getElementById('owner-controls');
  if (!ownerSection) return;

  function checkOwner(user) {
    ownerSection.style.display = (user && user.uid === spell.authorUid) ? 'block' : 'none';
  }

  onAuthChange(checkOwner);
  checkOwner(getCurrentUser());

  document.getElementById('unpublish-btn')?.addEventListener('click', () => {
    showConfirmModal(
      t('unpublishTitle'),
      t('unpublishMsg'),
      async () => {
        try {
          await unpublishSpell(spellId);
          window.location.href = '/store';
        } catch (err) {
          showInlineAlert(ownerSection, t('unpublishError') + (err.message || t('retryHint')));
        }
      }
    );
  });
}

function showConfirmModal(title, message, onConfirm) {
  document.getElementById('confirm-modal')?.remove();

  const overlay = document.createElement('div');
  overlay.id = 'confirm-modal';
  overlay.className = 'confirm-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'confirm-modal-title');
  overlay.innerHTML = `
    <div class="confirm-modal">
      <h2 id="confirm-modal-title" class="confirm-modal-title">${escapeHtml(title)}</h2>
      <p class="confirm-modal-message">${escapeHtml(message)}</p>
      <div class="confirm-modal-actions">
        <button id="confirm-modal-cancel" class="btn-ghost" type="button">Cancelar</button>
        <button id="confirm-modal-ok" class="btn-danger" type="button">Confirmar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  const close = () => overlay.remove();
  overlay.querySelector('#confirm-modal-cancel').addEventListener('click', close);
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  overlay.querySelector('#confirm-modal-ok').addEventListener('click', async () => {
    close();
    await onConfirm();
  });

  overlay.querySelector('#confirm-modal-cancel').focus();
}

function showInlineAlert(container, msg) {
  let el = container.querySelector('.inline-alert');
  if (!el) {
    el = document.createElement('p');
    el.className = 'inline-alert';
    el.setAttribute('role', 'alert');
    container.appendChild(el);
  }
  el.textContent = msg;
}

function setupAppBanner() {
  const platform = getPlatform();
  const ctaBlock = document.getElementById('app-cta-block');

  if (platform === 'ios' && ctaBlock) {
    ctaBlock.innerHTML = `<p>${t('iosFallback')}</p><a href="/" rel="noopener">${t('iosWaitlist')} →</a>`;
    ctaBlock.style.display = '';
  }

  const banner = document.getElementById('app-banner');
  if (!banner) return;
  if (sessionStorage.getItem('app-banner-dismissed')) return;
  if (platform === 'ios') return;

  if (platform === 'android') banner.classList.add('prominent');
  banner.style.display = 'block';

  banner.querySelector('.app-banner-close')?.addEventListener('click', () => {
    banner.style.display = 'none';
    sessionStorage.setItem('app-banner-dismissed', '1');
  });
}

async function renderVariantBadge(spell) {
  if (!spell.forkOfSpellId) return;
  const badge = document.getElementById('variant-badge');
  if (!badge) return;

  badge.setAttribute('aria-live', 'polite');

  try {
    const parentSnap = await getDoc(doc(db, 'store_spells', spell.forkOfSpellId));
    if (parentSnap.exists() && parentSnap.data().status === 'active') {
      const parentMeta = getSpellMeta(parentSnap.data());
      const parentSlug = parentSnap.data().slug || 'spell';
      badge.innerHTML = `${t('variantOf')} <a class="variant-parent-link" href="/store/${spell.forkOfSpellId}/${parentSlug}">${escapeHtml(parentMeta.name || '?')}</a>`;
    } else {
      badge.innerHTML = `${t('variantOf')} <span class="variant-removed">${t('variantRemoved')}</span>`;
    }
  } catch {
    badge.innerHTML = `${t('variantOf')} <span class="variant-removed">${t('variantRemoved')}</span>`;
  }
  badge.hidden = false;
}

async function renderVariants(currentSpellId, spell) {
  // rootSpellId is the reliable signal — variantCount can be stale after failed writes
  if (!spell.rootSpellId) return;
  const section = document.getElementById('variants-section');
  const list = document.getElementById('variants-list');
  const title = section?.querySelector('.variants-title');
  if (!section || !list || !title) return;

  try {
    // Fetch 12 to account for current spell potentially being in results, display up to 10
    const q = query(
      collection(db, 'store_spells'),
      where('rootSpellId', '==', spell.rootSpellId),
      where('status', '==', 'active'),
      orderBy('publishedAt', 'desc'),
      limit(12)
    );
    const snap = await getDocs(q);
    const variants = snap.docs.filter(d => d.id !== currentSpellId).slice(0, 10);
    if (variants.length === 0) return;

    title.textContent = `${t('variantsSectionTitle')} (${variants.length})`;
    list.innerHTML = variants.map(d => {
      const data = d.data();
      const meta = getSpellMeta(data);
      const url = `/store/${d.id}/${data.slug || 'spell'}`;
      return `<a href="${url}" class="variant-card">
        <span class="variant-card-name">${escapeHtml(meta.name || '?')}</span>
        <span class="variant-card-meta">${escapeHtml(data.authorName || '?')} · ${data.learnCount || 0} ${t('learnCountSuffix')} 🎓</span>
      </a>`;
    }).join('');
    section.hidden = false;
  } catch { /* silent */ }
}

function showError(msg) {
  const content = document.getElementById('detail-content');
  if (content) {
    content.innerHTML = '';
    const p = document.createElement('p');
    p.className = 'error-msg';
    p.setAttribute('role', 'alert');
    p.textContent = msg;
    content.appendChild(p);
  }
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

export { initDetail };
