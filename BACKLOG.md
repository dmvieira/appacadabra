# Recursos Nativos - Status de Implementação

## ✅ JÁ IMPLEMENTADOS (Bridges Nativos)

| Recurso | Bridge | Notas |
|---------|--------|-------|
| IA/Gemini | AppacadabraAI | Texto, busca, imagem input, áudio input, schema, geração de imagem |
| Text-to-Speech | AppacadabraSpeech | speak, stop, isSpeaking via expo-speech |
| Calendário | AppacadabraCalendar | Criar eventos via URL Google Calendar |
| Notificações | AppacadabraNotify | Imediatas e agendadas |
| Localização | AppacadabraLocation | GPS atual |
| Compartilhar | AppacadabraShare | Texto, URL e arquivos |
| Contatos | AppacadabraContacts | Listar, buscar, adicionar |
| Biometria | AppacadabraBiometrics | Face ID, Touch ID, Fingerprint |
| OAuth | AppacadabraAuth | Abrir URL de autenticação |
| Sensores | AppacadabraSensors | Acelerômetro, giroscópio, magnetômetro/bússola |
| Health Connect | AppacadabraHealth | Passos, sono, exercícios |
| localStorage | Nativo | Persistência automática via DB |
| Câmera (captura) | AppacadabraCamera | Tirar foto e retornar base64 |
| QR Code Scanner | AppacadabraCamera | Ler QR codes (overlay) |
| Audio Recording | AppacadabraAudio | Gravar áudio e retornar base64 |
| Screen Capture | AppacadabraScreen | Capturar screenshot da tela atual |


## ✅ JÁ IMPLEMENTADOS (Wrappers JS)

Estes recursos usam APIs nativas da Web mas possuem wrappers `Appacadabra*` para consistência:

| Recurso | Wrapper | Implementação |
|---------|---------|---------------|
| Clipboard | AppacadabraClipboard | `navigator.clipboard` |
| Device Info (Battery, Network, Vibration) | AppacadabraDevice | `navigator.getBattery`, `navigator.vibrate`, `navigator.onLine` |
| UI (Print, Browser) | AppacadabraScreen | `expo-print` (via bridge), `window.open` |

## ✅ JÁ FUNCIONA VIA WEBVIEW (Nativo sem wrapper)

Estes recursos funcionam nativamente usando tags HTML padrão:

| Recurso | Como usar | Notas |
|---------|-----------|-------|
| File Picker | `<input type="file">` | allowFileAccess habilitado |
| Audio Playback | `<audio>` / Web Audio API | mediaPlayback habilitado |
| Video Player | `<video>` | allowsInlineMediaPlayback habilitado |
| Telefone | `window.open('tel:...')` | Abre discador |
| SMS | `window.open('sms:...')` | Abre app de SMS |
| Email | `window.open('mailto:...')` | Abre app de email |
| Geolocation | `navigator.geolocation` | Já tem permissão via bridge |

## 🎯 IMPLEMENTAÇÕES FUTURAS (Requer bridge nativo)

### Prioridade Alta (alto valor, esforço médio)
| Recurso | Pacote | Notas |
|---------|--------|-------|
| (Vazio) | - | - |

### Prioridade Média
| Recurso | Pacote | Notas |
|---------|--------|-------|
| Flashlight/Torch | expo-brightness / torch | Ligar/desligar lanterna |
| Secure Storage | expo-secure-store | Armazenar dados criptografados |
| Device Info | expo-device | Modelo, OS, nome do dispositivo |

### Prioridade Baixa (alta complexidade ou uso restrito)
| Recurso | Pacote | Notas |
|---------|--------|-------|
| Bluetooth | react-native-ble-plx | 🔴 Alta complexidade, iOS restrito |
| NFC | react-native-nfc-manager | 🔴 Alta complexidade, iOS só leitura |
| AR | ARCore/ARKit | 🔴 Muito alta complexidade |
| Background Tasks | expo-background-fetch | 🔴 Limitado em ambas plataformas |
| Push Notifications (remoto) | expo-notifications + server | 🔴 Requer infra server-side |
| In-App Purchases | expo-in-app-purchases | 🔴 Complexo, review Apple/Google |

## 🔧 MELHORIAS TÉCNICAS

- [ ] **Padronizar contrato de bridges**: Criar `bridgeRegistry.ts` como source of truth para métodos, parâmetros e docs. `prompts.ts` e `messageHandlers.ts` derivam dele.
