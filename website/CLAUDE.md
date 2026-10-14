# Website — Arquitetura

Landing page estática do Appacadabra. Hospedada via Firebase Hosting em `https://appacadabra.ai/`.

**Sem framework, sem build step.** HTML/CSS/JS puro — edições são imediatas.

---

## Estrutura

```
website/
├── index.html          — Landing page principal (557 linhas)
├── privacy.html        — Política de privacidade
├── terms.html          — Termos de serviço
├── llms.txt            — Resumo para agentes de IA (llms.txt convention)
├── css/style.css       — Estilos (tema escuro, responsivo, 920 linhas)
├── js/main.js          — Lógica da página (275 linhas)
├── js/translations.js  — Traduções em 17 idiomas (2.099 linhas)
├── img/icon.png        — Ícone do app
├── img/og-image.jpg    — Imagem Open Graph (1200x630)
├── img/screens/        — 4 screenshots do app
├── firebase.json       — Config Firebase Hosting
├── robots.txt          — SEO (lista os 2 sitemaps)
├── sitemap.xml         — Sitemap de páginas estáticas
└── store/              — Spell Store (ver seção abaixo)
```

---

## Spell Store — server-side rendering

`/store/**` é renderizado pela Cloud Function `storeSSR` e `/sitemap-spells.xml` por `storeSitemap`
(código em `firebase/functions/src/storeSSR.ts`; rewrites em `firebase.json`).

- **Por quê:** agentes de IA e previews sociais não executam JavaScript; o SSR entrega nome,
  descrição, autor, JSON-LD e OG tags de cada spell direto no HTML. O JS do cliente
  (`store/js/browse.js`, `store/js/detail.js`) hidrata por cima (mesmos element ids).
- **`store/index.html` estático está no `ignore` do hosting** (estático vence rewrite no
  Firebase Hosting, o que impediria a function de servir `/store/`). O arquivo fica no repo
  como referência da estrutura — a versão autoritativa da listagem agora é o template em
  `storeSSR.ts`.
- **IMPORTANTE:** os templates HTML em `storeSSR.ts` espelham `store/index.html` e
  `store/spell.html`. Se mudar a estrutura desses arquivos, atualize os templates também.
- SEO: `sitemap.xml` lista páginas estáticas; `sitemap-spells.xml` (gerado) lista as spells publicadas.

---

## Internacionalização

- **17 idiomas:** en, pt, es, fr, de, it, ja, zh, ko, ar, hi, ru, tr, nl, pl, vi, th
- Detecção automática via `navigator.language`
- Persistência em `localStorage`
- Override via query param: `?lang=pt`
- Todas as strings em `js/translations.js`

---

## Analytics (Google Analytics GA4)

Measurement ID: `G-NLGQ04059B`

Eventos rastreados em `js/main.js`:
- `download_click` — clique no botão de download
- `ios_modal_open` — abertura do modal de waitlist iOS
- `ios_waitlist_signup` — envio do formulário iOS
- `language_change` — troca de idioma
- `faq_expand` — expansão de pergunta do FAQ

---

## Integrações Externas

- **Google Play:** link direto para beta `market://details?id=ai.appacadabra.app` (Android) ou URL Play Store
- **iOS Waitlist:** formulário via Formspree (`https://formspree.io/f/xdalkbra`)
- **Google AdMob:** `app-ads.txt` para verificação de ads
- **Google Fonts:** Inter family

---

## Deploy

```bash
# Na pasta website/
firebase deploy --only hosting
```

Firebase Hosting serve o diretório `website/` como raiz (configurado em `website/firebase.json`).
