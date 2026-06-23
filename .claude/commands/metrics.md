Query Appacadabra's Firestore data to produce a product metrics report.

**Period or focus (e.g., "last 7 days", "spell publications", "learned-spell trends"):** $ARGUMENTS

> **⚠️ POST-BYOK NOTICE (3.0.0):** `jobs`, `users.credits`, `creditLogs`, and `usageLogs` were retired with the BYOK refactor. Live writes only happen on `store_spells` and `learned_spells`. The schema below is HISTORICAL — usable only for queries over pre-3.0.0 data ranges.

## Available data sources (Firebase MCP) — HISTORICAL

The Firestore schema has:
- `jobs/{jobId}` — `action`, `status`, `createdAt`, `result.creditsUsed`, `uid`, `payload`
- `users/{uid}` — `credits`, `creditsUsed`, `rateLimit.tokensThisMinute`, `lastActive`
- `users/{uid}/usageLogs` — `action`, `creditsUsed`, `modelId`, `tokensInput`, `tokensOutput`, `createdAt`
- `users/{uid}/creditLogs` — `type` (purchase/reward/bonus), `amount`, `createdAt`

## Query sequence — execute using Firebase MCP

### 1. Active users
Use `mcp__plugin_firebase_firebase__firestore_query_collection` on `users`:
- Count documents where `lastActive > [7 days ago]` → **DAU/WAU estimate**
- Count documents where `creditsUsed > 0` → **users who generated at least one spell**

### 2. Spell creation volume
Query `jobs` collection:
- Filter `action == "create"` and `status == "completed"` (two equality filters — no index needed), limit 200
- Filter results in memory by `createdAt` for the requested period
- Count → **spells created this period**
- Average `result.creditsUsed` → **avg mana per spell**

### 3. Edit activity
Query `jobs` collection:
- Filter `action == "edit"` and `status == "completed"`, limit 200
- Filter results in memory by `createdAt` for the period
- Edit/create ratio → **engagement depth signal** (>1 edits per create = users iterating)

### 4. Failure rates
Query `jobs`:
- Filter `status == "failed"`, limit 100 — check timestamps in results, group by `action`
- Query `status == "completed"`, limit 200 — use as denominator
- Compute failure rate per action type from results

### 5. Mana consumption
Use `jobs` collection as proxy (subcollection `users/{uid}/usageLogs` requires knowing each UID — not viable for aggregation):
- Query `status == "completed"`, limit 200 — sum `result.creditsUsed` grouped by `action` → **which operations consume most mana**
- Note: per-model breakdown (`modelId`) is only available in `usageLogs`. To get it, query `users/{uid}/usageLogs` for the top 3–5 most active users (UIDs from step 1) and extrapolate.

### 6. Revenue signals
`users/{uid}/creditLogs` is a subcollection — requires UIDs known upfront. Approach:
- Query `users` where `creditsUsed > 0`, limit 20 — get UIDs of active users
- For each UID, query `users/{uid}/creditLogs` with `type == "purchase"` → count purchases and avg `amount`
- Report paying users count and avg purchase amount from sampled UIDs
- Note: this is a sample (top 20 active users), not exhaustive

## Output format

```
## Appacadabra Metrics Report
Period: [argument or last 7 days]
Generated: [timestamp]

### Users
- Active users (WAU): X
- Users with at least 1 spell: Y
- Users with credit purchases: Z (Z/X = conversion rate)

### Spell Activity
- Spells created: X
- Spells edited: Y (edit/create ratio: Z)
- Avg mana per create: X | per edit: Y

### Failure Rates
- Create failures: X%
- Edit failures: Y%
- Logo gen failures: Z%

### Mana Economy
- Total mana consumed: X
- Breakdown by operation: [table]
- Breakdown by model: [table]
- Avg mana per active user: X

### Revenue Signals
- Credit purchases: X transactions
- Avg purchase amount: Y mana
- Estimated MRR (if recurring): [calculation]

### Interpretation
[2-3 sentences on what the data means and what to watch]
```

**Note:** Some queries may require admin Firestore access. If access is denied, report which collections were inaccessible and what data is missing from the analysis.
