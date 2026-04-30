Run a security scan of Appacadabra's codebase and summarize findings.

**Scope (optional — file, directory, or 'full'):** $ARGUMENTS

## Steps

1. Run `npm audit --json 2>/dev/null` to check for dependency vulnerabilities.
2. Check for common React Native / Expo security anti-patterns in the codebase.
3. Check Firebase security rules if accessible.

## Security checks to perform

### Dependency vulnerabilities
- Parse `npm audit` output (if available)
- Classify by severity: CRITICAL / HIGH / MEDIUM / LOW
- Note which packages are direct vs. transitive dependencies
- Check if a fix version exists

### WebView security (critical for Appacadabra)
The core product runs untrusted AI-generated HTML in WebViews. Check:
- Is `javaScriptEnabled` controlled appropriately in the WebView?
- Is the bridge (`lib/bridges/messageHandlers.ts`) validating message origins?
- Are there any `eval()` calls in injected JS that could enable XSS escalation?
- Is the `postMessage` handler rejecting unknown message types?
- Are capability handlers checking that the calling app actually has permission to use that capability?

### Firebase security
- Are Firestore rules present and restrictive? (only users can read their own data)
- Are Cloud Functions authenticating the caller via `context.auth`?
- Is the mana deduction transaction atomic (preventing race conditions)?
- Are API keys exposed in client-side code that should be server-side only?

### Secret management
- Scan for hardcoded secrets, API keys, or passwords in source files
- Check `.gitignore` includes `google-services.json`, `.env`, `local.properties`
- Are Firebase credentials loaded from environment, not hardcoded?

### Input validation
- Are user-supplied strings sanitized before being sent to the Gemini API?
- Are deep link parameters (`runapp://`) validated before use?
- Is the import spell flow validating file content before parsing?

### Permissions audit
- List all Android permissions declared in `AndroidManifest.xml`
- Flag any that are declared but not actively used by a capability
- Check that dangerous permissions follow the request-at-runtime pattern

## Output

Findings sorted by severity. For each finding:
- File:line (if applicable)
- Severity: 🔴 CRITICAL / 🟠 HIGH / 🟡 MEDIUM / 🟢 LOW / ℹ️ INFO
- Description
- Recommended fix
