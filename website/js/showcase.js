import { initializeApp, getApps } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-app.js';
import { getFirestore, doc, getDoc } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL } from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js';

const firebaseConfig = {
  apiKey: "AIzaSyCCBAhy6QqwqRzrOTt0TXtyiRYDM89_JXc",
  authDomain: "appacadabra-bee0f.firebaseapp.com",
  projectId: "appacadabra-bee0f",
  storageBucket: "appacadabra-bee0f.firebasestorage.app",
  messagingSenderId: "901177243529",
  appId: "1:901177243529:web:0d18c5e8eaf826d0495358"
};

const app = getApps().length ? getApps()[0] : initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);

function getLang() {
  try {
    const stored = localStorage.getItem('appacadabra_lang');
    if (stored) return stored;
  } catch (_) {}
  return (navigator.language || 'en').split('-')[0];
}

function getSpellMeta(spell, lang) {
  const tr = spell.translations && spell.translations[lang];
  return {
    name: (tr && tr.name) || spell.name || '',
    description: (tr && tr.description) || spell.description || '',
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function loadCard(card, spellId, lang) {
  card.classList.add('loading');

  let spell;
  try {
    const snap = await getDoc(doc(db, 'store_spells', spellId));
    if (!snap.exists() || snap.data().status !== 'active') return;
    spell = snap.data();
  } catch (_) {
    return;
  }

  const meta = getSpellMeta(spell, lang);
  const slug = spell.slug || 'spell';
  const storeUrl = `/store/${spellId}/${slug}`;

  const problemLabel = (window.translations && window.translations[lang] && window.translations[lang].problemLabel)
    || 'The Problem';
  const viewInStoreLabel = (window.translations && window.translations[lang] && window.translations[lang].viewInStoreLabel)
    || 'View in Store →';

  card.innerHTML = `
    <div class="showcase-content">
      <div class="showcase-header">
        <div class="showcase-icon-wrap">
          <span class="showcase-icon-fallback">✨</span>
        </div>
        <h3 class="showcase-title">${escapeHtml(meta.name)}</h3>
      </div>
      <div class="showcase-block">
        <h4>${escapeHtml(problemLabel)}</h4>
        <p>${escapeHtml(meta.description)}</p>
      </div>
      <div class="showcase-preview" style="display:none">
        <img class="showcase-preview-img" alt="${escapeHtml(meta.name)}" loading="lazy">
      </div>
      <a class="showcase-store-link" href="${escapeHtml(storeUrl)}" target="_blank" rel="noopener">
        ✨ ${escapeHtml(viewInStoreLabel)}
      </a>
    </div>`;

  card.classList.remove('loading');

  if (spell.iconPath) {
    getDownloadURL(ref(storage, spell.iconPath)).then(url => {
      const wrap = card.querySelector('.showcase-icon-wrap');
      if (wrap) wrap.innerHTML = `<img class="showcase-icon" src="${url}" alt="" width="40" height="40">`;
    }).catch(() => {});
  }

  if (spell.previewImagePath) {
    getDownloadURL(ref(storage, spell.previewImagePath)).then(url => {
      const preview = card.querySelector('.showcase-preview');
      const img = card.querySelector('.showcase-preview-img');
      if (preview && img) {
        img.src = url;
        preview.style.display = '';
      }
    }).catch(() => {});
  }
}

async function initShowcase() {
  const lang = getLang();
  const cards = document.querySelectorAll('.showcase-card[data-spell-id]');
  await Promise.allSettled(
    Array.from(cards).map(card => loadCard(card, card.dataset.spellId, lang))
  );
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initShowcase);
} else {
  initShowcase();
}
