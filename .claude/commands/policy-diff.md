Analyze a proposed change to Appacadabra's Privacy Policy or Terms of Service and generate a plain-language summary.

**Proposed change (paste the diff or describe the change):** $ARGUMENTS

## Steps

1. Read `docs/PRIVACY_POLICY.md` for the current Privacy Policy text.
2. Read `docs/TERMS_OF_SERVICE.md` for the current Terms of Service text.
3. Analyze the proposed change against the current documents.

## Analysis to perform

### What changed (plain language)
- Summarize each material change in one sentence, written for a non-lawyer user
- Flag any changes that expand data collection, sharing, or user obligations

### Re-consent required?
Under GDPR Article 7 and LGPD, re-consent is required when:
- A new purpose is added that users didn't originally agree to
- A new category of personal data is being processed
- Data is being shared with new third parties not previously disclosed

Verdict: **RE-CONSENT REQUIRED / NOT REQUIRED** with reasoning.

### Play Store Data Safety form impact
Does this change require updating the Data Safety form in Play Console?
If yes: which sections? (Data collected, Data shared, Security practices)

### User communication
If re-consent or material notification is required, draft:
- In-app notification text (≤ 120 characters)
- Email subject line
- Link anchor text ("What changed and why →")

### Legal risk flags
Any clauses that might conflict with GDPR, LGPD, COPPA, or Google Play policies.
Flag as: LOW / MEDIUM / HIGH risk.
