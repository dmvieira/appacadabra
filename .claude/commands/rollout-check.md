Check Appacadabra's production health for a rollout decision. Queries Firebase logs and Firestore job data.

**Rollout context (version, percentage, or timeframe to check):** $ARGUMENTS

## Steps — execute in order

### Step 1: Recent Cloud Function errors
Use `mcp__plugin_firebase_firebase__functions_get_logs` to retrieve the last 200 log entries from the `processSpellJob` function.

Look for:
- `ERROR` level entries (function crashes, unhandled exceptions)
- `CRITICAL: Failed to refund` log lines (mana refund failures — worst case scenario)
- `[Job X] failed` entries — count failures vs. total jobs
- Cold start timeouts (entries mentioning timeout after 540s)
- Any new error patterns not seen in previous runs

### Step 2: Job failure rate (Firestore)
Use `mcp__plugin_firebase_firebase__firestore_query_collection` to query the `jobs` collection:
- Filter by `status == "failed"` and `createdAt > [24 hours ago timestamp]`
- Count failed jobs vs. total jobs in the same window
- Group by `action` (create, edit, app_icon, webview_ai_*)

Calculate: **failure rate = failed_jobs / total_jobs × 100%**

Thresholds:
- < 2%: 🟢 GREEN — proceed with rollout
- 2–5%: 🟡 YELLOW — monitor, investigate root cause before expanding
- > 5%: 🔴 RED — halt rollout, investigate

### Step 3: Mana refund anomalies
Query `jobs` collection for jobs with `status == "failed"` in the last 24h.
Check if any have `preDeductedMana > 0` in their error logs (indicates a refund was attempted).
Cross-reference with function logs for `CRITICAL: Failed to refund` entries.

Any critical refund failure = 🔴 RED regardless of other metrics.

### Step 4: Recent crash signals (if adb available)
If a device is connected, run: `adb logcat -d -s AndroidRuntime FATAL | tail -20`

Look for:
- New crash signatures not seen before this version
- Any `ai.appacadabra.app` process crashes
- Firebase Crashlytics initialization failures (silent in logcat)

### Step 5: Version-specific job distribution
Query `jobs` collection for `payload.appVersion == [current version]` (if this field is logged).
Verify that jobs from the new version are completing successfully.

---

## Decision matrix

| Signal | GREEN | YELLOW | RED |
|--------|-------|--------|-----|
| Function error rate | < 1% | 1–3% | > 3% |
| Job failure rate (24h) | < 2% | 2–5% | > 5% |
| Mana refund failures | 0 | 1–2 (non-critical) | Any CRITICAL |
| New crash signatures | None | 1 minor | Any ANR/FATAL |

**Overall verdict:**
- All GREEN → recommend advancing rollout to next stage (5% → 20% → 50% → 100%)
- Any YELLOW → hold current percentage, recheck in 4h
- Any RED → halt rollout, page on-call (you), investigate root cause

---

## Output format

```
## Rollout Health Check — [timestamp]
**Version:** [from app.json]
**Current rollout:** [from argument or unknown]

### Function logs (last 200 entries)
[summary]

### Job failure rate (24h)
Total: X | Failed: Y | Rate: Z%
By action: create=X%, edit=Y%, app_icon=Z%

### Mana refund anomalies
[findings]

### Device crashes
[findings or "device not connected"]

### VERDICT: 🟢/🟡/🔴 [recommendation]
```
