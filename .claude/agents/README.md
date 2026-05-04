# Appacadabra — Claude Agents Index

All agents live in `.claude/agents/`. Each is invoked by Claude Code based on task context.
Slash commands live in `.claude/commands/` and are invoked as `/command-name` in the CLI.

## Architecture note: 1 article = 1 agent

Every agent maps to exactly one blog article in the Appacadabra Chronicles series.
**Engineering and Localization share a single agent** (`engineering-agent.md`) because they are covered by a single article (Part 4: "Engineering & Localization"). The `localization-agent.md` file documents this merge and redirects to the Engineering Agent.

---

## Agents overview

| Agent | File | Department (Article) | Commands | MCPs |
|-------|------|----------------------|----------|------|
| Strategy Agent | `strategy-agent.md` | Strategy (Part 1) | — | — |
| Branding Agent | `design-agent.md` | Branding (Part 2) | `/design-brief` | — |
| UX Agent | `ux-agent.md` | UX/Product (Part 3) | `/screen-spec` | — |
| Engineering Agent *(includes Localization — merged)* | `engineering-agent.md` | Engineering & Localization (Part 4) | `/code-review` `/gen-tests` `/validate-schema` `/dependency-audit` `/stack-router` `/add-locale-string` | Firebase MCP · OpenRouter MCP |
| Finance Agent | `finance-agent.md` | Finance (Part 5) | `/mana-calibrate` | Firebase MCP |
| Legal Agent | `legal-agent.md` | Legal (Part 6) | `/compliance-check` `/policy-diff` | — |
| Analytics Agent | `analytics-agent.md` | Data Analytics (Part 7) | `/metrics` `/anomaly-detect` `/cohort-analysis` `/investor-summary` | Firebase MCP |
| Release Agent | `release-agent.md` | Release Management (Part 8) | `/release-notes` `/release-checklist` `/app-metadata` `/rollout-check` | Firebase MCP |
| Marketing Agent | `marketing-agent.md` | Marketing (Part 9) | `/draft-post` `/content-plan` `/adapt-post` | — |
| International Agent | `international-agent.md` | International Strategy (Part 10) | `/market-entry` `/glocalization-check` `/add-locale-string` | — |
| QA Agent | `qa-agent.md` | Quality Assurance (Part 11) | `/test-coverage-check` `/gen-e2e-tests` `/security-scan` | — |

**Total: 11 agents · 27 commands**

---

## All 27 slash commands

| Command | Agent | Purpose |
|---------|-------|---------|
| `/design-brief` | Branding | Visual brief + AI image generation prompt for any asset |
| `/screen-spec` | UX | Screen specification + HTML scaffold before native implementation |
| `/code-review` | Engineering | Review diff against architecture invariants and code quality rules |
| `/gen-tests` | Engineering | Generate Jest unit test scaffolding for a function or capability |
| `/validate-schema` | Engineering | Validate Firestore document shapes and SQLite schema |
| `/dependency-audit` | Engineering | Audit a new npm package before install |
| `/stack-router` | Engineering | Route task to the right model or MCP (Firebase, OpenRouter, Claude) |
| `/add-locale-string` | Engineering | Add a new i18n key across all 17 locales with back-translation verification |
| `/mana-calibrate` | Finance | Recalculate mana costs based on current or updated API pricing |
| `/compliance-check` | Legal | Privacy compliance audit for a new feature (GDPR, LGPD, COPPA, Play) |
| `/policy-diff` | Legal | Plain-language analysis of a policy change + re-consent determination |
| `/metrics` | Analytics | Product metrics report from live Firestore data |
| `/anomaly-detect` | Analytics | Detect anomalies in failure rates, mana consumption, and purchases |
| `/cohort-analysis` | Analytics | Segment users by behavior (free, paying, power users, churned) |
| `/investor-summary` | Analytics | Investor-ready summary: DAU/WAU, conversion, mana economy |
| `/release-notes` | Release | Play Store release notes for all 17 locales (≤500 chars each) |
| `/release-checklist` | Release | Pre-submission checklist (version, permissions, store listing, rollout) |
| `/app-metadata` | Release | Update Play Store listing copy (short desc, full desc, feature graphic) |
| `/rollout-check` | Release | Go/no-go for staged rollout using live Firebase logs and job failure rate |
| `/draft-post` | Marketing | Draft a post for X (thread format) or LinkedIn (narrative article) in brand voice |
| `/content-plan` | Marketing | Content calendar mapping product milestones to formats and cadences |
| `/adapt-post` | Marketing | Adapt existing content for a different platform preserving voice and insight |
| `/market-entry` | International | Market entry readiness assessment for a new country |
| `/glocalization-check` | International | Cultural compatibility audit across 10 active markets |
| `/test-coverage-check` | QA | Analyze test coverage for a file or directory |
| `/gen-e2e-tests` | QA | Generate Maestro YAML E2E flow for a user journey |
| `/security-scan` | QA | Security audit: WebView XSS, bridge, Firebase rules, secrets, permissions |

---

## MCP servers used

### Firebase MCP (`mcp__plugin_firebase_firebase__*`)
Used by: Engineering, Finance, Analytics, Release agents

Key tools:
- `firestore_query_collection` — query jobs, users collections
- `functions_get_logs` — Cloud Function error logs (processSpellJob)
- `firebase_read_resources`, `firebase_get_project` — project configuration

**Firestore index constraint:** No composite index for `status + createdAt` on `jobs`. Use single-field equality filters + in-memory time filtering on results.

### OpenRouter MCP (`openrouter__*`)
Used by: Engineering agent (bulk translation ≥5 strings via `/stack-router`)

Package: `@mcpservers/openrouterai@2.3.0`
Models: `google/gemma-4-26b-a4b-it` (primary), `openai/gpt-oss-120b` (fallback)

Configuration in `.claude/settings.json`:
```json
{
  "mcpServers": {
    "openrouter": {
      "command": "npx",
      "args": ["-y", "@mcpservers/openrouterai"],
      "env": { "OPENROUTER_API_KEY": "sk-or-..." }
    }
  }
}
```
