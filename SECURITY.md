# Security Policy

## Reporting a vulnerability

**Do not open a public GitHub issue for security vulnerabilities.**

Email: **support@appacadabra.ai** with the subject line `[Appacadabra security]`.

Include:

- A description of the vulnerability and the affected component (Android app, Firebase Functions, store website, capability bridge, etc.).
- Steps to reproduce, or a proof-of-concept.
- The version you tested against (from `package.json` or the Play Store entry).
- Your name/handle for credit, if you want one.

We'll acknowledge within **3 business days** and aim to ship a fix or mitigation within **30 days** for high-severity issues. We'll coordinate disclosure with you and credit you in the release notes unless you ask us not to.

## Scope

In scope:

- The Android app (`app/`, `lib/`, `components/`, `android/`).
- Firebase Functions (`firebase/functions/`).
- The Spell Store website (`website/`).
- The WebView ↔ native bridge (`lib/bridges/`) and capability modules (`lib/capabilities/`).

Out of scope:

- Vulnerabilities requiring physical device access with the screen unlocked.
- Self-XSS in user-authored spells running in their own WebView (the spell's own code, not the runner).
- Issues in third-party dependencies that don't have a known exploit path through Appacadabra.

## What we won't do

- We won't pursue legal action against good-faith researchers who follow this policy.
- We won't pay bug bounties (the project is unfunded). We will credit you publicly if you want.

## Already known

The following are intentional design decisions, not bugs:

- The OpenRouter API key is stored locally via `expo-secure-store` (Android Keystore-backed). A rooted device with debug access could extract it — this is a known limitation of any on-device credential storage.
- Spells run user-authored JavaScript inside a WebView with access to bridge APIs. Sandboxing within a spell is not a security boundary; the user is the owner of their own spells.
- Firebase Web SDK identifiers in `website/store/js/firebase-config.js` and `android/app/google-services.json` (when present) are designed-public per Google's documentation. Self-hosters should substitute their own.
