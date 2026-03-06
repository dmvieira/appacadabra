# Racional de Precificação — Mana (appacadabra)

Última atualização: 2026-03-05
Versão implementada: 1.1.0

---

## 1. Cadeia de custo por mana — preços antigos (R$4,90 / R$19,90 / R$44,90)

Para cada mana vendido, o budget real disponível para AI compute era:

```
                      mana_10     mana_50     mana_120
Preço bruto/mana:    R$0,49      R$0,398     R$0,374
                     ($0,084)    ($0,068)    ($0,064)
− Google Play 30%:   $0,025      $0,020      $0,019
= Dev recebe:        $0,058      $0,048      $0,044
− IR PF 27,5%:       $0,016      $0,013      $0,012
= Após imposto:      $0,042      $0,035      $0,032
− Infra Firebase:    $0,003      $0,003      $0,003
= Disponível AI:     $0,039      $0,032      $0,029
− Lucro alvo 20%:    $0,008      $0,006      $0,006
= Budget AI:         $0,031      $0,026      $0,023
```

**Problema:** o custo médio de um spell edit era ~$0,060 e create ~$0,036.
Com budget de $0,023–$0,031/mana, a operação perdia dinheiro em 100% dos edits.

---

## 2. Preço mínimo por mana para cobrir spells

Para cobrir o edit médio ($0,060) com 20% de margem sobre AI compute:

```
AI budget necessário:      $0,060
Antes do lucro (÷0,80):   $0,075
+ Infra:                   $0,003
= Disponível antes IR:     $0,078
Antes IR 27,5% (÷0,725):  $0,108
Antes Google 30% (÷0,70): $0,154 gross/mana
Em BRL (× R$5,85):        R$0,90/mana mínimo
```

---

## 3. Novos preços dos pacotes (implementados)

| Pacote  | Preço antigo | Preço novo | Mana | R$/mana | AI budget* | Edit avg | Create avg |
|---------|-------------|------------|------|---------|-----------|----------|------------|
| Starter | R$4,90      | **R$9,90** | 10   | R$0,99  | $0,066    | ✅ +10%  | ✅ +83%    |
| Popular | R$19,90     | **R$44,90**| 50   | R$0,898 | $0,060    | ✅ ~0%   | ✅ +67%    |
| Pro     | R$44,90     | **R$99,90**| 120  | R$0,833 | $0,055    | ⚠️ −8%   | ✅ +53%    |

*Budget AI = receita bruta após Google 30% + IR PF 27,5% + infra $0,003 + lucro 20%

> Pro ainda perde ~$0,005 no edit médio — aceitável porque a maioria dos usos são
> creates e webview_ai (mais baratos). Para cobrir edits no Pro 100%: precisaria R$109,90.

**Constante de referência adotada:** `MANA_VALUE_USD = 0.060`
(1 mana ≡ $0,060 de AI compute, baseado no mana_50 — ponto de equilíbrio do negócio)

---

## 4. Por que migrar de PRICING_TABLE flat para billing dinâmico

**Vantagens:**
- Input/output cobrados assimetricamente (igual ao custo real da API)
- Cached tokens a 25% do input (desconto real repassado ao usuário)
- Search e Maps cobrados apenas quando realmente chamados (detectado em `groundingMetadata`)
- Único lugar para atualizar preços: `USD_PRICING` em `index.ts`
- Consistente com TTS (que já usava lógica similar)

---

## 5. Detecção de chamadas reais de tools

### Google Search


Preço por chamada: `$0,014` (gemini-3-flash-preview) / `$0,035` (gemini-2.5-flash)

### Google Maps


Preço por chamada: `$0,025` (todos os modelos — custo da API Maps independe do LLM)

---

## 6. USD_PRICING — tabela de custos da API

```
Modelo                       Input/M    Output/M   Search/query  Maps/query
──────────────────────────────────────────────────────────────────────────────
gemini-3-flash-preview        $0,50      $3,00       $0,014        $0,025
gemini-2.5-flash              $0,30      $2,50       $0,035        $0,025
gemini-2.5-flash-lite         $0,10      $0,40       —             $0,025
gemini-2.5-flash-preview-tts  $0,50     $10,00       —             —
gemini-embedding-001          $0,15      $0,00        —             —
```

Thinking tokens são cobrados ao preço de output (incluídos em `billableOutput`).
Cached tokens são cobrados a 25% do input price.

---

## 7. Exemplos de verificação (webview_ai)

### 7.1 Sem search (5K input + 2K output, gemini-3-flash-preview)

```
Input:  5.000 × $0,50/M  = $0,0025
Output: 2.000 × $3,00/M  = $0,0060
Search: 0 queries         = $0,0000
Total USD: $0,0085
Mana: $0,0085 / $0,060   = 0,14 mana
```

### 7.2 Mesma call com 2 searches reais

```
Tokens:  $0,0085
Search:  2 × $0,014       = $0,0280
Total USD: $0,0365
Mana: $0,0365 / $0,060   = 0,61 mana
```

### 7.3 Tool disponível mas modelo não chama

```
webSearchQueries.length = 0 → sem custo de search
Mana: igual ao caso 7.1 → 0,14 mana  ✅ justo
```

### 7.4 gemini-2.5-flash, 10K input + 3K output + thinking 5K + 1 search

```
Input:    10.000 × $0,30/M   = $0,0030
Output:    3.000 × $2,50/M   = $0,0075
Thinking:  5.000 × $2,50/M   = $0,0125
Search:    1 × $0,035         = $0,0350
Total USD: $0,0580
Mana: $0,0580 / $0,060       = 0,97 mana
```

---

## 8. TTS — migração para calculateCostUsd

### Antes (divisores hardcoded)

```typescript
const inputCost  = u.promptTokens   / 200_000;   // equivalente a $0,50/M ÷ $0,060 = 8,3M tokens/mana
const outputCost = u.responseTokens / 10_000;    // equivalente a $10/M ÷ $0,060 = 167K tokens/mana
creditsUsed = inputCost + outputCost;
```

Os divisores eram derivados de $0,030/mana (budget antigo), não de $0,060.

### Depois (uniforme)

```typescript
const ttsCostUsd = calculateCostUsd('gemini-2.5-flash-preview-tts', usage);
creditsUsed = ttsCostUsd / MANA_VALUE_USD;
```

### Exemplo: 200 input + 5.000 output tokens

```
Input:   200 × $0,50/M  = $0,0001
Output: 5.000 × $10/M   = $0,0500
Total USD: $0,0501
Mana: $0,0501 / $0,060  = 0,84 mana
```

---

## 9. Imagem e Vídeo — sem alteração (loss leaders)

| Feature    | Custo API | Mana cobrado | Budget recebido | △ |
|------------|-----------|--------------|-----------------|---|
| Imagem     | $0,040    | 0,5          | $0,030          | perde $0,010 |
| Vídeo Fast | $0,15/s   | 2,0/s        | $0,120/s        | perde $0,030/s |
| Vídeo Std  | $0,40/s   | 5,0/s        | $0,300/s        | perde $0,100/s |

Imagem e vídeo são loss leaders sustentados por ad revenue e mana não consumida.
Para cobrir 100%: imagem = 1 mana, vídeo fast = 3 mana/s, vídeo std = 7 mana/s.

---

## 10. Spell create/edit — sem alteração

Custo fixo: **1 mana** por job (create ou edit).

```
1 mana × $0,060/mana = $0,060 budget AI
Edit avg: ~$0,060 → break-even no mana_50 ✓
Create avg: ~$0,036 → +67% margem ✓
Spell max (~71K tokens): ~$0,106 → perde $0,046 (estimado ~5% dos jobs)
```

---

## 11. MANA_COST_USD para anúncios (rewarded ads)

Com o novo valor gross do mana_10 ($0,169/mana), usar $0,17 mantém os ads
gerando mana proporcional ao novo preço dos pacotes.

> Valor anterior: $0,09 (calibrado para o preço antigo de ~$0,084 gross/mana)

---

## 12. Impacto final para o usuário

| Feature | Antes | Depois | △ usuário |
|---------|-------|--------|-----------|
| Pacotes de mana | R$4,90/R$19,90/R$44,90 | R$9,90/R$44,90/R$99,90 | 🔴 ~2× mais caro |
| webview_ai input-heavy | 1M tokens ≈ 42 mana | 1M input ≈ 8 mana | ✅ muito mais barato |
| webview_ai output-heavy | idem | 1M output ≈ 50 mana | 🔴 mais caro (correto) |
| webview_ai + 1 search real | sempre cobrado | só se chamado | ✅ mais justo |
| webview_ai + 3 searches | ~idem 1 search | 3× custo search | 🔴 correto e esperado |
| webview_ai sem search | idem | sem custo search | ✅ correto |
| TTS | /200K input + /10K output | calculateCostUsd ÷ $0,060 | 🔴 ligeiramente mais caro |
| Imagem | 0,5 mana | sem mudança | — |
| Vídeo | 2/5 mana/s | sem mudança | — |
| Spell create/edit | 1 mana | sem mudança | — |

