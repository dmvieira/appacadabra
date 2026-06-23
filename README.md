# Appacadabra

**Generate micro-apps with AI, run them on your phone.**

Describe what you want, the AI writes a self-contained HTML/CSS/JS bundle, and Appacadabra runs it inside a WebView with access to native APIs — camera, sensors, contacts, calendar, notifications, file system, the works. Bring your own OpenRouter key, pay model providers directly.

> Open source under [Apache 2.0](./LICENSE). The monorepo includes the Android app, Firebase Functions for the optional public Spell Store, and the store website.

---

## For users

Install from Google Play, or build from source (see below).

On first launch you'll be invited to set up an **OpenRouter** key. This is the AI provider Appacadabra talks to. You pay OpenRouter directly per use; Appacadabra never sees your key or your spend.

1. Create an account at [openrouter.ai](https://openrouter.ai), generate an API key.
2. In Appacadabra: Settings → AI Provider → paste your key → Test → Save.
3. Tap Create, describe what you want, watch the spell get built. Each generation shows a USD estimate before it runs.

Spells you create are yours. They live in a local SQLite database. You can publish them to the optional Spell Store, learn spells others have published, and export everything to a `.spell` file for backup or sharing.

---

## Architecture (the short version)

```
lib/capabilities/   plugin system — every native API is a self-contained module
lib/bridges/        WebView ↔ native message router
lib/database/       SQLite (expo-sqlite)
lib/api/            OpenRouter client (BYOK), key storage, prompts, pricing
app/                Expo Router screens (index, spell/[id], runner/[id], settings)
android/            Native Kotlin modules (alarms, shortcuts, runner activity)
firebase/functions/ 5 callables for the optional public Spell Store
website/            Static landing + store browser
```

The architectural centerpiece is `lib/capabilities/`. Each capability is a TypeScript module implementing `CapabilityModule` (see [`lib/capabilities/types.ts`](./lib/capabilities/types.ts)) — it owns its injected JS, its native message handler, its Android permissions, and the docs the AI sees when authoring spells. Run `npm run sync-capabilities` after touching one and the build pipeline rewires the manifest and the system prompt accordingly.

For the full overview see [`CLAUDE.md`](./CLAUDE.md).

---

## Building from source

### Prerequisites

- Node.js 20.x
- JDK 17
- Android Studio with an emulator (or a USB-connected device)
- Firebase CLI if you plan to deploy your own backend

### Android app

```bash
npm install --legacy-peer-deps
npm run prebuild:clean    # generates android/local.properties
npm run android
```

The first build takes a while — Expo prebuild generates the native projects, Gradle pulls dependencies, and the autolinking sweep runs. Subsequent builds are fast.

### Firebase Functions (optional)

Only needed if you're self-hosting the Spell Store backend. Five callables:

- `publishSpell` / `unpublishSpell` — publish a spell to the store, sanitize HTML, write to Storage
- `learnSpell` / `unlearnSpell` — record that a user has learned a spell (drives discovery counts)
- `syncLearnedSpells` — reconcile a user's local library with their server-side learned spells

```bash
cd firebase/functions
npm install
firebase deploy --only functions
```

### Website (optional)

Static site at `website/`. Public spell browser at `website/store/`. To preview locally:

```bash
cd website
firebase emulators:start --only hosting
```

---

## Self-hosting

The Play Store build talks to my Firebase project. If you want to run your own end-to-end (your own users, your own published spells), you'll need to fork the Firebase side.

1. **Create a Firebase project** at [console.firebase.google.com](https://console.firebase.google.com). Enable Auth (anonymous + Google), Firestore, Storage, Functions, and Cloud Messaging.
2. **Android app config:** add an Android app with package `ai.appacadabra.app` (or your own — update `app.json` and `android/app/build.gradle` accordingly), download `google-services.json` and place it at `android/app/google-services.json`. The file is gitignored intentionally.
3. **Web app config:** add a Web app, copy the config object, and overwrite the constants in `website/store/js/firebase-config.js`. These identifiers are designed-public per [Firebase docs](https://firebase.google.com/docs/projects/api-keys#api-keys-for-firebase-are-different).
4. **Firestore rules:** deploy `firebase/firestore.rules`.
5. **Functions:** `cd firebase/functions && firebase deploy --only functions`.
6. **Optional — push notifications:** upload your FCM server key in Firebase Console → Cloud Messaging.

The app itself does **not** need any backend for the core BYOK flow (create, edit, run spells locally). The Firebase side only powers the community Spell Store. You can run Appacadabra fully offline-of-our-servers as long as a user has their OpenRouter key configured.

---

## Authoring a new capability

Want spells to talk to Bluetooth, NFC, a custom hardware sensor? Add a capability module.

1. Read [`lib/capabilities/types.ts`](./lib/capabilities/types.ts) — the `CapabilityModule` interface.
2. Drop your file at `lib/capabilities/<your-cap>.ts`.
3. Register in [`lib/capabilities/index.ts`](./lib/capabilities/index.ts).
4. `npm run sync-capabilities` — this updates `AndroidManifest.xml` and rebuilds the docs that get injected into the AI system prompt.
5. Write a test in `lib/capabilities/__tests__/capabilities.test.ts`.

See existing capabilities for examples — `clipboard.ts` is the simplest, `health.ts` is a more involved one.

---

## Testing

```bash
npm test                  # Jest unit tests (~600 tests)
npm run test:e2e          # Maestro end-to-end flows
npm run test:e2e:flow .maestro/flows/01_home_sanity.yaml    # single flow
```

The Maestro emulator setup is documented in `.maestro/README.md`.

---

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Security issues: [SECURITY.md](./SECURITY.md).

## License

[Apache License 2.0](./LICENSE).
