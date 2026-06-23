Validate a Firestore document operation against Appacadabra's type definitions.

**Operation or document to validate:** $ARGUMENTS

## Context

Read `lib/database/types.ts` for the TypeScript types.
Read `lib/database/db.ts` for the SQLite schema and query functions.
Read `lib/firebase.ts` for Firebase/Firestore document structures (`store_spells`, `learned_spells`).

## Validation checks

### For SQLite operations (lib/database/)
1. Does the data shape match the TypeScript type in `types.ts`?
2. Are all required fields present and correctly typed?
3. Are nullable fields handled?
4. Does the function follow the `getDatabase()` singleton pattern?
5. Are UNIQUE constraints respected? (e.g., `app_storage` has UNIQUE(appId, key))

### For Firestore documents (lib/firebase.ts / firebase/functions/src/)
1. Does the spell payload match the `StoreSpell` interface?
2. Are Firestore field types correct (FieldValue.increment vs. number)?
3. Does the document path follow conventions: `store_spells/{spellId}`, `learned_spells/{uid}/spells/{spellId}`?
4. Does any cross-user write happen only through one of the 5 callables in `firebase/functions/src/index.ts` (`publishSpell`, `unpublishSpell`, `learnSpell`, `unlearnSpell`, `syncLearnedSpells`)?

### Spend-tracking
5. Is `totalSpendUsd` (on `generated_apps`) and `costUsd` (on `webview_ai_cache`) always `number` (never string)?
6. Is `incrementSpendUsd` gated by `costUsd > 0`?

## Output

For each issue: field name, expected type, found type, and the fix.
If valid: "Schema valid ✓" with a summary of what was checked.
