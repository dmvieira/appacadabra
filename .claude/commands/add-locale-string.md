Add a new i18n string to all 17 language translations in Appacadabra.

**Usage:** `/add-locale-string key="myNewKey" en="English text here"`

**Arguments:** $ARGUMENTS

## Steps

1. Read `lib/i18n.ts` to see the full translation structure for all 17 languages:
   EN, PT, ES, FR, DE, IT, JA, ZH, KO, AR, HI, RU, TR, NL, PL, VI, TH

2. Understand the context:
   - Appacadabra uses a "magic/spell" metaphor — maintain that tone where appropriate
   - The app is used by non-technical users — keep translations simple and clear
   - Brand name "Appacadabra" is never translated (kept as-is)
   - "Spell" (the generated apps) may have local equivalents: PT: "Feitiço", ES: "Hechizo", etc.

3. Generate translations for the English source text in all 16 remaining languages.

4. For each translation:
   - Match the tone and formality level of the surrounding strings in that language
   - Preserve any React Native i18n interpolation variables like `%{name}`, `%{count}`, `%{days}`
   - For Arabic: apply RTL-aware phrasing if needed
   - For Japanese/Korean/Chinese: prefer shorter text (UI space is limited)

5. Apply a **back-translation verification** for languages you're less certain about:
   - Translate back to English and check that meaning + tone survived
   - Flag any translations with confidence < 90% for manual review

## Output format

```typescript
// Add to lib/i18n.ts inside each language object:

// EN (source)
myNewKey: 'English text here',

// PT
myNewKey: 'Texto em português aqui',

// ES
myNewKey: '...',

// [continue for all 17 languages]
```

Also output:
- A ready-to-paste block for `lib/i18n.ts` with all translations in the correct order
- A list of any translations flagged for manual review (with the back-translation shown)
- TypeScript key added to the type definition if the file uses explicit key typing
