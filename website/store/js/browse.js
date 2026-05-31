import {
  getFirestore, collection, query, where, orderBy, limit, startAfter, getDocs
} from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-firestore.js';
import { getStorage, ref, getDownloadURL }
  from 'https://www.gstatic.com/firebasejs/10.14.0/firebase-storage.js';
import { app } from './auth.js';
import { escapeHtml, getSpellMeta, truncate, formatDate } from './utils.js';

const db = getFirestore(app);
const storage = getStorage(app);

let lastDoc = null;
let currentSort = 'new';
const PAGE_SIZE = 20;

function buildQuery(sort, cursor) {
  const constraints = [
    where('status', '==', 'active'),
    where('visibility', '==', 'public'),
    orderBy(sort === 'popular' ? 'learnCount' : 'publishedAt', 'desc'),
    limit(PAGE_SIZE),
  ];
  if (cursor) constraints.push(startAfter(cursor));
  return query(collection(db, 'store_spells'), ...constraints);
}

function createSpellCard(spell, id) {
  const meta = getSpellMeta(spell, (navigator.language || 'en').split('-')[0]);
  const slug = spell.slug || 'spell';

  const badge = (meta.originalLang && meta.originalLang !== meta.userLang)
    ? `<span class="lang-badge" title="Original language">${escapeHtml(meta.originalLang.toUpperCase())}</span>`
    : '';

  const card = document.createElement('a');
  card.className = 'spell-card';
  card.href = `/store/${id}/${slug}`;
  card.setAttribute('role', 'listitem');

  card.innerHTML = `
    <div class="spell-icon spell-icon-fallback" aria-hidden="true">✨</div>
    <h3 class="spell-name">${escapeHtml(meta.name || 'Untitled')}${badge}</h3>
    <p class="spell-desc">${escapeHtml(truncate(meta.description, 120))}</p>
    <div class="spell-meta-row">
      ${spell.authorName ? `<span class="spell-author">${escapeHtml(spell.authorName)}</span>` : ''}
      <span class="spell-stats">${spell.learnCount || 0} ${t('learnCountSuffix')} · ${formatDate(spell.publishedAt)}</span>
    </div>
  `;

  return card;
}

function createSkeletonCard() {
  const card = document.createElement('div');
  card.className = 'spell-card spell-card-skeleton';
  card.setAttribute('aria-hidden', 'true');
  card.innerHTML = `
    <div class="skeleton skeleton-icon"></div>
    <div class="skeleton skeleton-title"></div>
    <div class="skeleton skeleton-desc"></div>
    <div class="skeleton skeleton-desc skeleton-desc-short"></div>
    <div class="skeleton skeleton-meta"></div>
  `;
  return card;
}

async function loadSpells(reset = false) {
  if (reset) lastDoc = null;

  const grid = document.getElementById('spell-grid');
  const loadMoreBtn = document.getElementById('load-more');

  if (reset) {
    grid.innerHTML = '';
    for (let i = 0; i < 8; i++) grid.appendChild(createSkeletonCard());
  }

  try {
    const snap = await getDocs(buildQuery(currentSort, lastDoc));

    if (reset) grid.innerHTML = '';

    if (snap.empty && reset) {
      grid.innerHTML = '<p style="color:var(--text-secondary);padding:40px;grid-column:1/-1;text-align:center">No spells yet. Be the first to publish one! ✨</p>';
      if (loadMoreBtn) loadMoreBtn.style.display = 'none';
      return;
    }

    // Render cards immediately with fallback icons
    const entries = snap.docs.map(docSnap => {
      const card = createSpellCard(docSnap.data(), docSnap.id);
      grid.appendChild(card);
      return { card, spell: docSnap.data() };
    });

    lastDoc = snap.docs[snap.docs.length - 1] || null;
    if (loadMoreBtn) {
      loadMoreBtn.style.display = snap.docs.length < PAGE_SIZE ? 'none' : 'block';
    }

    // Resolve icons in parallel — swap fallback once URL is ready
    await Promise.allSettled(entries.map(async ({ card, spell }) => {
      if (!spell.iconPath) return;
      try {
        const url = await getDownloadURL(ref(storage, spell.iconPath));
        const fallback = card.querySelector('.spell-icon-fallback');
        if (fallback) {
          const img = document.createElement('img');
          img.className = 'spell-icon';
          img.src = url;
          img.alt = '';
          img.loading = 'lazy';
          fallback.replaceWith(img);
        }
      } catch { /* keep fallback */ }
    }));
  } catch (err) {
    console.error('Failed to load spells:', err);
    if (reset) {
      grid.innerHTML = '<p style="color:var(--text-secondary);padding:40px;grid-column:1/-1;text-align:center">Failed to load spells. Please try again.</p>';
    }
  }
}

function syncSortToUrl(sort) {
  const url = new URL(location.href);
  if (sort === 'new') url.searchParams.delete('sort');
  else url.searchParams.set('sort', sort);
  history.replaceState(null, '', url.toString());
}

function initBrowse() {
  // Restore sort from URL so back-navigation preserves the active tab
  const savedSort = new URLSearchParams(location.search).get('sort');
  if (savedSort === 'popular') {
    currentSort = 'popular';
    document.querySelectorAll('.tab-btn').forEach(b => {
      b.classList.toggle('active', b.dataset.sort === 'popular');
    });
  }

  loadSpells(true);

  document.getElementById('load-more')?.addEventListener('click', () => loadSpells(false));

  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      currentSort = btn.dataset.sort;
      syncSortToUrl(currentSort);
      loadSpells(true);
    });
  });
}

export { initBrowse };
