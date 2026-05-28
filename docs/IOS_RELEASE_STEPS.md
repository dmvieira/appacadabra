# iOS Release — Passos Manuais Obrigatórios

Checklist completo de tudo o que precisa ser feito manualmente antes de publicar na App Store.
Os passos de código já foram implementados — este doc cobre apenas ações externas ao repositório.

---

## 1. Firebase Console — App iOS

**Quando fazer:** Antes de qualquer build iOS.

1. Aceder a [console.firebase.google.com](https://console.firebase.google.com) → selecionar o projeto Appacadabra
2. Project Settings → General → secção "Your apps"
3. Clicar **"Add app"** → selecionar iOS
4. Bundle ID: `ai.appacadabra.app`
5. App nickname: `Appacadabra iOS`
6. Clicar **"Register app"**
7. **Descarregar `GoogleService-Info.plist`**
8. Colocar o ficheiro na raiz do projeto: `C:\dev\appacadabra\GoogleService-Info.plist`
9. (Não adicionar ao `.gitignore` se o repositório for privado — é necessário no build)

> ⚠️ O `app.json` já tem `"googleServicesFile": "./GoogleService-Info.plist"` configurado. O build falhará sem este ficheiro.

---

## 2. Apple Developer Portal — Capabilities do App ID

**Quando fazer:** Antes do primeiro `expo prebuild --platform ios`.

1. Aceder a [developer.apple.com](https://developer.apple.com) → Account → Certificates, IDs & Profiles
2. Identifiers → procurar `ai.appacadabra.app` (ou criar se não existir)
3. Ativar as seguintes capabilities:
   - ✅ **HealthKit** — necessário para a capability de saúde
   - ✅ **App Groups** → adicionar grupo: `group.ai.appacadabra.app` — necessário para a Share Extension
   - ✅ **Push Notifications** — necessário para notificações e alarmes
4. Guardar alterações e fazer **re-download do provisioning profile** se usar provisioning manual

> ℹ️ Se usar Xcode Managed Signing (automático), as capabilities são ativadas automaticamente quando adicionadas via `app.json` entitlements.

---

## 3. Xcode — Share Extension

**Quando fazer:** Após `expo prebuild --platform ios --clean`, antes de submeter à App Store.

A Share Extension permite receber conteúdo partilhado de outras apps (texto, imagens, ficheiros).

### 3a. Criar o target

1. Abrir `ios/Appacadabra.xcodeproj` no Xcode
2. File → New → Target → **Share Extension**
3. Configurações:
   - Product Name: `ShareExtension`
   - Bundle Identifier: `ai.appacadabra.app.ShareExtension`
   - Language: Swift
4. Clicar **Finish** (dizer "Activate" se pedir)

### 3b. Adicionar App Group à Share Extension

1. Selecionar o target `ShareExtension` → Signing & Capabilities
2. Clicar **+ Capability** → selecionar **App Groups**
3. Adicionar grupo: `group.ai.appacadabra.app`

### 3c. Implementar a Share Extension

Substituir o conteúdo de `ShareExtension/ShareViewController.swift` pelo seguinte:

```swift
import UIKit
import Social
import MobileCoreServices
import UniformTypeIdentifiers

class ShareViewController: UIViewController {
    let appGroupId = "group.ai.appacadabra.app"

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        handleSharedContent()
    }

    private func handleSharedContent() {
        guard let extensionItem = extensionContext?.inputItems.first as? NSExtensionItem,
              let attachments = extensionItem.attachments else {
            extensionContext?.completeRequest(returningItems: nil)
            return
        }

        let group = DispatchGroup()
        var sharedText: String? = nil
        var sharedFileUri: String? = nil
        var sharedMimeType: String? = nil

        for attachment in attachments {
            // Text / URL
            if attachment.hasItemConformingToTypeIdentifier(UTType.url.identifier) {
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.url.identifier) { item, _ in
                    if let url = item as? URL {
                        sharedText = url.absoluteString
                    }
                    group.leave()
                }
            } else if attachment.hasItemConformingToTypeIdentifier(UTType.plainText.identifier) {
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.plainText.identifier) { item, _ in
                    sharedText = item as? String
                    group.leave()
                }
            } else if attachment.hasItemConformingToTypeIdentifier(UTType.image.identifier) {
                // Image — copy to shared container
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.image.identifier) { item, _ in
                    if let image = item as? UIImage,
                       let data = image.jpegData(compressionQuality: 0.9),
                       let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: self.appGroupId) {
                        let fileURL = containerURL.appendingPathComponent("shared_image_\(Date().timeIntervalSince1970).jpg")
                        try? data.write(to: fileURL)
                        sharedFileUri = fileURL.absoluteString
                        sharedMimeType = "image/jpeg"
                    }
                    group.leave()
                }
            } else if attachment.hasItemConformingToTypeIdentifier(UTType.data.identifier) {
                // Generic file — copy to shared container
                group.enter()
                attachment.loadItem(forTypeIdentifier: UTType.data.identifier) { item, _ in
                    if let url = item as? URL,
                       let containerURL = FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: self.appGroupId) {
                        let destURL = containerURL.appendingPathComponent(url.lastPathComponent)
                        try? FileManager.default.copyItem(at: url, to: destURL)
                        sharedFileUri = destURL.absoluteString
                        sharedMimeType = url.mimeType()
                    }
                    group.leave()
                }
            }
        }

        group.notify(queue: .main) {
            guard let defaults = UserDefaults(suiteName: self.appGroupId) else {
                self.extensionContext?.completeRequest(returningItems: nil)
                return
            }

            if let text = sharedText {
                defaults.set(text, forKey: "sharedText")
            } else if let fileUri = sharedFileUri {
                defaults.set(fileUri, forKey: "sharedFileUri")
                defaults.set(sharedMimeType ?? "application/octet-stream", forKey: "sharedFileMimeType")
            }

            // Open main app
            let url = URL(string: "appacadabra://share")!
            self.openURL(url)
            self.extensionContext?.completeRequest(returningItems: nil)
        }
    }

    @discardableResult
    private func openURL(_ url: URL) -> Bool {
        var responder: UIResponder? = self
        while responder != nil {
            if let application = responder as? UIApplication {
                return application.perform(#selector(UIApplication.open(_:options:completionHandler:)), with: url, with: nil) != nil
            }
            responder = responder?.next
        }
        return false
    }
}

extension URL {
    func mimeType() -> String {
        if let type = UTType(filenameExtension: self.pathExtension) {
            return type.preferredMIMEType ?? "application/octet-stream"
        }
        return "application/octet-stream"
    }
}
```

### 3d. Configurar Info.plist da Share Extension

No `ShareExtension/Info.plist`, verificar que `NSExtension → NSExtensionAttributes → NSExtensionActivationRule` aceita os tipos pretendidos (texto, imagens, ficheiros).

---

## 4. Google AdMob — Verificar iOS App ID

**Quando fazer:** Antes do build de release.

1. Aceder a [admob.google.com](https://admob.google.com)
2. Verificar se existe uma app iOS configurada
3. O `ios_app_id` em `app.json` está atualmente igual ao Android: `ca-app-pub-2256826632523784~6570613208`
4. Se o AdMob tiver um ID separado para iOS, atualizar em `app.json`:
   ```json
   "iosAppId": "ca-app-pub-XXXXXXXXXX~XXXXXXXXXX"
   ```

---

## 5. App Store Connect — Criar App e Configurar IAP

**Quando fazer:** Antes de submeter o build.

### 5a. Criar a app

1. Aceder a [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
2. Apps → **+** → New App
3. Configurações:
   - Platforms: iOS
   - Name: `Appacadabra`
   - Primary Language: Portuguese (Brazil) ou English
   - Bundle ID: `ai.appacadabra.app`
   - SKU: `appacadabra-ios` (identificador interno)

### 5b. Criar produtos IAP (Mana)

1. Na app criada → Monetization → In-App Purchases → **+**
2. Criar um produto para cada pacote de mana com o mesmo `productId` usado no Android
3. Para cada produto:
   - Type: **Consumable**
   - Reference Name: nome descritivo (ex: "50 Mana")
   - Product ID: usar o mesmo ID que o Google Play (ex: `mana_50`, `mana_200`, etc.)
   - Price: definir na tabela de preços
   - Display Name + Description: preencher em pelo menos inglês e português

> ⚠️ Os produtos IAP precisam de estar em estado "Ready to Submit" antes de submeter o build.

### 5c. Privacy Nutrition Labels

Em App Privacy, declarar o uso de:
- **Location** — Precise Location (used for app functionality, not linked to identity)
- **Contacts** — Contacts (used for app functionality, not linked to identity)
- **Health & Fitness** — Health (used for app functionality, not linked to identity)
- **Identifiers** — Device ID (used for analytics)
- **Usage Data** — App Interactions (analytics)

---

## 6. Build iOS

**Quando fazer:** Após completar os passos 1–4.

```bash
# 1. Descarregar dependências iOS
cd C:\dev\appacadabra

# 2. Gerar projeto iOS (requer macOS ou CI)
expo prebuild --platform ios --clean

# 3. Instalar pods (requer macOS)
cd ios && pod install && cd ..

# 4. Build de desenvolvimento
expo run:ios

# 5. Build de release (no macOS)
# Abrir Xcode → Product → Archive → Distribute App → App Store Connect
```

> ⚠️ O build iOS requer macOS. No Windows, usar um Mac físico, Mac virtual (Parallels), ou CI como Xcode Cloud / GitHub Actions com runner macOS.

---

## 7. TestFlight — Testar antes do Release

1. Após upload do build via Xcode → App Store Connect → TestFlight
2. Adicionar testadores internos
3. Testar especificamente:
   - [ ] Permissões: câmara, microfone, contactos, calendário, localização, saúde → dialogs aparecem
   - [ ] HealthKit: permission sheet aparece e dados são lidos
   - [ ] Notificações e alarmes: disparam corretamente
   - [ ] Share Extension: partilhar texto/imagem de Safari → chega ao Appacadabra
   - [ ] Deep link `appacadabra://`: abre o app
   - [ ] IAP (Mana): listar e comprar produtos em modo sandbox
   - [ ] Firebase: auth, Firestore, FCM funcionam

---

## 8. Submissão App Store

1. App Store Connect → selecionar o build do TestFlight
2. Preencher:
   - Screenshots (6.7", 6.1", iPad Pro se `supportsTablet: true`)
   - Description, Keywords, Support URL
   - Age Rating
3. Submit for Review

---

## Resumo de Prioridade

| Prioridade | Passo | Bloqueador de build? |
|---|---|---|
| 🔴 Crítico | Passo 1 — GoogleService-Info.plist | Sim |
| 🔴 Crítico | Passo 2 — Apple Developer capabilities | Sim (entitlements) |
| 🟡 Importante | Passo 3 — Share Extension | Não (app funciona sem ela) |
| 🟡 Importante | Passo 4 — AdMob iOS ID | Não (ads apenas não funcionam) |
| 🔴 Crítico | Passo 5 — App Store Connect + IAP | Sim (para submeter) |
| 🔴 Crítico | Passo 6 — Build iOS | — |
| 🟢 Recomendado | Passo 7 — TestFlight | Não (mas obrigatório por boas práticas) |
