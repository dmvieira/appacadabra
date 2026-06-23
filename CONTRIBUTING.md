# Contributing to Appacadabra

Thanks for considering a contribution. This guide covers what we expect from PRs and how to get a working dev environment.

## Code of conduct

Be respectful. We follow the [Contributor Covenant](https://www.contributor-covenant.org/).

## Before you start

- **Small fixes** (typos, bugs with obvious root cause, documentation): open a PR directly.
- **Anything else** (new capability, behavior change, dependency bump, refactor): open an issue first describing the problem and the approach. This avoids wasted work on PRs that don't match the project direction.

## Dev environment

You will need:

- Node.js 20.x
- JDK 17
- Android Studio (with an emulator or a real device)
- Firebase CLI if you plan to touch `firebase/functions/` or `website/`

Setup:

```bash
npm install --legacy-peer-deps
npm run prebuild:clean    # generates android/local.properties
```

Run on Android:

```bash
npm run android
```

## What we look for in a PR

- **Scope:** one concern per PR. Don't bundle a bug fix with an unrelated refactor.
- **Tests:** if you touch a module that has tests in `lib/__tests__/`, update or extend them. New capabilities should land with at least one capability-level test.
- **Type safety:** `npx tsc --noEmit` must not introduce new errors. The current baseline has a handful of pre-existing errors — leave them at the same count or below.
- **Lint:** no `console.log` in production paths, no `any` where a real type fits.
- **Localization:** any user-facing string must go through `lib/i18n.ts`. Add the EN key in your PR; the rest of the locales are batched separately via the `/add-locale-string` flow.
- **No secrets:** never commit API keys, service accounts, keystores, or `google-services.json`. CI does a regex sweep for the usual patterns.

## Capability authoring

If you're adding a new device API (sensors, calendar, etc.):

1. Read `lib/capabilities/types.ts` for the `CapabilityModule` interface.
2. Implement the module in `lib/capabilities/<your-cap>.ts`.
3. Register it in `lib/capabilities/index.ts`.
4. Run `npm run sync-capabilities` — this updates `AndroidManifest.xml` permissions and the docs injected into the OpenRouter system prompt.
5. Add a test in `lib/capabilities/__tests__/capabilities.test.ts`.

See `CLAUDE.md` for the broader architecture overview.

## Commit messages

Format: `<type>(<scope>): <subject>` — e.g. `feat(capabilities): add bluetooth scan`. Types we use: `feat`, `fix`, `chore`, `docs`, `refactor`, `test`.

The body should explain **why**, not what. The diff already shows what changed.

## Reviewing your PR

Expect comments. We optimize for clarity and long-term maintainability over speed of merge. If a review stalls, ping us — we may have missed the notification.

## Security issues

Don't open public issues for security vulnerabilities. See [SECURITY.md](./SECURITY.md).
