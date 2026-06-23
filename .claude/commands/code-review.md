Review the following code or diff for conformance with Appacadabra's architecture. If no argument is provided, review the current git diff (staged + unstaged).

**Target:** $ARGUMENTS

## Architecture rules (from CLAUDE.md)

- **Capabilities** live in `lib/capabilities/` and must implement `CapabilityModule` (id, displayName, minVersion, getInjectedJS, docs, handleMessage, androidPermissions, manifestBlocks)
- **Bridges** live in `lib/bridges/` — no direct native calls outside bridges
- **Store** is Zustand (`lib/store.ts`, `lib/bridgeUIStore.ts`) — no local component state for global concerns
- **Database** access only via `lib/database/db.ts` — never raw SQLite calls from components
- **Firebase** access only via `lib/firebase.ts` wrappers — never direct SDK calls from UI
- **BYOK key** invariant: OpenRouter key only ever flows through `lib/api/keyStorage.ts` (SecureStore); never logged, never written to AsyncStorage/SQLite/plaintext prefs, never returned from any bridge call
- **Spend guard** invariant: `incrementAppSpendUsd` / `db.incrementSpendUsd` only called after a successful OpenRouter response with `costUsd > 0`
- **No comments** unless the WHY is non-obvious (hidden constraint, workaround, subtle invariant)
- **No error handling for impossible scenarios** — only validate at real system boundaries
- **No features beyond what the task requires** — no premature abstractions

## Review checklist

For each file changed:
1. Does it follow the folder structure above?
2. Are Zustand store mutations done via `set()`? No direct state mutation.
3. Are Firebase calls routed through `lib/firebase.ts`?
4. Are capability handlers stateless (no global side-effects outside the bridge)?
5. Are new DB tables/columns reflected in `lib/database/types.ts`?
6. Is spend incremented only on success, guarded by `costUsd > 0`? Is the OpenRouter key handled exclusively via `lib/api/keyStorage.ts`?
7. Are there any new `console.log` calls that should be removed?
8. Are there TypeScript `any` types that could be narrowed?
9. Does new async code handle errors at the right boundary?
10. Are tests present or updated for changed logic?

Output: List each issue with file:line, severity (Critical / Warning / Suggestion), and a one-line fix.

If no argument was given, run: `git diff HEAD` and review that.
