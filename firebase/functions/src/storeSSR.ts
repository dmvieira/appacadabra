/**
 * Server-side rendering (SSR) for the public Spell Store.
 *
 * Firebase Hosting rewrites /store/** to `storeSSR` and /sitemap-spells.xml to `storeSitemap`
 * (see website/firebase.json). Static files under /store/js, /store/css still win over the
 * rewrite, so the client JS hydrates normally on top of the markup rendered here.
 *
 * IMPORTANT: the HTML templates below mirror website/store/index.html and
 * website/store/spell.html (same element ids/classes) so browse.js/detail.js can take over
 * after load. If you change the structure of those files, update the templates here too.
 *
 * The rendered content is plain readable English (name/description/author), so AI agents and
 * social previews that don't run JavaScript can read the Store.
 */

import { onRequest } from "firebase-functions/v2/https";
import { getFirestore } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const REGION = "southamerica-east1";
const SITE = "https://appacadabra.ai";
const DEFAULT_OG_IMAGE = `${SITE}/img/og-image.jpg`;
const PLAY_URL = "https://play.google.com/store/apps/details?id=ai.appacadabra.app";
const LIST_PAGE_SIZE = 40;
const SITEMAP_MAX_URLS = 2000;

// ============= pure helpers (unit-tested) =============

export function escapeHtml(value: unknown): string {
    return String(value ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function truncate(value: string, max: number): string {
    if (!value) return "";
    return value.length > max ? value.slice(0, max) + "…" : value;
}

export function parseStorePath(pathname: string | undefined): string | null {
    const clean = (pathname ?? "").split("?")[0].replace(/\/+$/, "");
    const parts = clean.split("/").filter(Boolean);
    if (parts[0] !== "store") return null;
    return parts[1] ?? null;
}

interface SpellTranslations {
    [lang: string]: { name?: string; description?: string } | undefined;
}

/** English metadata preferred (agents/previews read English); falls back to original. */
export function spellMetaEn(spell: any): { name: string; description: string } {
    const t: SpellTranslations | undefined = spell?.translations;
    const meta = (t && (t.en || (spell?.originalLang && t[spell.originalLang]))) || null;
    return {
        name: String(meta?.name ?? spell?.name ?? ""),
        description: String(meta?.description ?? spell?.description ?? ""),
    };
}

function tsToIso(ts: any): string | null {
    try {
        if (!ts) return null;
        if (typeof ts.toDate === "function") return (ts.toDate() as Date).toISOString();
        if (typeof ts.seconds === "number") return new Date(ts.seconds * 1000).toISOString();
        return null;
    } catch {
        return null;
    }
}

export interface SpellView {
    id: string;
    name: string;
    description: string;
    slug: string;
    authorName: string | null;
    learnCount: number;
    publishedIso: string | null;
    updatedIso: string | null;
    iconUrl: string | null;
    previewUrl: string | null;
    spellUrl: string;
}

/** Builds the render-safe view model. `bucketName` is injected to keep this pure/testable. */
export function toSpellView(id: string, spell: any, bucketName: string): SpellView {
    const meta = spellMetaEn(spell);
    const slug = typeof spell?.slug === "string" && spell.slug ? spell.slug : "spell";
    const asset = (p: unknown): string | null =>
        typeof p === "string" && p ? `https://storage.googleapis.com/${bucketName}/${p}` : null;
    return {
        id,
        name: meta.name,
        description: meta.description,
        slug,
        authorName: typeof spell?.authorName === "string" && spell.authorName ? spell.authorName : null,
        learnCount: typeof spell?.learnCount === "number" ? spell.learnCount : 0,
        publishedIso: tsToIso(spell?.publishedAt),
        updatedIso: tsToIso(spell?.updatedAt) ?? tsToIso(spell?.publishedAt),
        iconUrl: asset(spell?.iconPath),
        previewUrl: asset(spell?.previewImagePath),
        spellUrl: `${SITE}/store/${id}/${slug}`,
    };
}

function fmtDate(iso: string | null): string {
    if (!iso) return "";
    try {
        return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
    } catch {
        return "";
    }
}

const COMMON_HEAD = `
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <link rel="stylesheet" href="/store/css/store.css">
  <link rel="icon" href="/img/favicon.png">
  <script>document.documentElement.lang = (navigator.language || 'en').split('-')[0];</script>`;

/** JSON.stringify for embedding inside a <script> tag: prevents </script> breakout. */
function jsonLdSafe(value: unknown): string {
    return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

function storeHeader(): string {
    return `
  <header class="store-header">
    <a href="/" class="store-logo">
      <img src="/img/icon.png" alt="Appacadabra" width="32" height="32">
      <span>Appacadabra</span>
    </a>
    <nav class="header-nav" aria-label="Header navigation">
      <button id="auth-btn" class="auth-btn" type="button">Sign in with Google</button>
    </nav>
  </header>`;
}

// ============= store list page (/store, /store/) =============

function spellCardHtml(v: SpellView): string {
    const icon = v.iconUrl
        ? `<img class="spell-icon" src="${escapeHtml(v.iconUrl)}" alt="" loading="lazy">`
        : `<div class="spell-icon spell-icon-fallback" aria-hidden="true">✨</div>`;
    return `
      <a class="spell-card" href="${escapeHtml(v.spellUrl)}" role="listitem">
        ${icon}
        <h3 class="spell-name">${escapeHtml(v.name || "Untitled")}</h3>
        <p class="spell-desc">${escapeHtml(truncate(v.description, 120))}</p>
        <div class="spell-meta-row">
          ${v.authorName ? `<span class="spell-author">${escapeHtml(v.authorName)}</span>` : ""}
          <span class="spell-stats">${v.learnCount} learned${v.publishedIso ? ` · ${escapeHtml(fmtDate(v.publishedIso))}` : ""}</span>
        </div>
      </a>`;
}

export function renderListPage(views: SpellView[], sort: "new" | "popular"): string {
    const listJsonLdObj = {
        "@context": "https://schema.org",
        "@type": "ItemList",
        name: "Appacadabra Spell Store",
        numberOfItems: views.length,
        itemListElement: views.map((v, i) => ({
            "@type": "ListItem",
            position: i + 1,
            name: v.name,
            url: v.spellUrl,
        })),
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Spell Store — Appacadabra</title>${COMMON_HEAD}
  <meta name="description" content="Discover and learn spells created by the Appacadabra community.">
  <link rel="canonical" href="${SITE}/store/">
  <meta property="og:title" content="Spell Store — Appacadabra">
  <meta property="og:description" content="Discover and learn spells created by the Appacadabra community. Free to learn, no listing fee to publish.">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${SITE}/store/">
  <meta property="og:image" content="${DEFAULT_OG_IMAGE}">
  <script type="application/ld+json">${jsonLdSafe(listJsonLdObj)}</script>
  <script src="/store/js/firebase-config.js"></script>
</head>
<body>
${storeHeader()}
  <main id="store-content">
    <div class="store-hero">
      <h1>Spell Store</h1>
      <p>Discover and learn spells created by the community</p>
      <p class="store-free-badge" data-store-i18n="storeFreeBadge">✨ Free to learn. Free to publish.</p>
    </div>

    <div class="tabs-container">
      <nav class="tabs" aria-label="Sort spells">
        <button class="tab-btn${sort === "new" ? " active" : ""}" data-sort="new" type="button">✨ New</button>
        <button class="tab-btn${sort === "popular" ? " active" : ""}" data-sort="popular" type="button">🔥 Popular</button>
      </nav>
    </div>

    <div id="spell-grid" class="spell-grid" role="list" aria-label="Spells">${views.map(spellCardHtml).join("")}</div>

    <div class="load-more-container">
      <button id="load-more" class="load-more-btn" type="button" style="display:none">
        Load more
      </button>
    </div>

    <footer class="store-safety-notice" role="contentinfo">
      <span data-store-i18n="storeSafetyFooter">Spells are created by community members. Appacadabra does not review or endorse third-party spells.</span>
      <a href="/terms.html" data-store-i18n="storeSafetyLearnMore" class="store-safety-link">Learn more</a>
    </footer>
  </main>

  <script type="module">
    import { initBrowse } from '/store/js/browse.js';
    import '/store/js/auth.js';
    document.addEventListener('DOMContentLoaded', initBrowse);
  </script>
</body>
</html>`;
}

// ============= spell detail page (/store/{id}/{slug}) =============

export function renderSpellPage(v: SpellView): string {
    const ogImage = v.previewUrl || v.iconUrl || DEFAULT_OG_IMAGE;
    const jsonLdObj = {
        "@context": "https://schema.org",
        "@type": "SoftwareApplication",
        name: v.name,
        description: truncate(v.description, 300),
        url: v.spellUrl,
        image: ogImage,
        operatingSystem: "Android",
        applicationCategory: "UtilitiesApplication",
        author: { "@type": "Person", name: v.authorName || "Appacadabra community" },
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    };
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>${escapeHtml(v.name || "Spell")} — Appacadabra Store</title>${COMMON_HEAD}
  <meta name="description" content="${escapeHtml(truncate(v.description, 160))}">
  <link rel="canonical" href="${escapeHtml(v.spellUrl)}">
  <meta id="og-title" property="og:title" content="${escapeHtml(v.name || "Spell")}">
  <meta id="og-description" property="og:description" content="${escapeHtml(truncate(v.description, 160))}">
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeHtml(v.spellUrl)}">
  <meta property="og:image" content="${escapeHtml(ogImage)}">
  <meta property="og:site_name" content="Appacadabra">
  <meta name="twitter:card" content="summary">
  <meta name="twitter:title" content="${escapeHtml(v.name || "Spell")}">
  <meta name="twitter:description" content="${escapeHtml(truncate(v.description, 160))}">
  <meta name="twitter:image" content="${escapeHtml(ogImage)}">
  <script type="application/ld+json">${jsonLdSafe(jsonLdObj)}</script>
  <script src="/store/js/firebase-config.js"></script>
</head>
<body>
${storeHeader()}
  <main id="detail-content" class="spell-detail-layout">
    <section class="spell-meta-section" aria-label="Spell info">
      <div class="spell-header-row">
        <img id="spell-icon" class="spell-icon-large" src="${escapeHtml(v.iconUrl || "/img/icon.png")}"
             alt="Spell icon" onerror="this.style.display='none'">
        <div>
          <h1 id="spell-name" class="spell-title">${escapeHtml(v.name || "Untitled")}</h1>
          <p class="spell-byline">
            by <span id="spell-author">${escapeHtml(v.authorName || "")}</span> ·
            <span id="spell-learn-count">${v.learnCount} learned</span>
          </p>
          <p class="spell-safety-inline">
            <span data-store-i18n="spellSafetyInline">Community spell — run at your own discretion.</span>
            <a href="/terms.html" data-store-i18n="storeSafetyLearnMore" class="store-safety-link">Learn more</a>
          </p>
        </div>
      </div>

      <div id="variant-badge" class="variant-badge" hidden></div>

      <p id="spell-description" class="spell-description">${escapeHtml(v.description)}</p>

      <div class="action-row">
        <button id="copy-link-btn" class="btn-ghost" type="button">Copy link</button>
        <button id="share-btn" class="btn-ghost" type="button">Share</button>
      </div>

      <div class="learn-section">
        <div id="app-cta-block" class="app-cta-block" role="note" aria-label="App context" style="display:none"></div>
        <button id="learn-btn" class="learn-btn" type="button">
          Learn this spell ✨
        </button>
        <p class="spell-free-inline" data-store-i18n="spellFreeInline">✨ Free to learn</p>
        <p id="learn-status" class="learn-status" role="status" aria-live="polite"></p>
        <p class="spell-free-inline">Open with the free <a href="${PLAY_URL}" target="_blank" rel="noopener noreferrer">Appacadabra app for Android</a>.</p>
      </div>

      <section id="variants-section" class="variants-section" hidden>
        <h2 class="variants-title">Variants</h2>
        <div id="variants-list" class="variants-list"></div>
      </section>

      <div id="owner-controls" class="owner-controls" style="display:none" aria-label="Owner controls">
        <hr class="divider">
        <button id="unpublish-btn" class="btn-danger" type="button">
          ⛔ Unpublish from Store
        </button>
      </div>
    </section>

    <section class="spell-preview-section" aria-label="Spell preview">
      <div id="preview-container" class="preview-container">
        <iframe
          id="preview-frame"
          class="preview-frame"
          sandbox="allow-scripts"
          title="Spell preview"
          loading="lazy"
        ></iframe>
      </div>
      <p class="preview-notice-text">
        ⚠️ Native features (camera, contacts, sensors, etc.) require the app
      </p>
    </section>
  </main>

  <div id="app-banner" class="app-banner" style="display:none" role="complementary" aria-label="Download app">
    <div class="app-banner-inner">
      <div>
        <p class="app-banner-title">Use this spell on your Android</p>
        <p class="app-banner-sub">The spell will be saved to your account when you install the app.</p>
      </div>
      <a href="${PLAY_URL}"
         target="_blank" rel="noopener noreferrer"
         aria-label="Get it on Google Play">
        <img src="https://play.google.com/intl/en_us/badges/static/images/badges/en_badge_web_generic.png"
             alt="Get it on Google Play" height="48">
      </a>
      <button class="app-banner-close" type="button" aria-label="Close">×</button>
    </div>
  </div>

  <script type="module">
    import { initDetail } from '/store/js/detail.js';
    document.addEventListener('DOMContentLoaded', initDetail);
  </script>
</body>
</html>`;
}

export function renderNotFoundPage(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <title>Spell not found — Appacadabra Store</title>${COMMON_HEAD}
  <meta name="description" content="This spell was removed or does not exist.">
  <meta property="og:title" content="Spell not found — Appacadabra Store">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${DEFAULT_OG_IMAGE}">
</head>
<body>
${storeHeader()}
  <main id="detail-content" class="spell-detail-layout">
    <section class="spell-meta-section" aria-label="Spell info">
      <h1 class="spell-title">Spell not found</h1>
      <p class="spell-description">This spell was removed or does not exist.</p>
      <p><a href="${SITE}/store/">Browse the Spell Store →</a></p>
    </section>
  </main>
</body>
</html>`;
}

// ============= spell sitemap (/sitemap-spells.xml) =============

export function renderSitemapXml(views: SpellView[]): string {
    const urls = [
        `  <url>
    <loc>${SITE}/store/</loc>
    <changefreq>daily</changefreq>
    <priority>0.9</priority>
  </url>`,
        ...views.map((v) => `  <url>
    <loc>${escapeHtml(v.spellUrl)}</loc>${v.updatedIso ? `
    <lastmod>${v.updatedIso}</lastmod>` : ""}
  </url>`),
    ].join("\n");
    return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

// ============= handlers =============

function bucketName(): string {
    return getStorage().bucket().name;
}

async function queryPublicSpells(orderBy: "publishedAt" | "learnCount", limit: number) {
    return getFirestore()
        .collection("store_spells")
        .where("status", "==", "active")
        .where("visibility", "==", "public")
        .orderBy(orderBy, "desc")
        .limit(limit)
        .get();
}

export const storeSSR = onRequest(
    { region: REGION, memory: "256MiB", timeoutSeconds: 30, invoker: "public" },
    async (req, res) => {
        try {
            // "/store/index.html" resolves as a static path is ignored at deploy time;
            // treat it as the listing page for anyone hitting the literal URL.
            const rawPath = req.path || new URL(req.url, SITE).pathname;
            const spellId = rawPath.endsWith("/index.html") ? null : parseStorePath(rawPath);
            if (!spellId) {
                const sort = req.query.sort === "popular" ? "popular" : "new";
                const snap = await queryPublicSpells(sort === "popular" ? "learnCount" : "publishedAt", LIST_PAGE_SIZE);
                const views = snap.docs.map((d) => toSpellView(d.id, d.data(), bucketName()));
                res.set("Cache-Control", "public, max-age=300, s-maxage=1800");
                res.status(200).send(renderListPage(views, sort));
                return;
            }

            const snap = await getFirestore().collection("store_spells").doc(spellId).get();
            const data = snap.data();
            if (!snap.exists || !data || data.status !== "active" || data.visibility !== "public") {
                res.set("Cache-Control", "public, max-age=60, s-maxage=300");
                res.status(404).send(renderNotFoundPage());
                return;
            }
            const view = toSpellView(snap.id, data, bucketName());
            res.set("Cache-Control", "public, max-age=300, s-maxage=1800");
            res.status(200).send(renderSpellPage(view));
        } catch (err) {
            console.error("[storeSSR] failed:", err);
            res.set("Cache-Control", "no-store");
            res.status(500).send(renderNotFoundPage());
        }
    },
);

export const storeSitemap = onRequest(
    { region: REGION, memory: "256MiB", timeoutSeconds: 60, invoker: "public" },
    async (req, res) => {
        try {
            const snap = await queryPublicSpells("publishedAt", SITEMAP_MAX_URLS);
            const views = snap.docs.map((d) => toSpellView(d.id, d.data(), bucketName()));
            res.set("Cache-Control", "public, max-age=600, s-maxage=86400");
            res.status(200).type("application/xml").send(renderSitemapXml(views));
        } catch (err) {
            console.error("[storeSitemap] failed:", err);
            res.set("Cache-Control", "no-store");
            res.status(500).type("text/plain").send("Failed to build sitemap");
        }
    },
);
