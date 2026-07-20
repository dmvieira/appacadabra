# Privacy Policy - Appacadabra

**Last updated:** July 2026

## 1. Introduction

Appacadabra ("we", "our", or "the app") is a spell generation utility that connects your device to third-party AI models to create personalized tools. This Privacy Policy describes how we collect, use, and protect your information.

## 2. Information We Collect

### 2.1 Information You Provide
- **Spell descriptions:** Text you provide to generate spells
- **Generated code:** HTML/CSS/JavaScript spells created through the app
- **Settings:** Preferences and customizations for your spells

### 2.2 Information Accessed with Your Permission
The app may request access to:
- **Health Data:** With your explicit consent via Google Health Connect, we **access** health-related metrics (including Steps, Heart Rate, Total Calories Burned, Sleep Sessions, and Exercise Sessions) strictly for local processing on your device. We use this data exclusively to display your daily wellness summary and as context to generate personalized insights. **We do NOT collect, transmit, or store your health data on our or any external servers.** Your health data never leaves your device and is never sold or shared with third parties.
- **Contacts:** Only when a generated spell needs to access your contact list
- **Calendar:** To read, create, and delete events on behalf of generated spells that request it.
- **Location:** When generated spells require geolocation
- **Camera:** Used only when a generated spell requests it (e.g., scanning QR codes, taking photos). We do not access the camera without your explicit action within a spell.
- **Microphone:** Used only for voice commands or audio recording spells. We do not record audio without your explicit action.
- **Notifications:** For sending reminders and alerts

**Important:** These permissions are only requested when needed, and you can deny them at any time.

### 2.3 Data Stored Locally
- All generated spells are stored **exclusively on your device**
- Version history of your spells
- Preferences and settings
- Your OpenRouter API key, stored encrypted in your device's secure storage (iOS Keychain / Android Keystore). It is never transmitted to Appacadabra or any server we control.
- AI generation cost estimates per spell, calculated locally from token usage returned by OpenRouter and stored in the app's local database.
- An anonymous installation identifier issued by Firebase Anonymous Auth on first launch. It is used to publish spells to and learn spells from the public Store, and is not tied to any personal information you provide.

## 3. How We Use Your Information

- **Spell generation:** Your spell descriptions are sent from your device directly to OpenRouter (openrouter.ai) using your API key. OpenRouter routes them to the AI model provider you have selected (which may include Google, Anthropic, OpenAI, or others). Appacadabra does not intermediate this request or receive a copy of your descriptions.
- **Local operation:** Generated spells run locally on your device
- **Service improvement:** Anonymous analytics may be used to improve the app

Because AI model providers may be located outside your country (including the United States), your spell descriptions may be transferred internationally. These transfers are necessary to provide the core service you have requested.

### 3.1 Always-on Infrastructure Services

The following services run whenever the app is used and cannot currently be disabled from within the app:

- **Firebase Analytics:** aggregated, non-identifying usage metrics to help us improve the app.
- **Firebase Crashlytics:** automatic crash reports (including device model, OS version, and stack traces) when the app terminates unexpectedly.
- **Firebase App Check:** device attestation via Google Play Integrity (Android) or App Attest (iOS) to protect our backend from abuse.
- **Firebase Anonymous Auth:** issues the anonymous installation identifier described in Section 2.3.
- **Google Cloud Storage (`storage.googleapis.com`):** serves icons and preview assets for spells listed in the public Store.
- **Google Search & Google Maps APIs:** called on demand when a running spell uses AI capabilities that depend on them (for example, to fetch search results or geocode a location).

## 4. Data Sharing

### 4.1 OpenRouter and AI Model Providers
Spell descriptions are sent directly from your device to [OpenRouter](https://openrouter.ai), a third-party AI routing service, using your personal API key. OpenRouter forwards requests to the AI model provider you have selected. The model providers available through OpenRouter include Google, Anthropic, OpenAI, and others. Each provider's privacy policy governs how they handle your data. See [OpenRouter's Privacy Policy](https://openrouter.ai/privacy) for details.

### 4.2 We Do Not Share
- We do not sell your personal data
- We do not share information with third parties for marketing
- We do not collect contacts, calendar, or location data to our servers
- Spell descriptions leave your device only to reach OpenRouter and your chosen AI model provider — they are not sent to or stored on Appacadabra's servers

## 5. Storage and Security

- All data is stored **locally on your device**
- We do not maintain servers with your personal data
- The app uses secure connections (HTTPS) for all external communication, including requests to OpenRouter, Firebase, and Google Cloud Storage
- Your OpenRouter API key is stored using your device's hardware-backed secure enclave (iOS Keychain / Android Keystore) and is never transmitted to Appacadabra

## 6. Your Rights

You have the right to: delete any generated spell at any time from within the app; revoke device permissions at any time in your device settings; uninstall the app, which removes all locally stored data; request confirmation of what data (if any) Appacadabra holds about you by contacting us at the address below; and, where applicable under GDPR or LGPD, the right to access, correct, delete, or port your data, and to lodge a complaint with your local data protection authority. Because Appacadabra does not store your spell descriptions or device data on its own servers, most data deletion is accomplished by uninstalling the app. For any data held by OpenRouter, contact OpenRouter directly.

## 7. Children

Appacadabra is not intended for children under 13. We do not knowingly collect information from children.

## 8. Changes

We may update this policy periodically. We will notify you of significant changes through the app.

## 9. Contact

For questions about this policy, contact us:
- Email: support@appacadabra.ai
