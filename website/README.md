# Appacadabra Landing Page

Landing page for Appacadabra - AI Tool Generator

## Setup

### 1. Configure Formspree (for iOS waitlist)
1. Create account at [formspree.io](https://formspree.io)
2. Create a new form and get your form ID
3. Replace `YOUR_FORM_ID` in `index.html` with your actual form ID

### 2. Configure Google Analytics
1. Create GA4 property at [analytics.google.com](https://analytics.google.com)
2. Get your Measurement ID (starts with `G-`)
3. Replace `G-XXXXXXXXXX` in `index.html` (appears twice)

### 3. Deploy to GitHub Pages
1. Push code to GitHub repository
2. Go to Settings > Pages
3. Select source branch (main)
4. Add custom domain if desired

### 4. Custom Domain
1. Create a `CNAME` file in the root with your domain (e.g., `appacadabra.ai`)
2. Configure DNS to point to GitHub Pages:
   - A records: `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
   - CNAME: `yourusername.github.io`

## Files

- `index.html` - Main landing page
- `css/style.css` - All styles
- `js/translations.js` - Multi-language support (EN, PT, ES, FR, DE, IT)
- `js/main.js` - Language switcher, analytics, modals
- `img/` - Logo and favicon
- `privacy.html` - Privacy policy
- `terms.html` - Terms of service

## Analytics Events

The following events are tracked:
- `download_click` - Play Store button clicked (with platform and language)
- `ios_modal_open` - iOS notify modal opened
- `ios_waitlist_signup` - iOS waitlist form submitted
- `language_change` - Language switched

## TODO

- [ ] Add real Play Store URL once published
- [ ] Configure Formspree form ID
- [ ] Configure GA4 Measurement ID
- [ ] Add app screenshots/demo video
