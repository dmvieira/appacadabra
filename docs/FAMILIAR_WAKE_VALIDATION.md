# Wake local (enrolled DTW) — validação de bancada

Pré-req: firmware atual (VAD recalibrado, áudio normalizado, comando
`enroll`/`match` na serial e cadastro pelo app).

## 1. Capturar fixtures limpos (COM3 livre, appalog rodando)

```powershell
cd C:\dev\acli
python appalog.py                 # janela 2: acompanha
# na janela 1, para cada captura:
python hw_cmd.py COM3 cmd.txt 8   # cmd.txt = "dumpv 3"
#   fix1: fale "Appa" (1x, tom normal)
#   fix2: fale "Appa" (de novo)
#   fix3: fale "Appa" (de novo)
#   fix4: "Appa, adicionar lavar louca" (frase completa)
#   fix5/6: AMBIENTE (tv/fala alheia, SEM você)
```

Salvar os WAVs (`getwav.py COM3 0 nome.wav`) em `appa/host/tests/fixtures/`
como `enroll_1..3.wav` (substituir as antigas) + `pos_1.wav`, `neg_1..2.wav`.

## 2. Avaliar o matcher no host

```bash
cd ~/workspace/appa && bash scripts/build_host.sh
# o doctest de fixtures roda sozinho: razao dneg/dpos > 2 = aprovado
```

Critério: razão > 2 e commit aceito → `enroll` no device (serial ou app) →
`match 3` com a frase = WAKE; com TV = descarta.

## 3. Ativar no device

Serial: `enroll` (3x a frase + 6s silêncio) → modo `enrolled` gravado.
Voltar pro flex: `forget`.
