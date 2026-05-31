Update an existing i18n string across all 17 language translations using OpenRouter for cost-efficient translation.

**Usage:** `/update-locale-string key="myKey" en="New English text"`  
(You may also pass `pt="..."` instead of `en` if the source is Portuguese.)

**Arguments:** $ARGUMENTS

## Steps

### 1. Check API key

Run `echo "${OPENROUTER_API_KEY:0:4}"` via Bash to confirm the key is set.  
If empty, stop and tell the user: "Set `OPENROUTER_API_KEY` in `.claude/settings.local.json` under `\"env\": { \"OPENROUTER_API_KEY\": \"sk-or-...\" }` and restart Claude Code."

### 2. Locate the key in `lib/i18n.ts`

Read the file. Search for the key in the EN block to confirm it exists and note its current value.  
Extract ~3 surrounding strings from the EN block for tone/formality context.

### 3. Call OpenRouter for all 17 translations

Build and run this Bash command, replacing `SOURCE_LANG`, `SOURCE_TEXT`, and `KEY` with values parsed from `$ARGUMENTS`:

```bash
export LOCALE_SOURCE_LANG="en"
export LOCALE_SOURCE_TEXT="The new value from arguments"
export LOCALE_KEY="theKeyFromArguments"

PAYLOAD=$(node -e "
const sourceLang = process.env.LOCALE_SOURCE_LANG;
const sourceText = process.env.LOCALE_SOURCE_TEXT;
const key = process.env.LOCALE_KEY;

const sys = \`You are a mobile app translation engine for Appacadabra, a spell/magic-themed AI app generator.
Rules:
- Never translate the brand name 'Appacadabra'
- 'Spell' equivalents per locale: pt=Feitiço, es=Hechizo, fr=Sort, de=Zauber, it=Incantesimo, ja=魔法, zh=咒语, ko=주문, ar=تعويذة, hi=जादू, ru=заклинание, tr=büyü, nl=spreuk, pl=zaklęcie, vi=phép thuật, th=คาถา
- Match the casual/friendly tone of surrounding mobile UI strings
- JA, ZH, KO: keep translations compact (UI space is limited)
- AR: use natural RTL phrasing
- Preserve any %{variable} interpolation tokens exactly as-is
- Respond with ONLY a valid JSON object, no markdown, no explanation\`;

const user = \`Translate the following \${sourceLang.toUpperCase()} string into all 17 locales.
Source (\${sourceLang}): \${JSON.stringify(sourceText)}

Return a JSON object with exactly these keys: en, pt, es, fr, de, it, ja, zh, ko, ar, hi, ru, tr, nl, pl, vi, th\`;

console.log(JSON.stringify({
  model: 'deepseek/deepseek-v4-flash',
  messages: [
    { role: 'system', content: sys },
    { role: 'user', content: user }
  ]
}));
")

RESULT=$(curl -s https://openrouter.ai/api/v1/chat/completions \
  -H "Authorization: Bearer $OPENROUTER_API_KEY" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD")

echo "$RESULT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c);
  process.stdin.on('end',()=>{
    const r=JSON.parse(d);
    if(!r.choices) { console.error('API error:', JSON.stringify(r)); process.exit(1); }
    let content = r.choices[0].message.content;
    const fenceMatch = content.match(/\`\`\`(?:json)?\s*([\s\S]*?)\`\`\`/);
    if (fenceMatch) content = fenceMatch[1].trim();
    try { JSON.parse(content); } catch(e) { console.error('Invalid JSON in response:', content); process.exit(1); }
    console.log(content);
  });
"
```

If the curl call fails or returns an error field, log it and stop — do not fall back to self-generating translations.

### 4. Verify translations

Inspect the returned JSON. For JA, ZH, KO, AR, HI, TH: mentally back-translate to confirm meaning survived. If any value looks wrong (e.g. still in English, garbled, or missing), re-run step 3 with a more explicit prompt for those specific locales.

### 5. Update `lib/i18n.ts`

Using the Edit tool, replace the value of `key: '...',` in **each of the 17 language blocks** with the translated value from step 4.

The locale order in the file is: en, pt, es, fr, de, it, ja, zh, ko, ar, hi, ru, tr, nl, pl, vi, th.

**Important:** replace only the string value, not the key name. Keep the exact indentation and quote style of the surrounding strings.

### 5b. Verify all 17 blocks were updated

Run (substituting the actual key name for `THE_KEY`):

```bash
grep -c "THE_KEY:" lib/i18n.ts
```

Output must be `17`. If less, run `grep -n "THE_KEY:" lib/i18n.ts` to identify missing locale blocks and re-apply the Edit tool for each one before continuing.

### 6. Check `website/js/translations.js`

Search the file for the same key. If found, repeat the same per-locale replacement using the same translated values from step 4.

The locale structure in translations.js is an object per language code (en, pt, es, ...). Replace the value in each locale block the same way.

### 7. Report

Output:
- The model and token usage from the API response (`r.usage`)
- Any translations flagged during back-translation review
- Confirmation: "Updated key `X` in N blocks across lib/i18n.ts [and website/js/translations.js]"
