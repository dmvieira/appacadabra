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

## Nível 2 — BLE real (celular ↔ bridge no PC ↔ appa-sim) — ⚠️ PARCIAL
- **Bridge BLE no PC funciona**: `tools/ble_bridge.py` (Python 3.12 + WinRT
  `GattServiceProvider`) publica o serviço **NUS** e anuncia (status 0). O bleak não serve
  (removem o GATT server no 3.x; 0.20/0.22 não têm server no Windows).
- **App (AppaBleModule)**: bugs corrigidos durante a validação —
  1. adapter via `BluetoothManager` do `applicationContext`
     (`getSystemService` no ReactContext dava `E_NO_ADAPTER`);
  2. `hasPermission()` usando `applicationContext`;
  3. `startScan` com `ScanSettings`/filtros explícitos **e filtro pelo UUID do serviço NUS**
     (o nome anunciado pelo Windows é o nome do PC, não "fofura");
  4. erros nativos granulares (E_ADAPTER/E_STARTSCAN/E_DISCONNECTED) + stack;
  5. alerta de erro mostrando a mensagem crua.
- **Resultado atual**: o app **encontra o bridge (filtro NUS) e conecta (GATT)**, mas o
  **periférico Windows derruba o link** — `onConnectionStateChange` status **147** antes de
  qualquer troca de dados (o bridge não registra cliente assinando o TX). É limitação do
  stack BLE do Windows como *servidor* GATT, não da lógica do app/firmware.
- **Pendente para fechar o Nível 2**: validar contra o **ESP32 físico** (periférico BLE real)
  ou investigar parâmetros do GattServiceProvider (proteções/CCC/adv). O caminho de código do
  app está exercitado até a conexão.

## Nível 3 — ESP32 físico (XIAO ESP32-S3) — ⏳ PENDENTE
Firmware pronto (`appa/examples/minimal_familiar`), depende de gravar no hardware
(`arduino-cli`/Arduino IDE) e plugar o dispositivo. É a validação definitiva do BLE (o
firmware usa a mesma API NUS que o bridge, mas num rádio/periférico real).

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
