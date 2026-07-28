---
name: test-appacadabra
description: Run Appacadabra tests — unit (Jest) and/or E2E (Maestro). Use when the user asks to run tests, validate flows, or check if the app is working.
---

You are running tests for the Appacadabra React Native app. There are two test layers:

## 1. Unit Tests (Jest)

Command: `npm test`

- 821 tests, all passing as of 2026-05-11
- Key test files: `lib/capabilities/__tests__/`, `lib/bridges/__tests__/`
- Run a single file: `npx jest path/to/file.test.ts`

**What to check:**
- All tests pass (no known permanent failures as of 2026-05-11)
- No new failures introduced by recent changes
- If a new failure appears, investigate and fix before reporting success

### AI Quality / Metamorphic Tests

These tests live in `firebase/functions/src/__tests__/ai-quality/` and call the **live Gemini API** — they are intentionally excluded from `npm test` and the pre-commit hook to avoid API charges on every commit.

**Run only when explicitly needed** (e.g. after changing prompts, models, or the generation pipeline):

```bash
cd firebase/functions && npx jest --testPathPattern=ai-quality
```

Each test group validates a structural property of the AI pipeline (HTML validity, capability use, edit idempotency, structured output, live search). A failure means the model or prompt regressed on that property — investigate `firebase/functions/src/generators.ts` and the relevant prompt in `firebase/functions/src/index.ts`.

## 2. E2E Tests (Maestro)

Flows live in `.maestro/flows/`. Current flows:
- `01_home_sanity.yaml` — app launches and home screen renders
- `02_report_bug.yaml` — bug report menu item and form submission

### Prerequisites

1. **Emulator must be running.** Check with:
   ```bash
   C:/Users/vivia/AppData/Local/Android/Sdk/platform-tools/adb.exe devices
   ```
   If no device listed, start it:
   ```bash
   C:/Users/vivia/AppData/Local/Android/Sdk/emulator/emulator.exe -avd appacadabra_test -no-snapshot-load &
   ```
   Wait for boot:
   ```bash
   until C:/Users/vivia/AppData/Local/Android/Sdk/platform-tools/adb.exe shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; do sleep 5; done
   ```

2. **Reset device state** (always run before E2E):
   ```bash
   node .maestro/scripts/setup-device.js
   ```
   This clears app data, grants permissions, sets locale to pt-BR, skips onboarding, and verifies `support@appacadabra.ai` Google account is present.

3. **Maestro binary path** (Windows):
   ```
   C:/Users/vivia/.maestro/maestro/bin/maestro
   ```
   Or via npm: `npm run test:e2e` (runs setup + all flows).

### Running E2E

**All flows:**
```bash
node .maestro/scripts/setup-device.js && "/c/Users/vivia/.maestro/maestro/bin/maestro" test .maestro/flows/
```

**Single flow:**
```bash
node .maestro/scripts/setup-device.js && "/c/Users/vivia/.maestro/maestro/bin/maestro" test .maestro/flows/03_login_logout.yaml
```

### Known Gotcha: TcpForwarder TimeoutException

If Maestro throws `java.util.concurrent.TimeoutException` at startup (TcpForwarder), the adb server has stale port reservations from a previous session. Fix:
```bash
C:/Users/vivia/AppData/Local/Android/Sdk/platform-tools/adb.exe kill-server
C:/Users/vivia/AppData/Local/Android/Sdk/platform-tools/adb.exe start-server
```
Then re-run the flows. **Never kill the adb server while Maestro is running** — it causes background thread crashes that trigger a spurious retry run with dirty app state.

### Known Gotcha: Maestro runs the suite twice

Maestro sometimes re-runs the full suite after a successful first pass (likely triggered by an internal IOException in its TCP forwarder thread). The second run fails because `setup-device.js` wasn't called again. This is a Maestro bug, not an app bug. **Judge results by the first run** (`Passed Flows: N` line that appears first). If the process exits with code 1 but the first `Passed Flows: 3` appeared, the tests passed.

### Writing New Flows

- Flows are YAML files in `.maestro/flows/`, named `NN_description.yaml`
- Always start with `appId: ai.appacadabra.app` and `launchApp: stopApp: false`
- Use `extendedWaitUntil` (not `waitUntil`) for elements that take time to appear
- UI strings are in pt-BR (app locale forced by setup-device.js)
- `support@appacadabra.ai` is the test Google account pre-loaded on the emulator
- The `# Requires:` comment at the top of a flow documents manual prerequisites

## Execution Steps

1. Ask the user which tests to run (unit, E2E, or both) if not specified — default to both
2. Run unit tests first (fast, ~10s)
3. Check emulator status; start if needed
4. Run setup-device.js
5. Run Maestro flows
6. Report: pass count, fail count, and any failures with the failing step name
7. If a flow fails, read the full Maestro output and investigate the root cause before reporting
