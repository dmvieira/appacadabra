# Appacadabra 🪄

**"Appacadabra"** (formerly "App Gen") is a powerful **AI Tool Generator** built with React Native (Expo) and Google Gemini. It allows users to describe a utility or tool in natural language (e.g., "A Pomodoro timer with space theme") and instantly generates a fully functional, persistent micro-app tailored to their device.

## Core Features 🚀

-   **Text-to-Tool**: Uses **Gemini 3 Flash Preview** (via Firebase Cloud Functions) to generate HTML/CSS/JS tools.
-   **Native Bridge**: Generated tools can access native device features:
    -   **Contacts**: Pick contacts directly from the generated tool.
    -   **Shortcuts**: Receive "Run Tool" intent shortcuts on Android home screen.
    -   **Biometrics**: Native authentication support.
    -   **Haptics & Sensors**: Access device vibration and sensors.
-   **Async Job Queue**: Handles complex app generation (creation/editing) in the background without timeouts, notifying the user when ready.
-   **Local Persistence**: Apps are stored locally (SQLite/FileSystem) and persist offline.
-   **Smart Editing**: Edit apps using natural language ("Make the button blue") or visual context.
-   **Direct Share**: Apps appear as share targets for other apps.

## Technology Stack 🛠️

-   **Frontend**: React Native, Expo, TypeScript, Zustand (State), NativeWind (Styles).
-   **Backend**: Firebase (Auth, Firestore, Cloud Functions).
-   **AI**: Google Gemini API (Vertex AI / Studio) via Cloud Functions.
-   **Native Modules**: Custom Expo Config Plugins (`plugins/withAppacadabraNative.js`) for Android Manifest/Kotlin tweaks.

## Architecture 🏗️

### 1. The "Spell" Engine (Generation)
-   **Client**: Submits a "Job" to Firestore `jobs` collection.
-   **Server**: `processSpellJob` Cloud Function triggers, calls complex Gemini pipelines (Planner -> Coder -> Validator).
-   **Result**: Code is compressed (GZIP) and stored in the Job document. Client polls/listens and updates local SQLite.

### 2. The "Wand" (Runtime)
-   Apps run in a simplified `WebView` environment.
-   A **Native Bridge** (`window.Appacadabra`) injects JavaScript APIs that communicate with React Native via `postMessage`.
-   Security is handled via strict CSP and sandboxing.

## Getting Started 🏁

### Prerequisites
-   Node.js > 20
-   JDK 17
-   Android Studio (for Android Emulator)
-   Firebase CLI (`npm install -g firebase-tools`)

### Installation

1.  **Clone the repository**:
    ```bash
    git clone https://github.com/your-username/appacadabra.git
    cd appacadabra
    ```

2.  **Install dependencies**:
    ```bash
    npm install
    # or
    yarn install
    ```

3.  **Environment Setup**:
    -   Create `.env` with your keys (see `.env.example`).
    -   Login to Firebase: `firebase login`.

4.  **Run Locally**:
    ```bash
    # Run the React Native app
    npx expo start --clear

    # Run Cloud Functions locally (optional)
    cd firebase/functions
    npm run serve
    ```

5.  **Build for Android**:
    ```bash
    npx expo prebuild
    npx expo run:android
    ```

## Project Structure 📂

-   `app/`: Expo Router pages (UI).
-   `components/`: Reusable React Native components.
-   `lib/`:
    -   `api/`: AI and Backend wrappers.
    -   `bridges/`: Native Bridge logic (Contacts, System, etc.).
    -   `database/`: SQLite interactions.
-   `docs/`: Project documentation and Store compliance info.
-   `firebase/`: Cloud Functions and Firestore rules.
-   `plugins/`: Custom Expo Config Plugins (Kotlin/XML modifiers).

## Contributing 🤝

Contributions are welcome! Please read `docs/CONTRIBUTING.md` (if available) or submit a PR.
