Calibrate `lib/api/pricing.ts` against current OpenRouter pricing so the cost-estimate modal and `totalSpendUsd` tracking stay honest.

**Updated pricing (paste new rates per model, or leave empty to audit current values):** $ARGUMENTS

> Post-BYOK (3.0.0): there is no mana, no margin, no IAP. The app is free; users pay OpenRouter directly. This command's only job is to keep client-side rates aligned with the provider so the modal estimate and the recorded `totalSpendUsd` match what OpenRouter actually bills.

## Steps

1. Read `lib/api/pricing.ts` and extract:
   - `MODELS` (the OpenRouter model IDs per operation)
   - `USD_PRICING` (per-MTok input/output rates, plus optional audio/search add-ons)
   - Fixed-unit constants: `USD_IMAGE_PER_UNIT`, `USD_VIDEO_PER_SECOND_FAST`, `USD_VIDEO_PER_SECOND_STD`, `USD_PER_INPUT_IMAGE`

2. If `$ARGUMENTS` was provided, parse new rates and diff against the codebase values. Otherwise, compare the codebase values against current OpenRouter published rates (note: this requires the caller to verify against openrouter.ai/models; you cannot fetch live rates from this command).

3. Read `lib/api/openrouter.ts` to confirm how `usage.cost` flows back from OpenRouter responses — if OpenRouter returns its own cost field, that's the source of truth; `calculateCostUsd` is the fallback estimate.

4. Read `components/CostEstimateModal.tsx` and `estimateUsd` in `pricing.ts` to verify the modal's pre-call estimate uses the same model + math as the post-call recording.

## Analysis to perform

For each model in `USD_PRICING`, output:

| Model | In/Out per MTok (codebase) | In/Out per MTok (current OpenRouter) | Delta | Action |
|-------|-----------------------------|---------------------------------------|-------|--------|
| deepseek/deepseek-v4-flash | $0.14 / $0.28 | $X.XX / $X.XX | +/-Y% | none / update |
| google/gemini-3.1-flash-lite | $0.10 / $0.40 | $X.XX / $X.XX | +/-Y% | none / update |
| google/gemini-3.1-flash-image-preview | $0.10 / $0.40 | ... | ... | ... |
| google/gemini-2.5-flash-image | $0.30 / $2.50 | ... | ... | ... |
| google/gemini-3.1-flash-tts-preview | $0.50 / $10.00 | ... | ... | ... |
| google/gemini-embedding-001 | $0.15 / $0 | ... | ... | ... |

For each fixed-unit constant, output:

| Constant | Codebase value | Current OpenRouter | Delta | Action |
|----------|----------------|---------------------|-------|--------|
| USD_IMAGE_PER_UNIT | $0.04 | ... | ... | ... |
| USD_VIDEO_PER_SECOND_FAST (veo-3.1-lite) | $0.25 | ... | ... | ... |
| USD_VIDEO_PER_SECOND_STD (veo-3.1-fast) | $0.65 | ... | ... | ... |
| USD_PER_INPUT_IMAGE | $0.10 | ... | ... | ... |

## Recommendations

- Flag any rate drift > 10% from codebase to live (silent UX regression: modal misleads users).
- Flag any model in `MODELS` that is missing from `USD_PRICING` (cost will report $0 silently).
- Flag any operation where `estimateUsd()` (pre-call modal) diverges from `calculateCostUsd()` at typical usage by > 20%.
- If `usage.cost` from OpenRouter is being ignored anywhere in favor of the estimate, flag it — provider-reported cost should win whenever it exists.

## Output

Ready-to-apply `Edit` patches against `lib/api/pricing.ts` only. Do not propose changes to any other file from this command — model selection (`MODELS`) and estimate heuristics live elsewhere and are owned by the Engineering Agent.
