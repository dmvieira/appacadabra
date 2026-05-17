Add a new i18n string to all 17 language translations in Appacadabra using OpenRouter for cost-efficient translation.

**Usage:** `/add-locale-string key="myNewKey" en="English source text"`  
(You may also pass `pt="..."` instead of `en` if the source is Portuguese.)

**Arguments:** $ARGUMENTS

## Steps

### 1. Check API key

Run `echo "${OPENROUTER_API_KEY:0:4}"` via Bash to confirm the key is set.  
If empty, fetch it from Firebase secrets:

```bash
export OPENROUTER_API_KEY=$(firebase functions:secrets:access OPENROUTER_API_KEY --project appacadabra-bee0f)
echo "${OPENROUTER_API_KEY:0:4}"
```

If the Firebase fetch also fails or returns empty, stop and tell the user: "Could not load `OPENROUTER_API_KEY` from Firebase secrets. Check that the secret exists with `firebase functions:secrets:access OPENROUTER_API_KEY` or set it manually in `.claude/settings.local.json` under `\"env\": { \"OPENROUTER_API_KEY\": \"sk-or-...\" }` and restart Claude Code."

### 2. Read context from `lib/i18n.ts`

Read the file and extract:
- The **insertion point**: the key `editJobStarted` in each language block (insert the new keys immediately after it)
- The **spell-term equivalents** per language (search for existing keys like `jobStarted`, `newApp`, etc. to see how each locale refers to "spell" / "feitiço")
- A sample of ~3 nearby strings per locale to understand tone and formality

### 3. Call OpenRouter for all 17 translations

Build and run this Bash command, replacing `SOURCE_LANG`, `SOURCE_TEXT`, and `NEW_KEY` with values parsed from `$ARGUMENTS`:

```bash
PAYLOAD=$(node -e "
const sourceLang = 'en'; // or 'pt' if pt= was given
const sourceText = 'The source string from arguments';
const newKey = 'theKeyFromArguments';

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
  model: 'google/gemma-4-27b-it',
  response_format: { type: 'json_object' },
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
    console.log(r.choices[0].message.content);
  });
"
```

If the curl call fails or returns an error field, log it and stop — do not fall back to self-generating translations.

### 4. Verify translations

Inspect the returned JSON. For JA, ZH, KO, AR, HI, TH: mentally back-translate to confirm meaning survived. If any value looks wrong (e.g. still in English, garbled, or missing), re-run step 3 with a more explicit prompt for those specific locales.

### 5. Write to `lib/i18n.ts`

Using the Edit tool, insert `newKey: 'translation',` immediately after `editJobStarted: '...',` in each of the 17 language blocks. Maintain the exact indentation of surrounding keys.

The locale order in the file is: en, pt, es, fr, de, it, ja, zh, ko, ar, hi, ru, tr, nl, pl, vi, th — insert in the same order you encounter each block.

### 6. Report

Output:
- The model and token usage from the API response (`r.usage`)
- Any translations flagged during back-translation review
- Confirmation that the key was written to all 17 blocks
