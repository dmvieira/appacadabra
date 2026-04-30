Identify user flows in Appacadabra that are not covered by existing Maestro E2E tests.

**Focus area (optional):** $ARGUMENTS

## Steps

1. Read all existing Maestro flows in `.maestro/flows/`:
   - `01_home_sanity.yaml`
   - `02_report_bug.yaml`
   - `03_login_logout.yaml`
   - Any others present

2. Read `CLAUDE.md` for the navigation structure and key user flows.

3. Map existing flows against the following critical user journeys:

## Critical user journeys to check coverage for

### Onboarding & Authentication
- [ ] New user: first app open → see empty home screen
- [ ] New user: sign up with email → verify email → first spell creation
- [ ] Returning user: open app → already logged in → see spell list
- [ ] Login → logout → login again (existing: `03_login_logout.yaml` ✅)

### Core Spell Lifecycle
- [ ] Home screen sanity (existing: `01_home_sanity.yaml` ✅)
- [ ] Create first spell: tap FAB → describe → wait for generation → spell appears
- [ ] Run a spell: tap "Cast" → runner opens → WebView loads
- [ ] Edit a spell: open spell → type instruction → wait for AI edit
- [ ] Delete a spell: long press → delete → confirm → spell removed
- [ ] Rename a spell

### Mana System
- [ ] View mana balance in UI
- [ ] Mana depleted: attempt spell create → mana shop opens
- [ ] Purchase mana (IAP flow — may be untestable in test environment)

### Logo / Icon Generation
- [ ] Open spell setup → tap "Generate icon with AI" → icon appears
- [ ] Open spell setup → pick icon from gallery

### Import / Export
- [ ] Export spell: share → file created
- [ ] Import spell: receive shared file → spell appears in list

### Bug Report
- [ ] Report bug flow (existing: `02_report_bug.yaml` ✅)

### Edge Cases
- [ ] Network offline: attempt spell create → appropriate error shown
- [ ] Very long spell description → generation still succeeds
- [ ] Multiple spells: scroll list, search, reorder

## Output

For each uncovered flow:
1. Mark as ❌ MISSING or ⚠️ PARTIAL (if existing flow partially covers it)
2. Estimate priority: HIGH (core product) / MEDIUM / LOW
3. Generate a Maestro YAML scaffold for the top 3 highest-priority missing flows

Also report: overall coverage score as covered_flows / total_critical_flows.
