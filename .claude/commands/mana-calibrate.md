Recalculate Appacadabra's mana costs based on current AI API pricing.

**Updated pricing (paste new rates, or leave empty to use values from codebase):** $ARGUMENTS

## Steps

1. Read `firebase/functions/src/utils.ts` to find the current pricing constants:
   - `MANA_VALUE_USD` (price per mana unit in USD)
   - Model pricing tables (per MTok input/output for each model)
   - Fixed costs (image generation, TTS, etc.)
   - `FIXED_COST_CREATE_EDIT` (flat cost for spell create/edit operations)

2. Read `lib/capabilities/ai.ts` and `lib/capabilities/audio.ts` to understand which operations consume mana and at what estimated rates.

3. If new pricing was provided as argument, compare against current pricing and calculate the delta.

## Analysis to perform

**⚠️ Nota:** `gemini-3.1-flash-image-preview` (usado em Logo Gen, Image Gen, webview_ai_image) pode estar ausente do dicionário `USD_PRICING` em `utils.ts`. Se o custo aparecer como $0 ou não for encontrado, adicionar a entrada de pricing antes de usar esta calibração. Verificar `firebase/functions/src/utils.ts` na chave `USD_PRICING`.

For each AI operation, calculate:

| Operation | Model | Estimated tokens (avg) | Current cost (USD) | Current cost (mana) | Margin at current mana price |
|-----------|-------|------------------------|---------------------|----------------------|------------------------------|
| Spell Create | gemini-3-flash-preview | ~8K in, ~4K out | $X | Y mana | Z% |
| Spell Edit | gemini-3-flash-preview | ~12K in, ~2K out | $X | Y mana | Z% |
| Logo Gen | gemini-3.1-flash-image-preview | fixed | $0.04 | 0.5 mana | Z% |
| AI Generate (text) | gemini-3-flash-preview | varies | $X | estimated | Z% |
| TTS | gemini-2.5-flash-preview-tts | varies | $X | estimated | Z% |
| Image Gen | gemini-3.1-flash-image-preview | fixed | $X | estimated | Z% |
| Video Gen | varies by duration | varies | $X | estimated | Z% |
| Similarity | gemini-embedding-001 | varies | $X | estimated | Z% |

## Recommendations

- Flag any operation where margin < 30% (below target)
- Flag any operation where pricing changed by > 20% from previous rates
- Recommend updated `MANA_VALUE_USD` or per-operation mana amounts if adjustments are needed
- Show the impact on user experience: how many spell creates does a typical mana bundle support?

## Output

Ready-to-apply changes to `firebase/functions/src/utils.ts` if recalibration is needed.
