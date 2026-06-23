Segment Appacadabra users by behavior using Firestore data and analyze cohort patterns.

**Cohort to analyze (e.g., "users who published a spell", "users who learned > 3 spells", "new users this week"):** $ARGUMENTS

> **⚠️ POST-BYOK NOTICE (3.0.0):** Mana-purchase and credit-usage cohorts are no longer queryable for current data — the underlying collections were retired. Only `store_spells` and `learned_spells` accumulate new writes; build live cohorts from those.

## Available Firestore data for cohort segmentation

- `users/{uid}.credits` — current mana balance
- `users/{uid}.creditsUsed` — lifetime mana consumed (proxy for total engagement)
- `users/{uid}.lastActive` — last activity timestamp
- `users/{uid}/usageLogs` — per-operation AI usage history
- `users/{uid}/creditLogs` — purchase history
- `jobs/{jobId}.uid` + `jobs/{jobId}.action` + `jobs/{jobId}.status` — per-user job history

## Cohort definitions to query

Use `mcp__plugin_firebase_firebase__firestore_query_collection` to build each cohort:

### Cohort A: Power users
Criteria: `creditsUsed > [75th percentile of all users]`
- Query `users` ordered by `creditsUsed` DESC, limit 50 — top consumers
- How much of total mana consumption do they account for? (top 20% rule)
- What's their job failure rate? Query `jobs` where `userId IN [power_user_uids]` and `status == "failed"`
- What actions do they use most? For top 5 UIDs, query `users/{uid}/usageLogs` individually — group by `action`
- Risk: do they consume enough mana to be unit-economics positive?

### Cohort B: Paid users
**Note:** `creditLogs` is a subcollection — cannot filter `users` by "has a purchase" directly.
Proxy approach:
- Query `users` where `creditsUsed > 10`, limit 50 — likely candidates
- For each UID, query `users/{uid}/creditLogs` with `type == "purchase"` — confirm who actually purchased
- From confirmed purchasers: average `amount`, average `creditsUsed`, days from `createdAt` to first purchase
- Conversion timing: compare user `createdAt` to first `creditLogs` entry `createdAt`

### Cohort C: Churned users (at risk)
Criteria: `lastActive < [30 days ago]` AND `creditsUsed > 0` (had activity, now gone)
- Size of churned cohort
- What was their last action? (from usageLogs — did they hit an error?)
- Did they have remaining credits? (suggests they didn't "use up" the product)

### Cohort D: New users (last 7 days)
Criteria: `createdAt > [7 days ago]`
- How many?
- Of those, how many created at least 1 spell? (activation rate)
- Of those who activated, how many are still active today? (D7 retention signal)

### Cohort E: Custom cohort from argument
If a specific cohort was described in `$ARGUMENTS`, construct the appropriate Firestore query to identify it and analyze: size, engagement depth, mana consumption, conversion status.

## Output format

```
## Cohort Analysis Report
Generated: [timestamp]

### Cohort sizes
| Cohort | Count | % of total users |
|--------|-------|-----------------|
| Power users | X | Y% |
| Paying users | X | Y% |
| Churned (30d) | X | Y% |
| New (7d) | X | Y% |

### Key findings

**Power users (Cohort A)**
- Account for X% of total mana consumed
- Job failure rate: X% vs Y% average
- Top actions: [list]
- Unit economics: [positive/negative/unclear]

**Paid users (Cohort B)**
- Conversion rate from total users: X%
- Avg days to first purchase: Y
- Purchase retention: Z% bought again
- Engagement lift vs. free: [multiplier]x

**Churned users (Cohort C)**
- Size: X users
- Most common last action: [action]
- Had remaining credits: X% (suggests [interpretation])
- Recommended: [re-engagement strategy]

**New users — activation funnel (Cohort D)**
- New users: X
- Activated (≥1 spell): Y (activation rate: Z%)
- Still active at D7: W (retention: V%)
- Benchmark: tools apps D7 retention ≈ 25–35%

### Recommendations
[2–3 actionable recommendations based on cohort data]
```

**Limitation:** User-level data requires document-level access across the `users` collection. If Firestore rules restrict cross-user reads, some queries may fail — report which cohorts could not be computed and why.
