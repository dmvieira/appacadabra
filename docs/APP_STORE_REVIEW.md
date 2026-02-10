# App Store Review Documentation - Appacadabra

## Executive Summary

Appacadabra is a **local tool generation utility** that uses AI to help users create simple web-based tools and micro-apps. This document clarifies how Appacadabra differs from app stores and complies with App Store Guidelines.

---

## Why Appacadabra is NOT an App Store

### Key Differentiators

| Aspect | App Store | Appacadabra |
|--------|-----------|-------------|
| Content Source | Downloaded from servers | Generated locally via AI |
| Binary Execution | Native executables | HTML/CSS/JS in WebView |
| Distribution | Third-party content | User's own creations |
| Monetization | In-app purchases, subscriptions | None (user's personal spells) |
| Catalog | Pre-existing apps | Generated on-demand |

### Technical Architecture

```
┌─────────────────────────────────────────────────┐
│                  User Device                     │
│  ┌─────────────┐    ┌─────────────────────────┐ │
│  │   User      │    │     Appacadabra         │ │
│  │   Input     │───▶│  ┌─────────────────┐    │ │
│  │ (text only) │    │  │ Job Queue (DB)  │    │ │
│  └─────────────┘    │  │ (Firestore)     │    │ │
│                     │  └────────┬────────┘    │ │
│                     │           │ (Async)     │ │
│                     │           ▼             │ │
│                     │  ┌─────────────────┐    │ │
│                     │  │ Cloud Functions │    │ │
│                     │  │ (Gemini AI)     │    │ │
│                     │  └────────┬────────┘    │ │
│                     │           │ (Result)    │ │
│                     │           ▼             │ │
│                     │  ┌─────────────────┐    │ │
│                     │  │ HTML/CSS/JS     │    │ │
│                     │  │ (Stored locally)│    │ │
│                     │  └────────┬────────┘    │ │
│                     │           │             │ │
│                     │           ▼             │ │
│                     │  ┌─────────────────┐    │ │
│                     │  │    WebView      │    │ │
│                     │  │ (sandboxed)     │    │ │
│                     │  └─────────────────┘    │ │
│                     └─────────────────────────┘ │
└─────────────────────────────────────────────────┘
```

---

## Guideline Compliance

### Guideline 4.7 - Mini Apps

**Requirement:** Apps should not be app stores or create interfaces to browse/download third-party content.

**How Appacadabra Complies:**
1. **No catalog/store interface** - Users describe a tool they need in natural language.
2. **No downloadable content** - Code is generated on-demand via API, not downloaded from a repository.
3. **No third-party submissions** - Only the user creates tools for their own personal use.
4. **No distribution mechanism** - Tools exist only on the user's device.

**Comparison to Approved Apps:**
- **Notion** - Users create complex databases and automations
- **Shortcuts (Apple)** - Users create automated scripts
- **Scriptable** - Users write and run JavaScript
- **Appacadabra** - Users describe spells in natural language, AI generates code

### Guideline 2.5.2 - Executable Code

**Requirement:** Apps may not download or execute code that changes features/functionality.

**How Appacadabra Complies:**
1. **No code download** - Code is generated via stateless API call
2. **WebView sandboxing** - Generated code runs in iOS WebView sandbox
3. **No native code execution** - Only HTML/CSS/JavaScript
4. **Static functionality** - The app's native features never change

**Technical Details:**
- Generated spells are stored as TEXT in SQLite, not as executable files
- WebView uses `WKWebView` with standard security policies
- No access to native APIs beyond what Appacadabra explicitly provides
- Bridge communication is strictly controlled via `postMessage`

### Guideline 4.2 - Minimum Functionality

**How Appacadabra Provides Value:**
1. **AI-powered code generation** - Complex functionality requiring LLM
2. **Native bridge features:**
   - Calendar integration
   - Contacts access
   - Notifications
   - Geolocation
   - Biometric authentication
   - Sensor access (accelerometer, gyroscope)
3. **Version history and editing**
4. **Share target functionality** - Users can share files (PDFs, images, audio, text exports) directly to spells for automatic processing:
   - Summarize WhatsApp conversation exports
   - Extract data from PDFs
   - Transcribe and analyze audio files
   - Process images and generate reports

---

## Content Moderation

Appacadabra implements content filtering to prevent misuse:

1. **Prompt validation** - Blocks requests for malicious code
2. **Pattern detection** - Rejects phishing, malware, data theft attempts
3. **AI safety** - Leverages Gemini's built-in safety filters
4. **Terms of Service** - Users agree not to create harmful content

---

## Similar Approved Apps

| App | Function | App Store Status |
|-----|----------|------------------|
| Shortcuts | User-created automations | ✅ Apple's own app |
| Scriptable | Run user JavaScript | ✅ Approved |
| Pythonista | Write/run Python code | ✅ Approved |
| Notion | Complex user-created databases | ✅ Approved |
| Figma | User-created designs | ✅ Approved |

Appacadabra follows the same principle: empowering users to create their own content.

---

## Data Privacy

- **All data stored locally** on user's device
- **No user accounts** required
- **No server-side storage** of generated spells
- Only API calls to Google Gemini for generation
- Detailed Privacy Policy included

---

## Contact for Questions

Developer: [Your Name]
Email: support@appacadabra.ai

We are happy to provide additional technical documentation, source code excerpts, or video demonstrations upon request.
