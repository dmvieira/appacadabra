Detect anomalies in Appacadabra's key metrics by comparing recent data against a rolling baseline.

**Metric to focus on (or "all" for full scan):** $ARGUMENTS

## How this works

This command queries Firestore for recent data (last 48h) and compares it against a baseline window (7 days prior). Statistical anomaly = a metric that deviates > 2 standard deviations from its recent mean, or crosses a defined threshold.

## Query sequence — execute using Firebase MCP

### Signal 1: Job failure rate spike

Use `mcp__plugin_firebase_firebase__firestore_query_collection` on `jobs`:
- Query `status == "failed"` (equality only, limit 100) — check `createdAt` in results to split into recent (last 24h) vs. baseline (2–9 days ago)
- Query `status == "completed"` (equality only, limit 200) — same timestamp split for denominators

**Note:** No composite index for `status + createdAt`. Time-window filtering must be done from returned results, not as a Firestore filter.

Compute: recent failure rate and 7-day daily average failure rate from the result sets.

**Anomaly:** Recent failure rate > 2× baseline daily average
**Severity:** 🔴 CRITICAL if > 10% absolute, 🟡 WARNING if > 5%

---

### Signal 2: Mana consumption drop (engagement cliff)
Use `jobs` collection as proxy (`users/{uid}/usageLogs` requires per-UID queries — not viable for aggregate):
- Query `status == "completed"`, limit 200 — sum `result.creditsUsed` from results, filter by `createdAt` for last 24h vs. 7-day baseline
- Compare totals

**Anomaly:** Today's consumption < 50% of daily average
**Interpretation:** Users stopped generating — could be outage, bad UX change, or content moderation block

---

### Signal 3: Credit purchase drop (revenue signal)
`users/{uid}/creditLogs` is a subcollection — cannot aggregate across all users without UIDs.
Proxy approach:
- Query `users` where `creditsUsed > 50` (likely purchasers), limit 20 — get UIDs
- For each UID, query `users/{uid}/creditLogs` with `type == "purchase"` and check `createdAt` in last 24h vs. baseline
- This is a sampled signal, not exhaustive

**Anomaly:** 0 purchases in sample when baseline average > 0
**Note:** Weekends naturally lower — check day-of-week before alarming

---

### Signal 4: New user stall (acquisition signal)
Query `users` where `createdAt > [24h ago]`:
- Count new user documents

Compare to 7-day average of new user creations.

**Anomaly:** New users < 25% of daily average (could indicate Play Store issue, broken onboarding)

---

### Signal 5: Mana refund events (critical billing signal)
Use `mcp__plugin_firebase_firebase__functions_get_logs` to search for:
- `"CRITICAL: Failed to refund"` — any occurrence = 🔴 CRITICAL anomaly
- `"Refunded"` log lines — count refund events vs. total jobs (high refund rate = AI failing frequently)

**Anomaly threshold:** Refund rate > 15% of completed jobs

---

### Signal 6: Rate limit hits (capacity signal)
Query `users` for documents where `rateLimit.lastResetAt` was updated recently:
- Count users who hit rate limits in last 24h

**Anomaly:** > 5 users hitting rate limits → pricing/tier may need adjustment, or bot activity

---

## Output format

```
## Anomaly Detection Report
Scanned: [timestamp]
Window: last 24h vs. 7-day baseline

### Signal Status
| Signal | Recent | Baseline | Delta | Status |
|--------|--------|----------|-------|--------|
| Job failure rate | X% | Y% | +Z% | 🟢/🟡/🔴 |
| Mana consumed | X | Y avg | -Z% | 🟢/🟡/🔴 |
| Credit purchases | X | Y avg | -Z% | 🟢/🟡/🔴 |
| New users | X | Y avg | -Z% | 🟢/🟡/🔴 |
| Mana refund rate | X% | Y% | +Z% | 🟢/🟡/🔴 |
| Rate limit events | X users | Y avg | +Z | 🟢/🟡/🔴 |

### Anomalies detected
[List each anomaly with root cause hypotheses and recommended action]

### Overall health: 🟢 NOMINAL / 🟡 INVESTIGATE / 🔴 INCIDENT
```

**Limitation note:** This analysis uses Firestore document data. Behavioral analytics (session length, screen views, funnel completion) require Firebase Analytics / BigQuery export which is not accessible via this MCP. For those metrics, use the Firebase Console directly.
