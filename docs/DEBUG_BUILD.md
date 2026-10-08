# Build local para testar no celular (Android)

Como gerar um APK e instalar num celular plugado via USB neste ambiente
(projeto em `C:\dev\appacadabra`, acessado via WSL; toolchain Android no Windows).

> Builds de **release/play store** usam outro fluxo (AAB + keystore) — ver
> `CLAUDE.md`, seção "Processo de Release". Este doc cobre apenas o teste local.

## Pré-requisitos

- Celular com **Depuração USB** ativada (Opções do desenvolvedor).
- Ao plugar, aceitar o prompt "Permitir depuração USB?" no celular.
- Cabo em modo dados (não só carga).
- No Windows: SDK em `C:\Users\diogo\AppData\Local\Android\Sdk` e JDK do
  Android Studio (`C:\Program Files\Android\Android Studio\jbr`).
  Não há Java no WSL — **todos os comandos de build/adb rodam via `cmd.exe`**
  (ou direto no terminal Windows).

## Passo 1 — Sincronizar capabilities (obrigatório)

Antes de qualquer build:

```bash
npm run sync-capabilities
```

Sincroniza permissões das capabilities em `app.json` e `AndroidManifest.xml`.

## Passo 2 — Gerar o APK debug

Pelo WSL (usa `gradlew.bat` + JAVA_HOME do Android Studio já configurados):

```bash
# com log ao vivo no terminal
cmd.exe /c "android\_build.bat"

# silencioso, log em android\_buildlog.txt, imprime "EXITCODE <n>" no fim
cmd.exe /c "android\_build2.bat"
```

Ou direto no terminal Windows:

```bat
set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr
set ANDROID_HOME=C:\Users\diogo\AppData\Local\Android\Sdk
cd C:\dev\appacadabra\android
gradlew.bat assembleDebug
```

Saída: `android/app/build/outputs/apk/debug/app-debug.apk`

## Passo 3 — Verificar o celular

O `adb` do WSL não existe; usar o `adb.exe` do Windows:

```bash
ADB="/mnt/c/Users/diogo/AppData/Local/Android/Sdk/platform-tools/adb.exe"
"$ADB" devices -l
```

Deve listar o aparelho com status `device`. Se aparecer `unauthorized`,
desbloqueie o celular e aceite o prompt de depuração USB. Se não aparecer
nada, troque o cabo/mode USB ou reative a Depuração USB.

## Passo 4 — Instalar

```bash
ADB="/mnt/c/Users/diogo/AppData/Local/Android/Sdk/platform-tools/adb.exe"
"$ADB" install -r android/app/build/outputs/apk/debug/app-debug.apk
```

`-r` reinstala preservando dados. Para desinstalar antes:
`"$ADB" uninstall ai.appacadabra.app`.

## Passo 5 — Rodar o app

APK debug carrega o JS do **Metro**, então é preciso ter o Metro rodando:

```bash
npm start          # no WSL ou Windows
"$ADB" reverse tcp:8081 tcp:8081   # roteia a porta pro celular via USB
```

Depois abra o app no celular. Sem Metro rodando, o app fica em
"Unable to load script" — nesse caso, gere um `assembleRelease`.

### Build release local (roda sozinho, sem Metro)

```bash
cmd.exe /c "cd /d C:\dev\appacadabra\android && set JAVA_HOME=C:\Program Files\Android\Android Studio\jbr && set ANDROID_HOME=C:\Users\diogo\AppData\Local\Android\Sdk && gradlew.bat assembleRelease"
"$ADB" install -r android/app/build/outputs/apk/release/app-release.apk
```

## Atalho de uma linha (sync + build + install)

```bash
npm run sync-capabilities && \
cmd.exe /c "android\_build2.bat" && \
/mnt/c/Users/diogo/AppData/Local/Android/Sdk/platform-tools/adb.exe install -r \
  android/app/build/outputs/apk/debug/app-debug.apk
```

## Problemas comuns

| Sintoma | Causa provável | Solução |
|---|---|---|
| `adb devices` vazio | cabo só-de-carga / depuração USB off | trocar cabo, ativar depuração |
| `unauthorized` | prompt não aceito no celular | desbloquear e aceitar |
| App abre com erro de bundle | Metro não está rodando | `npm start` + `adb reverse tcp:8081 tcp:8081` |
| Build falha com erro de Java | JAVA_HOME apontando pro JDK errado | usar o JBR do Android Studio (como nos `_build.bat`) |
