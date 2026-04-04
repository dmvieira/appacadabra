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
├── css/style.css       — Estilos (tema escuro, responsivo, 920 linhas)
├── js/main.js          — Lógica da página (275 linhas)
├── js/translations.js  — Traduções em 17 idiomas (2.099 linhas)
├── img/icon.png        — Ícone do app
├── img/screens/        — 4 screenshots do app
├── firebase.json       — Config Firebase Hosting
├── robots.txt          — SEO
└── sitemap.xml         — Sitemap (3 páginas)
```

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
