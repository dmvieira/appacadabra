# iOS Compatibility Guide

Guia de implementação para suporte iOS no Appacadabra. Este documento lista todas as funcionalidades que precisam de implementação específica para iOS.

## Status Geral

| Componente | Android | iOS | Notas |
|------------|---------|-----|-------|
| Core App (Expo) | ✅ | ⚠️ Parcial | Precisa build iOS |
| WebView Runner | ✅ | ✅ | Cross-platform via expo |
| Calendar | ✅ | ✅ | Unificado com expo-calendar |
| Notifications | ✅ | ✅ | Unificado com expo-notifications |
| Geolocation | ✅ | ✅ | Unificado com expo-location |
| Share Intent | ✅ | ❌ Não implementado | Requer Share Extension |
| Home Shortcuts | ✅ | ❌ Não implementado | Requer Siri Shortcuts |
| Direct Share | ✅ | ❌ Não implementado | Específico Android |
| Runner Window | ✅ | ❌ Não implementado | Requer navegação iOS |

---

## 1. Módulos Nativos

### 1.1 ShareIntentModule

**Localização**: `modules/share-intent/`

**Android** (`android/src/.../ShareIntentModule.kt`):
- Recebe intents de compartilhamento via `Intent.ACTION_SEND`
- Configurado no AndroidManifest com intent-filter
- Funções: `getSharedContent`, `clearSharedContent`, `checkShareIntent`
- Funções nativas: `startRunnerActivity`, `openRunnerWindow`, `finishRunnerActivity`

**iOS - Share Extension**:
- ✅ **iOS TEM share!** É via "Share Extension" (App Extension)
- Share Extension é um target separado no Xcode
- Aparece no share sheet nativo do iOS
- Precisa usar **App Groups** para passar dados para o app principal

**Como funciona no iOS**:
```
┌─────────────────┐      ┌──────────────────┐      ┌─────────────────┐
│  App externo    │ ──▶  │ Share Extension  │ ──▶  │  Appacadabra    │
│  (Safari, etc)  │      │  (target Xcode)  │      │  (app principal)│
└─────────────────┘      └──────────────────┘      └─────────────────┘
                               │
                               ▼
                         App Groups
                     (shared UserDefaults
                      ou shared container)
```

**Tarefas iOS**:
```
[ ] Criar Share Extension target no Xcode
    - File > New > Target > Share Extension
    - Nome sugerido: "AppacadabraShare"
    
[ ] Configurar App Groups
    - Capability no app principal: "App Groups"  
    - Mesmo grupo na Extension: "group.com.dmvieira.appacadabra"
    
[ ] Implementar ShareViewController.swift na Extension
    - Herdar de SLComposeServiceViewController ou UIViewController
    - Ler conteúdo via extensionContext?.inputItems
    - Salvar em UserDefaults(suiteName: "group.com.dmvieira.appacadabra")
    
[ ] No app principal, ler dados do App Group ao abrir
    - Verificar UserDefaults do grupo compartilhado
    - Popular sharedContent no store
    
[ ] Configurar CFBundleURLTypes no Info.plist para deep links
[ ] Testar com texto, URLs, imagens
```

**Arquivo existente** (`ios/ShareIntentModule.swift`):
- ⚠️ Existe mas está incompleto
- Precisa ser conectado à Share Extension real

---

### 1.2 ShortcutsModule

**Localização**: `modules/shortcuts/`

**Android** (`android/src/.../ShortcutsModule.kt`):
- Cria atalhos na home screen via `ShortcutManagerCompat`
- Funções: `createShortcut`, `setDynamicShortcuts`

**iOS** (`ios/ShortcutsModule.swift`):
- ⚠️ **Arquivo existe mas está incompleto**
- iOS não tem atalhos de home screen, usar **Siri Shortcuts**

**Tarefas iOS**:
```
[ ] Implementar Siri Shortcuts via SiriKit
[ ] Adicionar INIntent definitions ao projeto
[ ] Registrar shortcuts com INVoiceShortcutCenter
[ ] Opcionalmente: usar Quick Actions (3D Touch / Haptic Touch)
```

---

### 1.3 SharingShortcuts (Direct Share)

**Localização**: `lib/bridges/SharingShortcuts.ts`

**Android**:
- Publica shortcuts no share sheet do Android (Direct Share)
- Permite compartilhar diretamente para um webapp específico

**iOS**:
- ⚠️ **Não implementado** - wrapper retorna `false` para iOS
- iOS não tem equivalente direto; alternativa seria Share Extension com lista de apps

**Tarefas iOS**:
```
[ ] Decidir se implementar (menor prioridade)
[ ] Alternativa: mostrar lista de apps dentro da Share Extension
```

---

## 2. Activities / Navegação

### 2.1 RunnerActivity

**Android** (`android/.../RunnerActivity.kt`):
- Activity separada para executar webapps em janela independente
- Usa `FLAG_ACTIVITY_NEW_DOCUMENT` para multitasking
- Recebe `appId` via Intent extra

**iOS**:
- ❌ **Não existe equivalente**
- Usar navegação React Native padrão
- Considerar abrir em Safari ou SFSafariViewController para experiência similar

**Tarefas iOS**:
```
[ ] Avaliar se janela separada é necessária no iOS
[ ] Implementar navegação via expo-router
[ ] Considerar uso de apresentação modal fullscreen
```

---

## 3. Arquivos de Configuração

### 3.1 Android Manifest

**Localização**: `android/app/src/main/AndroidManifest.xml`

Contém:
- Intent filters para deep links (`appacadabra://`, `runapp://`)
- Share intent receiver
- RunnerActivity declarations

**iOS Info.plist Equivalente**:
```
[ ] Adicionar URL schemes (appacadabra://, runapp://)
[ ] Configurar Associated Domains se usar Universal Links
[ ] Adicionar NSCalendarsUsageDescription
[ ] Adicionar NSLocationWhenInUseUsageDescription
[ ] Adicionar NSMicrophoneUsageDescription (para speech)
```

---

## 4. Código Cross-Platform

### 4.1 Já Unificado ✅

| Funcionalidade | Biblioteca | Status |
|----------------|------------|--------|
| Calendar events | expo-calendar | ✅ Funciona |
| Notifications | expo-notifications | ✅ Funciona |
| Geolocation | expo-location | ✅ Funciona |
| File system | expo-file-system | ✅ Funciona |
| Image picker | expo-image-picker | ✅ Funciona |
| Document picker | expo-document-picker | ✅ Funciona |
| Speech-to-text | expo-speech-recognition | ✅ Funciona |
| WebView | react-native-webview | ✅ Funciona |
| SQLite | expo-sqlite | ✅ Funciona |

### 4.2 Verificações de Platform.OS

Locais no código onde há tratamento específico de plataforma:

| Arquivo | Linha | Descrição |
|---------|-------|-----------|
| `lib/bridges/SharingShortcuts.ts` | 15, 28, 40, 52 | Desabilita features Android-only |
| `lib/shortcuts.ts` | 16, 25 | Desabilita em web |
| `components/Dialogs.tsx` | 71, 165 | KeyboardAvoidingView offset |
| `app/runner/[id].tsx` | 693 | KeyboardAvoidingView behavior |
| `app/runner/[id].tsx` | 1046, 1109 | Font family (Menlo vs monospace) |

---

## 5. Prioridades de Implementação

### Alta Prioridade
1. **Build iOS funcional** - Testar o que já funciona
2. **Deep links** - Navegar para apps via URL
3. **Permissões** - Configurar Info.plist

### Média Prioridade
4. **Share Extension** - Receber compartilhamentos
5. **Siri Shortcuts** - Atalhos de voz

### Baixa Prioridade
6. **Direct Share equivalent** - Listar apps no share sheet
7. **Janela separada** - Se necessário no iOS

---

## 6. Comandos para Build iOS

```bash
# Instalar pods
cd ios && pod install && cd ..

# Build desenvolvimento
npx expo run:ios

# Build produção
eas build --platform ios
```

---

## Changelog

| Data | Alteração |
|------|-----------|
| 2026-01-10 | Documento criado com análise inicial |
