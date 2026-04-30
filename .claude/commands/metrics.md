Query Appacadabra's Firestore data to produce a product metrics report.

**Period or focus (e.g., "last 7 days", "mana consumption", "job failures"):** $ARGUMENTS

## Available data sources (Firebase MCP)

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
- Filter `action == "create"` and `status == "completed"` and `createdAt > [period start]`
- Count → **spells created this period**
- Average `result.creditsUsed` → **avg mana per spell**

### 3. Edit activity
Query `jobs` collection:
- Filter `action == "edit"` and `status == "completed"` → **spell edits**
- Edit/create ratio → **engagement depth signal** (>1 edits per create = users iterating)

### 4. Failure rates
Query `jobs`:
- Filter `status == "failed"` grouped by `action`
- Compute failure rate per action type

### 5. Mana consumption
Query `users/{uid}/usageLogs` (sample across users if too many):
- Sum `creditsUsed` by `action` → **which operations consume most mana**
- Sum `creditsUsed` by `modelId` → **cost distribution by model**

### 6. Revenue signals
Query `users/{uid}/creditLogs`:
- Filter `type == "purchase"` → **paying users and purchase volume**
- Avg `amount` per purchase → **ARPU signal**

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
