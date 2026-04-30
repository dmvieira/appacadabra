Validate a Firestore document operation against Appacadabra's type definitions.

**Operation or document to validate:** $ARGUMENTS

## Context

Read `lib/database/types.ts` for the TypeScript types.
Read `lib/database/db.ts` for the SQLite schema and query functions.
Read `lib/firebase.ts` for Firebase/Firestore document structures (jobs, users, creditLogs, usageLogs).

## Validation checks

### For SQLite operations (lib/database/)
1. Does the data shape match the TypeScript type in `types.ts`?
2. Are all required fields present and correctly typed?
3. Are nullable fields handled?
4. Does the function follow the `getDatabase()` singleton pattern?
5. Are UNIQUE constraints respected? (e.g., `app_storage` has UNIQUE(appId, key))

### For Firestore documents (lib/firebase.ts / firebase/functions/src/)
1. Does the job payload match the `Job` interface?
2. Is the `action` field one of the known action types?
3. Are Firestore field types correct (FieldValue.increment vs. number)?
4. Does the document path follow conventions: `jobs/{jobId}`, `users/{uid}`, `users/{uid}/creditLogs`?
5. Is `preDeductedMana` being tracked and reset correctly in the job handler?

### Mana-specific
6. Is `creditsUsed` always `number | undefined` (never string)?
7. Is the mana deduction gated by `creditsUsed > 0`?

## Output

For each issue: field name, expected type, found type, and the fix.
If valid: "Schema valid ✓" with a summary of what was checked.
