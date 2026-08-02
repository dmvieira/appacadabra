<!--
Thanks for the PR! This template mirrors CONTRIBUTING.md.
Delete sections that don't apply. Keep it short — the diff already shows what.
-->

## Summary

<!-- One or two sentences on WHAT and WHY. Link the issue if there is one. -->

Closes #

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor / cleanup
- [ ] Docs only
- [ ] Chore / tooling
- [ ] New capability (`lib/capabilities/`)

## Checklist

- [ ] Scope is one concern — no unrelated changes bundled in.
- [ ] `npm test` passes locally.
- [ ] `npx tsc --noEmit` does not add new errors above the baseline.
- [ ] No new `console.log` in production paths, no unnecessary `any`.
- [ ] If I touched `firebase/functions/`, I also ran `cd firebase/functions && npm test`.
- [ ] If I added user-facing strings, they go through `lib/i18n.ts` (English key is enough; the rest are batched via `/add-locale-string`).
- [ ] If I added or changed a capability, I ran `npm run sync-capabilities` and committed the resulting `AndroidManifest.xml` / `app.json` updates.
- [ ] No secrets committed — no `google-services.json`, `.env`, keystore, or API keys.

## Testing

<!-- What did you run to verify this works?
     e.g. "Ran `npm test`, exercised the flow on Pixel 6 emulator, checked Firestore rules with the emulator." -->

## Screenshots / recordings

<!-- Optional but very helpful for UI changes. -->
