# Appacadabra — Visão Geral da Arquitetura

Gerador de micro-apps com IA. O usuário descreve o que quer e o app gera um HTML/CSS/JS completo que roda dentro de uma WebView com acesso a APIs nativas via bridge.

**Stack:** React Native 0.81 + Expo 54, TypeScript, Zustand, expo-sqlite, Firebase (Auth, Firestore, Functions, Messaging, Crashlytics), New Architecture (Fabric) habilitada.

---

## Estrutura de Pastas

```
lib/capabilities/   — Módulos de capability (plugin system)
lib/bridges/        — Bridge WebView ↔ nativo (injectedJS + messageHandlers)
lib/database/       — Schema SQLite e queries (expo-sqlite)
lib/api/            — Wrappers Firebase Cloud Functions
lib/                — Zustand stores, Firebase init, tema, i18n, utilitários
app/                — Telas Expo Router (index, spell/[id], runner/[id])
components/         — Componentes React Native reutilizáveis
android/            — Módulos Kotlin nativos customizados
scripts/            — Build automation (sync-capabilities.ts é o mais crítico)
firebase/functions/ — Cloud Functions (ver CLAUDE.md próprio)
website/            — Landing page estática (ver CLAUDE.md próprio)
```

---

## Capability System (lib/capabilities/)

**É o centro arquitetural do app.** Cada capability é um módulo TypeScript auto-contido que implementa a interface `CapabilityModule` (definida em `lib/capabilities/types.ts`):

- `id`, `displayName`, `minVersion`
- `getInjectedJS()` — código JS injetado na WebView (cria `window.AppacadabraXxx`)
- `docs` — documentação Markdown injetada no system prompt do AI
- `handleMessage(type, action, data, ...)` — handler nativo para mensagens da WebView
- `androidPermissions` — permissões Android necessárias
- `manifestBlocks` — entradas XML para AndroidManifest.xml

**Capabilities disponíveis:** ai, audio, calendar, camera, clipboard, contacts, device, docs, forms, health, notify, screen, sensors, share, sheets, ui.

**`lib/capabilities/index.ts`** — registry central: importa todos os módulos, filtra `DISABLED_CAPABILITIES`, exporta `ALL_CAPABILITIES` e `buildInjectedJSFromCapabilities()`.

### Script de sync (CRÍTICO)

```bash
npm run sync-capabilities
```

Lê `lib/capabilities/*.ts` via parsing estático, depois:
- Gera `firebase/functions/src/capabilities/{id}.ts` (docs para o AI)
- Atualiza `app.json` (permissões Android)
- Atualiza `AndroidManifest.xml` (blocos `<!-- CAPABILITY:xxx:start/end -->` e permissões)

**Executar antes de qualquer deploy do Firebase Functions.**

### AndroidManifest.xml — regiões gerenciadas automaticamente

O `sync-capabilities.ts` só toca duas regiões demarcadas:
- Entre `<!-- CAPABILITY_PERMISSIONS:start -->` e `<!-- CAPABILITY_PERMISSIONS:end -->`
- Blocos `<!-- CAPABILITY:xxx:anchor -->` / `<!-- CAPABILITY:xxx:start/end -->`

O restante do manifest é editado manualmente e não é tocado pelo script.

---

## Bridge WebView ↔ Nativo (lib/bridges/)

**`injectedJS.ts`** — monta o JS injetado na WebView:
- Cria `window.AppacadabraXxx` para cada capability ativa
- Entrega mídia grande em chunks base64 via `receiveMediaChunk()` + `window.__APPACADABRA_BLOB_CACHE__`

**`messageHandlers.ts`** — router central de mensagens `postMessage`:
- Recebe `{ type, action, data }` da WebView
- Despacha para `capability.handleMessage()`
- Gerencia estado de gravação de áudio, TTS, throttling

**Fluxo:** HTML gerado chama `AppacadabraContacts.search("João", cb)` → JS envia postMessage → `messageHandlers.ts` despacha para `contacts.handleMessage()` → Expo Contacts executa → callback invocado com resultado.

---

## SQLite Schema (lib/database/)

Banco: `appacadabra.db` via expo-sqlite. Singleton em `lib/database/db.ts` via `getDatabase()`.

| Tabela | Propósito |
|--------|-----------|
| `generated_apps` | Spells: id, name, code (HTML), currentVersion, iconPath, totalManaCost |
| `app_versions` | Histórico de versões: version, code, instruction, selectedContext, jobId |
| `app_storage` | localStorage das apps geradas: UNIQUE(appId, key) |
| `mana_events` | Histórico de custo por operação AI |
| `scheduled_notifications` | Alarmes/notificações agendadas |
| `webview_ai_cache` | Cache de resultados de AI chamados dentro da WebView |
| `dismissed_uris` | Conteúdo compartilhado já processado |

---

## Navegação (Expo Router)

| Rota | Arquivo | Descrição |
|------|---------|-----------|
| `/` | `app/index.tsx` | Lista de spells, busca, criação |
| `/spell/[id]` | `app/spell/[id].tsx` | Editor de spell (edição via linguagem natural) |
| `/runner/[id]` | `app/runner/[id].tsx` | Runner de spell (WebView + bridge) |
| `/import_spell` | `app/import_spell.tsx` | Import via arquivo ou QR |

**Root layout** (`app/_layout.tsx`): handlers de notificação, ShareReceiver, modal ManaShop.

**Componente runner alternativo:** `RunnerApp.tsx` (registrado como `"runner"` em `index.js`) — montado no `RunnerActivity` nativo separado.

---

## Android Nativo (android/)

Pacote: `ai.appacadabra.app` (pasta física: `com/dmvieira/appacadabra/`)

| Arquivo Kotlin | Descrição |
|----------------|-----------|
| `MainActivity.kt` | Entrada Expo Router, atividade principal |
| `RunnerActivity.kt` | Atividade separada para execução de spells; recebe `appId` por intent ou deep link `runapp://`; gerencia lifecycle de WebViews para múltiplos runners simultâneos; emite `RUNNER_ACTIVITY_RESUMED` |
| `MainApplication.kt` | Registra `SharingShortcutsPackage` e `AlarmPackage`; New Architecture habilitada |
| `SharingShortcutsModule.kt` | NativeModule: `publishShortcut`, `removeShortcut`, `getMaxShortcutCount` |
| `AlarmModule.kt` | NativeModule: `scheduleAlarm` (AlarmManager, respeita Doze), `cancelAlarm` |
| `AlarmReceiver.kt` | BroadcastReceiver que dispara notificações ao receber alarme |

**Padrão dual-activity:** `MainActivity` roda o app principal; cada spell aberta cria um `RunnerActivity` independente com `taskAffinity=".runner_task"`. Comunicação via broadcast `ai.appacadabra.app.FINISH_RUNNER` com `appId` no extra.

---

## State Management

| Store | Arquivo | O que guarda |
|-------|---------|-------------|
| App store | `lib/store.ts` | `apps[]`, `activeAppId`, `runningInstances`, `activeJobs`, `sharedContent` |
| Mana store | `lib/manaStore.ts` | `balance`, listener Firestore de créditos, controle da ManaShop |
| Bridge UI store | `lib/bridgeUIStore.ts` | Refs de WebView para `postMessage` |
| Storage cache | `lib/storageCache.ts` | Cache in-memory do app_storage (evita queries repetidas) |

---

## Scripts

| Comando | Descrição |
|---------|-----------|
| `npm run android` | Build + run no Android |
| `npm run sync-capabilities` | Sincroniza capabilities → Firebase + AndroidManifest |
| `npm run prebuild:clean` | Expo prebuild + setup-android.js (gera local.properties) |
| `npm test` | Jest (159/164 passando; 5 falhas pré-existentes em codeValidator e i18n) |

---

## Processo de Release

**Usar o Release Agent** para qualquer tarefa de release. O agente conhece os skills `/release-checklist` e `/release-notes` e sabe coordená-los.

Invocar com: `Agent(subagent_type="Release Agent", prompt="...")`

| Passo | Responsável |
|-------|-------------|
| 1. Checklist pré-submissão | Release Agent → `/release-checklist` |
| 2. Bump versão + notas + tag | Release Agent → `/release-notes` |
| 3. Build AAB | `./gradlew bundleRelease` (manual, requer keystore) |
| 4. Upload Play Console | Manual — usar `docs/RELEASE_NOTES.md` por locale |

**Ficheiros de release:**
- `docs/RELEASE_NOTES.md` — notas do release atual (20 locales, formato `<en-US>...</en-US>`)
- `docs/PLAY_STORE_TRANSLATIONS.md` — descrições completas da store por locale
- `docs/APP_STORE_REVIEW.md` — documentação para reviewers da Google
