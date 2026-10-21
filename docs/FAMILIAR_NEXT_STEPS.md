# Familiar — plano e próximos passos

Semente deste doc: sessão em que implementamos o encantamento por feitiço e
diagnosticamos a lentidão/instabilidade do envio BLE. Guardado para retomar.

## Estado atual (branch `feat/familiar-wifi-setup` / appa `feat/familiar-setup`)

Já implementado e commitado:
- Setup do Familiar: picker BLE (contrato de descoberta appa), nome, Wi‑Fi com
  validação (loading, auto‑SSID atual, "Wi‑Fi conectado" desabilitado).
- Wakeword (VAD + flex_verify) e STT no firmware; `meta.model` do WebView.
- iOS: pod local `modules/appa-ble` (CoreBluetooth).
- Roteamento rico: `manifest.keywords` (geradas na forja + editáveis), dobra de
  acentos, fallback "sem match" (a IA lista os encantamentos e pergunta qual).
- Editor do encantamento (prompt + palavras‑chave) + rascunho + "Regerar com IA".
- Familiares conhecidos (status Por perto / Visto há X) + escolha.
- Envio com 1 retry em timeout + erros amigáveis (`deviceErrorKey`).
- Cache do transmute + notificação "Encantamento pronto" → tela de encantar.
- **Encantamento determinístico por feitiço**: `enc_` + base36(appId) com 6 chars
  (`encIdForSpell`/`encIdToAppId`). 1 encantamento por feitiço/device; reencantar
  ATUALIZA a versão (upsert). Write-back resolve `enc → app` decodificando o id.
- Firmware: fix do BLE — reanúncio com delay (sem watchdog de 5s), sem `reset()`.

## PROBLEMA ABERTO 1 — envio do ENCHANT lento/timeout

> **Status: RESOLVIDO E VALIDADO on-device (2026-10-19).**
> `AppaBleModule.kt`: chunk dinâmico `max(20, mtu-3)` (MTU default 23 → 20) com
> `WRITE_TYPE_DEFAULT` (sem Long Write) + `requestConnectionPriority(HIGH)` no
> connect. Espelhado em `android/...` e `native-assets/...`.
>
> Medições no **ESP32 real** (Motorola Edge 60 Pro):
> - Conectar: OK (HELLO/portrait).
> - **ENCHANT de uma spell: ~4,7 s** (antes: timeout/nunca completava).
> - Reencantar a MESMA spell (update, 2 envios): ~10 s → **v2**, sem criar extra.
> - Device (`selftest`): `encs: 3` (2 legado + novo `enc_000001`), `cofre: 2`.
>   App DB confirma `devices.encIndex.<mac> = {..., "enc_000001":1}`.
>
> **MTU 247 (#3): NÃO usar.** Testado ligando `NEGOTIATE_MTU=true`: o
> `requestMtu` derruba o GATT do ESP32 → `onServicesDiscovered` perde o NUS
> (`E_NO_NUS` / "serviço ausente"). Confirmado o aviso; mantido
> `NEGOTIATE_MTU=false`. Se quiser mais velocidade, o caminho é #2
> (`WRITE_NR` + flow control), não MTU.
> #2 (WRITE_NR) não implementado.

### Causa provável
O app fatia o ENCHANT em **chunks de 180 bytes** com `WRITE_TYPE_DEFAULT`
(`android/.../AppaBleModule.kt:58` `CHUNK=180`, `:388` `drainWrites`,
`:394` `writeCharacteristic(..., WRITE_TYPE_DEFAULT)`). Como o MTU default do
ESP32 é **23** (payload 20), cada chunk de 180 exige **Long Write**
(prepare‑write + execute‑write) do Bluedroid. Esse caminho **trava de forma
intermitente** no periférico → `onCharacteristicWrite` não volta → a fila para →
o ENCHANT nunca chega inteiro → `timeout waiting for ENCHANT_ACK`. Daí parecer
"demora muito" (fica tentando até o timeout) e às vezes falhar.

### Correções sugeridas (em ordem)
1. **Chunk = MTU‑3** (fallback 20) com `WRITE_TYPE_DEFAULT` (uma ATT Write Request
   por chunk, sem Long Write). Confiável; ~3–6 s para ~1–2 KB.
   - `CHUNK` dinâmico: guardar `mtu` (default 23) e usar `max(20, mtu-3)`.
2. (Opcional, mais rápido) `WRITE_TYPE_NO_RESPONSE` (o RX do firmware aceita
   `WRITE_NR`) com **flow control** (ex.: 1 chunk por `onCharacteristicWrite`
   não vale para NR — usar um delay pequeno / contador) — mais rápido, porém
   exige cuidado p/ não estourar o buffer de RX do ESP32.
3. (Opcional) negociar MTU 247 no connect **com callback e fallback** para 20 se
   falhar. ⚠️ Em sessões anteriores `requestMtu` derrubava o periférico — por isso
   hoje não negociamos. Se tentar, faça com try/guard e mantenha o fallback.
- Ajustar também `AppaBleModule.CHUNK` em `native-assets/.../AppaBleModule.kt`
  (o build de prebuild copia de lá) e rebuildar o APK.

### Medir antes/depois
- Tamanho real do bundle: prompt (~0.5 KB) + keywords + capabilities (+ `data` de
  relíquias). Conferir no app (transmute) para dimensionar chunks.

## PROBLEMA ABERTO 2 — `v0` no encantamento

O retrato mostra `v0` em encantamentos antigos (ids aleatórios). Com o id
determinístico o app manda `version = (versão do retrato) + 1` (≥1). Investigar
por que o device retornou 0 num bundle antigo (`EncantamentoStore::version` em
`appa/src/encantamentos/appa_encantamentos.cpp`, lê `manifest.version`).

## Concluir migração do legado (decisão B: remoção manual)

Há encantamentos antigos (ids aleatórios, ex.: 3 "CheckList da Casa"). Com o id
determinístico, o próximo encantamento cria `enc_000001`; os antigos ficam até o
usuário tocar **Remover** (por design). Nada automático.

## Validação on‑device (quando o adb sem fio estiver conectado)

1. `adb pair <ip:porta> <código>` (tela Depuração sem fio).
2. Metro na cópia Windows (`C:\dev\appacadabra`) servindo o bundle do app.
3. No app: `Meus Familiares → fofura` → conectar.
4. Abrir a spell → **Editar** → conferir editor (prompt/keywords) → **Encantar**.
5. Confirmar no device (serial, **sem tocar a COM3 durante o BLE**):
   `python C:\dev\acli\serial_send.py COM3 selftest 5` → `encs:` e `cofre:`.
6. Reencantar a MESMA spell → deve **atualizar** (mesmo `enc_000001`, versão+1),
   sem criar outro. Depois **Remover** os antigos manualmente.

## Regras de ouro do ambiente BLE (evitam "corromper" o ESP32)
- **NÃO abrir a COM3 enquanto testa BLE** (o DTR/RTS reseta/trava o chip). Para
  logs sem reset: `python C:\dev\acli\serial_read2.py COM3 60`.
- Se o Android travar: alternar o Bluetooth do celular (limpa cache GATT).
- Firmware: reanúncio **com delay** (nunca dentro do callback de disconnect).

## Arquivos-chave
- App: `lib/devices/{protocol,deviceManager,transmute,voicePrompt,bleTransport}.ts`,
  `app/devices/{index,imbue}.tsx`, `components/AppCard.tsx`, `app/_layout.tsx`,
  `android/.../AppaBleModule.kt` (+ `native-assets/...`).
- Firmware: `appa/src/arduino/{appa_ble_nus,appa_nvs_storage,appa_pdm_mic,appa_http_client}.h`,
  `appa/src/encantamentos/*`, `appa/examples/minimal_familiar/minimal_familiar.ino`,
  `appa/protocol/PROTOCOL.md`.

## Wake por voz — plano e pivô (2026-10-21)

Implementado no firmware (`appa`, branch `feat/familiar-setup`):

1. **Fase 1 ✓** — `pcm_to_wav_b64` com DC removida + pico ~-3 dBFS (ganho máx
   16×). Validado no hardware: DC -0.0 (era ~1400), silêncio a -20 dBFS.
2. **Fase 2 ✓** — wake flex reescrito: **1 STT por gatilho** + conferência
   determinística da frase (`appa_wake_match::transcript_contains`, fold +
   distância de edição; mata o viés "sim" do LLM e as respostas vazias). O
   resto da transcrição vira o comando direto ("Appa, adicionar lavar louça"
   acorda e executa numa chamada). Porta de RMS (300): silêncio nunca chama a
   nuvem. STT com `max_tokens 1024` + `reasoning exclude` (gemini não come o
   orçamento "pensando"). Comando serial **`fakeai [on|off]`**: transcrições
   enlatadas (positivas e negativas reais do log) + resposta fake — bancada
   sem gastar crédito.
3. **Fase 3 PIVOTADA** — embedder do openWakeWord é inviável no ESP32-S3: o
   próprio autor documenta *vários segundos por frame de 80ms* no S3 e os
   modelos pré-treinados são **CC-BY-NC-SA (não comercial)**. O caminho
   configurável no device é o **DTW + cadastro de voz** já implementado
   (`appa_kws`: log-mel+delta, DTW com banda, enrollment/calibração/reforço
   em NVS) — validado apenas com fixtures contaminadas (negativas contendo a
   própria frase). Pendência: recoletar fixtures limpos e re-avaliar.
4. **Fase 4 (futuro, se DTW não bastar)** — embedder no CELULAR (openWakeWord
   1,4 MB via tflite nativo; o clip vai por WiFi/TCP) ou treino de modelo
   por frase (microWakeWord via Colab + OTA). Nenhum dos dois no firmware.
