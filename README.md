# Appacadabra

Gerador de micro-apps com IA. O usuário descreve o que quer e o app gera um HTML/CSS/JS completo que roda dentro de uma WebView com acesso a APIs nativas via bridge.

---

## E2E Tests (Maestro)

### Pré-requisito — instalar Maestro (uma vez)

**Windows:** Já instalado em `C:\maestro`. Certifique-se de que `C:\maestro\bin` está no PATH.

**Mac/Linux:**
```bash
curl -Ls "https://get.maestro.mobile.dev" | bash
```

---

### Fluxo completo com emulador (estado limpo)

```powershell
# 1. Subir o emulador (aguarda boot automaticamente)
powershell -File .maestro/start-emulator.ps1

# 2. Instalar o app no emulador (em outro terminal)
npm run android

# 3. Rodar todos os flows
npm run test:e2e

# Ou um flow específico
npm run test:e2e:flow .maestro/flows/02_report_bug.yaml
```

O emulador `appacadabra_test` (Pixel 6 / Android 14) já está configurado sem lock screen e com estado limpo (`clearState: true` em cada flow zera os dados do app antes de cada teste).

---

### Flows disponíveis

| Flow | O que valida |
|------|-------------|
| `01_home_sanity.yaml` | App abre, título e botão de criar feitiço visíveis |
| `02_report_bug.yaml` | Menu → Relatar bug → digitar → Enviar → modal fecha |
| `03_sign_out_keep.yaml` | Menu → Avançado → Sair → Manter → banner de sucesso *(requer login)* |

---

### Verificação visual (Vision AI)

Para validar comportamentos visuais difíceis de capturar em YAML (ex: spinner apareceu, modal fechou):

```bash
npm run vision:check "O modal de bug report está fechado?"
npm run vision:check "Is a loading spinner visible on screen?"
npm run vision:check "Is the success banner 'Signed out' visible?"
```

A chave Gemini é buscada automaticamente via Firebase Secrets. Requer `firebase login`.
