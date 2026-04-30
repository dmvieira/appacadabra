Run a privacy and compliance audit for a new Appacadabra feature before it ships.

**Feature description:** $ARGUMENTS

## Appacadabra's privacy architecture (baseline)

- All generated content stored exclusively on-device (SQLite via expo-sqlite)
- Only spell descriptions (text prompts) leave the device → sent to Google Gemini API
- Device permissions (camera, contacts, microphone, location, Health Connect) accessed only when a spell requires them
- No PII collected or stored server-side by Appacadabra
- Firebase: anonymous analytics only; Firebase Auth for user identity; Firestore for job queue
- Third-party integrations: Google Gemini API, Google Play Billing, Firebase suite, Expo push notifications

## Compliance checklist to generate

For the described feature, analyze and report on:

### GDPR (EU — Article 13 disclosure obligations)
- Does the feature introduce new data transmission outside the device?
- Does it process any personal data? (name, email, location, health, biometric)
- Is there a legal basis under Article 6 for the new processing?
- Does the Privacy Policy need updating? Which section?

### LGPD (Brazil — Lei Geral de Proteção de Dados)
- Same analysis as GDPR, with LGPD Article 7 legal bases
- Any Brazil-specific disclosure obligations?

### COPPA (US — Children's Online Privacy Protection Act)
- Does the feature involve any data collection that could apply to under-13 users?
- Is the 13+ age gate still sufficient?

### Google Play policies
- Does the feature use any sensitive permissions? (Camera, Microphone, Location, Contacts, Health)
- Does it generate AI content? (2024 disclosure requirement)
- Does it involve in-app purchases or subscription changes?
- Does it affect the Data Safety form responses?

### Health Connect (if applicable)
- Is this a health-adjacent feature? If yes, what Health Connect permissions are needed?
- Does the health capability (currently disabled) need to be enabled?

## Output

For each jurisdiction: CLEAR / REQUIRES UPDATE / BLOCKED, with specific document changes needed.
Include a "minimum viable compliance" path if the feature is blocked.
