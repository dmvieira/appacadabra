# Plano de Migração — Expo SDK 54 → 55

> Preparado em 2026-09-12, com base no changelog oficial (expo.dev/changelog/sdk-55, publicado 25/fev/2026).
> SDK 55 = **React Native 0.83** + **React 19.2**. A partir de SDK 55, todos os pacotes Expo usam versão `^55.x` (mesmo major do SDK).

## Motivação

- Resolver as warnings do Google Play Console: APIs edge-to-edge deprecadas (`StatusBarModule` do RN core, `WindowUtilKt` do `react-native-screens`) — corrigidas no RN 0.83 e screens 4.23.
- AGP mais novo (o report pedia AGP 9+; Expo gerencia a versão via prebuild).
- Redução de tamanho/memória e correções de segurança do `expo-notifications` (FCM intent origin validation, crash no NotificationForwarderActivity em Android 11/12).

## Impactos específicos deste repo (verificados no código)

| Item | Situação atual | Ação |
|---|---|---|
| `expo-av` ^16.0.8 | Usado em 7 arquivos: `lib/capabilities/audio.ts`, `lib/capabilities/camera.ts`, `lib/bridges/messageHandlers.ts`, `app/runner/[id].tsx`, `components/AppRunner.tsx`, `RunnerApp.tsx` (+tests) | **Maior item.** Migrar para `expo-audio` (gravação/TTS playback) e `expo-video` (vídeo dos runners). `expo-av` não recebe mais patches e foi removido do Expo Go |
| `app.json` → campo `notification` | Presente | **Removido do schema em SDK 55** — `prebuild` quebra. Migrar para o config plugin `expo-notifications` ANTES do upgrade |
| `expo-status-bar` ~3.0.9 | Usado com props de cor/translucidez? | `backgroundColor`, `translucent` viram no-op com edge-to-edge obrigatório (Android 16+). Limpar props e adotar config plugin se precisar fixar algo |
| `newArchEnabled` no app.json | Presente (já usamos New Arch) | Campo **removido do schema** — remover do app.json (comportamento passa a ser fixo) |
| `react-native-screens` ~4.16 | — | Sobe para 4.23 junto com o upgrade (resolve o warning do Play Console) |
| `expo-speech-recognition` ^3.0.1, `react-native-health` ^1.19 | Pacotes community | Verificar versão compatível com SDK 55 antes de rodar `--fix` |
| Módulos nativos custom (`AlarmModule`, `SharingShortcutsModule`, `RunnerActivity`) + plugins custom (`withAppacadabraNative`, `withIosShareExtension`, `withIosQuickActions`) | Recompilam a cada prebuild | Revalidar pós-prebuild: blocos `<!-- CAPABILITY:xxx -->` e regiões do manifest geradas pelo `sync-capabilities` |

Não afetados: `removeSubscription` (não usamos), `expo-video-thumbnails` (não usamos), `expo-blur`/`expo-router` breaking changes de API específicas (revisar changelog durante o upgrade).

## Ordem de execução recomendada

1. **Pré-requisitos**: Node ≥ 20.19/22.13 (checar `node -v` no Windows); tag `v3.1.6` estável publicada como rollback.
2. **Antes do upgrade (já no SDK 54, reduz risco):**
   - Migrar `expo-av` → `expo-audio` + `expo-video` (ambos existem no SDK 54). Validar capability de áudio (gravação por chunks, TTS) e playback de vídeo nos runners com o emulador.
   - Migrar campo `notification` do app.json → config plugin `expo-notifications`.
   - Limpar props deprecated do `expo-status-bar`.
3. **Upgrade:**
   ```bash
   npx expo install expo@^55.0.0 --fix
   npx expo-doctor@latest
   ```
   Conferir `expo-speech-recognition` e `react-native-health` em versões compatíveis.
4. **Regenerar nativo:**
   ```bash
   npm run prebuild:clean
   npm run sync-capabilities
   ```
   Reaplicar ajustes manuais do manifest fora das regiões `CAPABILITY:*` (o script preserva, mas conferir o diff).
5. **Validação:**
   - `npm test` (baseline: 827 testes)
   - Build debug no emulador + flows Maestro (`npm run test:e2e`)
   - Testes metamórficos de IA (`firebase/functions` — ai-quality), pois os modelos default podem precisar de reajuste
   - `gradlew bundleRelease` (usar `android/_bundle_release.bat`) + verificar pre-launch report no Play Console — as warnings de edge-to-edge/R8 devem sumir

## Não adotar

- **Hermes v1**: opt-in com regressões conhecidas de memória/startup e exige build do RN from source (aumenta muito o build local). Reavaliar só em SDK 57+ (`expo@57.0.17`).
- **Expo Go / dev builds**: não se aplica ao workflow atual (prebuild + builds locais Windows via `_build2.bat`/`_bundle_release.bat`).

## Ferramentas

A Expo mantém skills oficiais de upgrade (github.com/expo/skills → `plugins/upgrading-expo`). Podemos instalá-las em `.opencode/skill/` no dia da migração e executar o upgrade com o `engineering-agent`.

Estimativa: 1–2 dias de trabalho (o item expo-av domina o esforço).

## Lições da execução (2026-09-15 — migração aplicada)

- `expo-file-system/next` foi removido no SDK 55: a API "next" é o root (`import { File, Directory, Paths } from 'expo-file-system'`). `/legacy` continua existindo.
- Jest/jsdom: o runtime "winter" do expo 55 exige `TextEncoder`/`TextDecoder` — polyfill adicionado no início do `jest.setup.js`.
- `.npmrc` com `legacy-peer-deps=true` é obrigatório (conflito de peer do @react-native-firebase bloqueia o `expo install --fix`).
- `sucrase` virou devDependency explícita (era transitiva; `sync-capabilities` depende dela).
- `expo prebuild` (sem `--clean`) realoca os Kotlin custom de `com/dmvieira/appacadabra` para `ai/appacadabra/app` e reseta `versionCode` para 1 — sempre revisar o diff e restaurar o versionCode.
- **MainApplication.kt SDK 55**: `ReactNativeHostWrapper` não existe mais; o padrão novo é `reactHost` via `expo.modules.ExpoReactHostFactory.getDefaultReactHost` + `loadReactNative(this)`.
- O plugin `withAppacadabraNative` agora copia TODOS os 13 módulos custom de `native-assets/.../ai/appacadabra/app/` e injeta os 3 pacotes custom no MainApplication (template) — `prebuild --clean` voltou a ser seguro para o Kotlin. ⚠️ O manifest ainda exige revisão manual pós-`--clean` (permissões manuais, `fullUser`, `versionCode`).
- **hermesc**: RN 0.83 não embarca mais `sdks/hermesc`; o `hermesCommand` do `app/build.gradle` aponta para o pacote npm `hermes-compiler`. Re-aplicar se o build.gradle for regenerado.
- Status final: unit 828/828 ✓, functions 17/17 ✓, `assembleDebug` ✓, `bundleRelease` ✓ (AAB 82MB assinado v1/APPACADA). Pendente: e2e Maestro no emulador + rollout.
