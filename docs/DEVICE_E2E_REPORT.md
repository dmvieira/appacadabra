# E2E Familiar — Relatório de validação (Appacadabra ↔ appa)

Data: 2026-10-17/18 · Host: Windows 11 + WSL2 (Ubuntu) · Device: Motorola Edge 60 Pro (Android, USB)

## Objetivo
Validar a integração ponta a ponta entre o app Appacadabra e o runtime do
dispositivo (appa), sem hardware do ESP32 inicialmente, e depois com BLE real.

## Arquitetura do harness
- **Appa-sim (C++) roda NATIVO no Windows** (cross-compile zig `x86_64-windows-gnu`,
  porta winsock): `C:\dev\appa\appa-sim.exe --port 7788 --storage ... --cmdfile C:\dev\appa\cmds.txt`
  - `--cmdfile` permite injetar comandos (`ASK`, `MUTATE`) num arquivo (harness sem stdin).
- **App Android (debug) no celular físico**, bundle JS servido pelo Metro do Windows
  (`adb reverse tcp:8081`), conexão ao device via **`adb reverse tcp:7788`** (TCP, Nível 1)
  ou **BLE** (Nível 2).
- Automação de UI por **adb + uiautomator** (`.maestro/scripts/ui.js`) — o Maestro CLI não
  tem instalação nativa estável no Windows.
- Orquestrador: `.maestro/scripts/familiar-e2e.js` (setup → seed → conectar → imbuir → write-back).

## Nível 1 — TCP (app real ↔ appa-sim C++) — ✅ COMPLETO
Fluxo executado e verde repetidas vezes no celular físico:
1. **Conectar**: tela Familiares → `127.0.0.1:7788` → retrato HELLO do sim
   (`fofura-sim · host-sim · proto 1`, capabilities AI/Audio/Sheets/Forms/Docs/Calendar).
2. **Imbuir**: `appacadabra://devices/imbue?appId=900` → revisão de **permissionamento**
   (`AI → openrouter`), **relíquias** (`tarefas`), prompt de voz (fallback sem chave) →
   ENCHANT_ACK (`stored:true`).
3. **Write-back**: `MUTATE <encId> tarefas merge {"itens":["lampada da sala"]}` injetado no
   sim → WRITEBACK → `applyMutations` merge → `app_storage.tarefas` atualizado
   (verificado no SQLite do app) e texto "N mutações aplicadas" na UI.

Evidências: `C:\dev\appa\e2e\familiar_conectado.png`, `imbue_revisao.png`,
`imbue_encantado.png`, `familiar_writeback.png`.

## Nível 2 — BLE real (celular ↔ ESP32 físico) — ✅ COMPLETO
Validado em **2026-10-18** contra o **XIAO ESP32-S3 real** (periférico BLE NUS), com o
celular em **ADB over Wi-Fi** (sem USB — a única porta USB ficou para o ESP32).
- **Conectar**: tela Familiares → *Procurar Familiares (Bluetooth)* → scan filtrado pelo
  UUID do serviço NUS → conecta no `fofura` → assina o TX (notify) → recebe o **HELLO**.
- Retrato renderizado: `fofura · XIAO_ESP32S3 · fw 0.1.0 · proto 1`, capabilities
  AI/Audio/Sheets/Forms/Docs/Calendar, wake `button`.
- **Provisionamento de Wi-Fi (novo)**: a tela de Familiares (e o ritual de imbuir, quando a
  spell exige `net`) envia **`GRANT_POWER wifi`** com token `{ssid, pass}`; o Cofre do
  dispositivo passa a listar `wifi` no HELLO seguinte. Evidência: `wifi-portrait.png`
  (`PODERES CONCEDIDOS: wifi`, SSID `CyberNet` lembrado; a senha não é persistida no app).
- **Conexão de fato (novo)**: o firmware lê o token do Cofre e chama `WiFi.begin` (no boot e
  ao receber `GRANT_POWER wifi`, **fora da task do BLE** — rodar na task do BLE travava a
  resposta `OK` do GRANT_POWER, causando timeout no app); `REVOKE_POWER wifi` desconecta. O
  HELLO passou a expor `device.net {ssid, status, ip}` e o app mostra a linha de rede.
  **Validado conectado** com a senha real: `wifi status=3 ssid='CyberNet' ip=192.168.0.217`.
- **Bridge BLE no PC (Windows GattServiceProvider)** segue como *fallback* dev: o stack do
  Windows como servidor GATT derruba o link (status 147) — limitação do Windows, não do
  app/firmware. O caminho de produção agora é o ESP32.

Correções de código desta rodada:
- `AppaBleModule.kt`: **faltava `discoverServices()`** no `onConnectionStateChange(CONNECTED)`
  — sem isso o NUS nunca era encontrado e o CCCD/notify nunca assinado (o connect ficava
  pendurado). Também: subscribe ao TX resolvia o `connect()` mas nada mais acontecia.

## Nível 3 — ESP32 físico (XIAO ESP32-S3) — ✅ COMPLETO
Fluxo BLE ponta-a-ponta verde com o hardware real (celular em Wi-Fi, sem USB no celular):
- **Toolchain**: ESP32 core `esp32:esp32@3.3.12` via `arduino-cli` (Windows); sketchbook
  `C:\dev\Arduino` (lib `appa` + `ArduinoJson` 7.4.2).
- **Compila** (`--fqbn esp32:esp32:XIAO_ESP32S3`), **grava** em `COM3` (verify OK) e **boota**:
  `storage: ok`, `ble: advertising`, `[appa] pronto. Aparelho: 'fofura' (NUS)`.
- **Correções no `src/arduino/` + exemplo** (Fase E, nunca havia compilado no core 3.x):
  1. `appa_ble_nus.h`: `BLEDevice::init(String)`; `getValue()` retorna `String`.
  2. `appa_nvs_storage.h`: `getString`/`putString` com `String`; `removeValue` → `remove`.
  3. `minimal_familiar.ino`: faltava `#include <ArduinoJson.h>`.
  4. **HELLO no subscribe**: o cliente espera HELLO logo após conectar; o firmware agora o
     envia quando o central assina o TX (`BleNus::on_subscribe`), via `poll()` no `loop()`
     (fora da task da stack BLE).
  5. **Flow control do TX**: `notify()` é fire-and-forget e maiores que MTU-3 são descartados
     — `write_tx` enfileira e `poll()` drena **1 chunk de 20 B por iteração** (protegido por
     `portMUX`), e o `FrameDecoder` do cliente remonta o stream.
  6. **HELLO completo**: o firmware passou a incluir `wake` (modes/active/phrase/threshold) e
     `storage.freeKb` — a ausência de `wake` quebrava a renderização no app.

## Fase F — Setup do Familiar (nome, Wi‑Fi, picker) — ✅ código · ⏳ hardware
Contrato de descoberta (PROTOCOL.md §3.1.2): o firmware **anuncia o serviço appa**
`61707061-0000-1000-8000-00805f9b34fb` com **1 byte de estado** em Service Data
(`0` = novo, `1` = configurado) e o nome no scan response. O app filtra o scan por
esse UUID — o picker lista só "Familiares a configurar" (o NUS segue como transporte,
descoberto no GATT ao conectar).
- **Picker**: a tela Familiares mostra a lista de Familiares encontrados (nome,
  estado, RSSI) e conecta no escolhido — não auto-conecta mais no mais forte.
- **Nome**: campo "Nome pelo qual será chamado" → `SET_CONFIG { name }`; o firmware
  persiste `config:name`, atualiza o advertising e passa a reportar o nome no HELLO.
- **Wi‑Fi**: senha com "Ver/Ocultar"; a senha só é lembrada **após conexão
  confirmada** (antes era gravada mesmo com senha errada); a falha agora diferencia
  senha errada (`WiFi.status` 4) de rede ausente (status 1).
- **Firmware**: `wifi_connect_from_cofre()` faz `WiFi.disconnect(false, true)` antes
  do `WiFi.begin()` + `setAutoReconnect(true)` — a troca de rede não fica presa na
  antiga (provável causa do "nenhuma senha conecta").
- **iOS**: pod local `modules/appa-ble` (Expo Module, CoreBluetooth) espelhando o
  contrato JS do `bleTransport` — autolinkado pelo Expo (sobrevive ao prebuild),
  como `share-intent`/`shortcuts`. `NSBluetooth*UsageDescription` no Info.plist.
  (Sem `AppaNetModule` no iOS — o SSID é digitado; o app já trata `null`.)

Pendente: **gravar o firmware** (o COM3 estava ocupado/inoperante nesta máquina na
rodada) e validar picker/renomear/estado no celular.

## Como rodar o Nível 1
```bash
# 1) sim no Windows (uma vez):
#    C:\dev\appa\appa-sim.exe --port 7788 --storage C:\dev\appa\sim-e2e --name fofura-sim --cmdfile C:\dev\appa\cmds.txt
# 2) Metro no Windows (bundle do app debug):
#    cd /d C:\dev\appacadabra && npm start
# 3) no WSL:
ANDROID_HOME=/tmp/opencode/android-sdk-bridge node .maestro/scripts/familiar-e2e.js --serial <sn>
# (--skip-setup reaproveita o estado já semeado)
```

## Lições / notas de ambiente
- Metro em `--clear` nesta máquina leva ~7 min; mudanças JS só valem se o bundle em cache do
  app (`files/BridgelessReactNativeDevBundle.js`) for removido ou o Metro reiniciado.
- O celular não tem binário `sqlite3`: o seed/estado é gerado no WSL (python) e empurrado
  (`adb exec-out run-as cat` → patch → push).
- Modo de backup semeado como `none` (`appacadabra_backup_prefs`) para pular o modal nos testes.
- Tela do celular mantida ligada (`svc power stayon true`, screen_off_timeout máx).
