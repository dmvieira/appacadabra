Audit the given npm package before adding it to Appacadabra.

**Package to audit:** $ARGUMENTS

## Steps

1. Read `package.json` to understand the current dependency tree (direct deps, dev deps, peer deps)
2. Read `android/build.gradle` and `android/app/build.gradle` for Kotlin/Gradle dependencies
3. For the proposed package, analyze:

### Compatibility checks
- Is it compatible with **React Native 0.81 / Expo 54 / New Architecture (Fabric)**?
- Does it require native modules? If yes, does it support the New Architecture?
- Does it have peer dependencies that conflict with our current versions?
- Does it duplicate functionality already in our stack (e.g., we already have `expo-file-system`, `expo-av`, `expo-notifications`)?

### Bundle size impact
- Is this package tree-shakeable?
- What is the approximate minified + gzipped size? (estimate from npm registry)
- Is there a lighter alternative that covers our use case?

### Security
- Check for known CVEs (mention that `npm audit` should be run after install)
- Is the package actively maintained? (last publish date, open issues)
- Does it request unusual permissions?

### Appacadabra-specific concerns
- Does this package interact with SQLite, Firebase, or the WebView bridge?
- Could it conflict with `expo-sqlite`, `react-native-firebase`, or `expo-modules`?
- Does it need entries in `AndroidManifest.xml`? If yes, what?

## Output

Verdict: **APPROVE / APPROVE WITH CAUTION / REJECT**

List all conflicts, alternatives, and required setup steps.
