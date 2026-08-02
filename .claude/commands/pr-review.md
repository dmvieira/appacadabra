Review a GitHub pull request against Appacadabra's architecture, tests, and open-source contribution standards. If no PR number is given, review the PR for the current branch.

**Target:** $ARGUMENTS

## How to fetch the diff

- If `$ARGUMENTS` is a PR number: `gh pr diff <n>`
- If `$ARGUMENTS` is empty: `gh pr view --json number -q .number` then `gh pr diff <n>`. If no PR exists yet, fall back to `git diff origin/main...HEAD`.
- Also fetch the PR description with `gh pr view <n> --json body,title,author -q '{title,author:.author.login,body}'` to check the template checklist against the actual diff.

## Layer 1 — Architecture (same 10 rules as /code-review)

For each file changed:

1. Does it follow the folder structure defined in `CLAUDE.md`?
2. Are Zustand store mutations done via `set()`? No direct state mutation.
3. Are Firebase calls routed through `lib/firebase.ts`?
4. Are capability handlers stateless (no global side-effects outside the bridge)?
5. Are new DB tables/columns reflected in `lib/database/types.ts`?
6. Is spend incremented only on success, guarded by `costUsd > 0`? Is the OpenRouter key handled exclusively via `lib/api/keyStorage.ts`?
7. Are there any new `console.log` calls that should be removed?
8. Are there TypeScript `any` types that could be narrowed?
9. Does new async code handle errors at the right boundary?
10. Are tests present or updated for changed logic?

## Layer 2 — PR-specific checks

- **PR template honesty:** Read the PR description. For each checked box, verify the diff actually satisfies the claim (e.g., if "npm test passes" is checked, are the test file changes consistent with a passing suite?).
- **Test hygiene:** `grep -nE '\.(skip|only)\(|xit\(|xdescribe\(' <changed test files>` — flag any suspicious skips.
- **Capability sync:** If any file under `lib/capabilities/` changed with a new `androidPermissions` entry, confirm that `android/app/src/main/AndroidManifest.xml` was updated in the same PR (the `sync-capabilities` script should have been run).
- **i18n coverage:** If any new key was added to `lib/i18n.ts`, either (a) all 17 locales have it, or (b) the PR body includes an explicit note "follow-up: batch-translate via /add-locale-string." Flag as ⚠️ if neither.
- **Firebase Functions:** If any file under `firebase/functions/src/` changed, confirm at least one test was added/updated in `firebase/functions/src/__tests__/`. Callable handlers untested are ⚠️ HIGH.
- **Security touchpoints:** If the diff touches any of `lib/bridges/`, `lib/api/keyStorage.ts`, `lib/api/openrouter.ts`, `firebase/functions/`, `firebase/firestore.rules`, or `android/app/src/main/AndroidManifest.xml` — add an explicit "security review needed on <file>" note in the output. Do not silently pass.
- **Secrets:** `grep -nE '(sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_\-]{35}|-----BEGIN [A-Z ]*PRIVATE KEY-----|serviceAccountKey\.json)'` across the diff. Any hit is 🔴 CRITICAL.
- **Direct-to-main gap:** If the diff was landed straight on `main` without going through a PR (i.e., `gh pr view` returns nothing but recent commits touch protected paths), flag as ⚠️ workflow violation and recommend reverting into a branch.

## Layer 3 — External-contributor courtesy

- Is the author a first-time contributor (check `--json author -q .author.login` against `git log --format='%an' | sort -u`)? If yes, note it — reviews for first-timers should include one encouraging line and be extra explicit about next steps.
- Does the PR title follow Conventional Commits (`feat(scope): …`)? If not, suggest a rewrite (do not block on this alone).

## Output

Severity-sorted findings, each with `file:line`, description, and recommended fix. Use these markers:

- 🔴 CRITICAL — must fix before merge (broken invariant, secret leaked, tests broken)
- 🟠 HIGH — should fix before merge (untested handler, missing i18n, workflow violation)
- 🟡 MEDIUM — worth addressing (style, `any`, borderline abstractions)
- 🟢 LOW — nit, optional
- ℹ️ INFO — context for the reviewer, no action required

End with **one** of:

- **Merge recommendation: APPROVE** — nothing above 🟡, invariants intact.
- **Merge recommendation: COMMENT** — 🟡 issues that reviewer can call out but not gate on.
- **Merge recommendation: REQUEST CHANGES** — any 🔴 or 🟠 present.
