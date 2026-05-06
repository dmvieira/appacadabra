Generate user-facing release notes for the next Play Store release in Appacadabra's brand voice, bump the version, write to RELEASE_NOTES.md, and create a git tag.

**Version or bump type (optional, e.g. "2.1.0" or "minor"):** $ARGUMENTS

## Steps

### 1. Read current state
- Read `app.json` for current `version`.
- Read `android/app/build.gradle` for current `versionCode` and `versionName`.
- Read `package.json` for current `version`.
- Run `git describe --tags --abbrev=0` to find the last tag.
- Run `git log {last_tag}..HEAD --oneline` to get commits since last tag.
- Read `docs/RELEASE_NOTES.md` for the existing format and tone.
- Read `docs/PLAY_STORE_TRANSLATIONS.md` for the 20 supported locale codes.

### 2. Determine new version
- If `$ARGUMENTS` is a semver string (e.g. "2.1.0"), use it directly.
- If `$ARGUMENTS` is a bump type ("major", "minor", "patch"), apply it to current version.
- Otherwise, default to **patch** bump.
- New `versionCode` = current `versionCode` + 1.

### 3. Bump version in files
Update all three files with the new version:
- `app.json` → `expo.version`
- `package.json` → `version`
- `android/app/build.gradle` → `versionCode` and `versionName`

### 4. Generate release notes
Based on the git log since last tag, produce user-facing release notes.

**Brand voice rules:**
- Tone: magical, playful, empowering — matches the "spell casting" metaphor
- Features → "cast" or "conjure", bugs → "gremlins banished" or "enchantments fixed"
- Short sentences. No technical jargon.
- Max 500 characters per locale (Play Store limit)
- 3–5 bullet points per locale

**Version Name:** a short, descriptive human-readable name for this release (e.g. "Health & Fitness Integration", "Spell Fixes & AI Improvements").

**Output format** — write exactly this structure to `docs/RELEASE_NOTES.md` (overwrite; git history preserves past releases):

```
## Version Name
{descriptive name}

<en-US>
• bullet 1
• bullet 2
</en-US>

<ar>
• ...
</ar>

<de-DE>
• ...
</de-DE>

<es-419>
• ...
</es-419>

<es-ES>
• ...
</es-ES>

<es-US>
• ...
</es-US>

<fr-CA>
• ...
</fr-CA>

<fr-FR>
• ...
</fr-FR>

<hi-IN>
• ...
</hi-IN>

<it-IT>
• ...
</it-IT>

<ja-JP>
• ...
</ja-JP>

<ko-KR>
• ...
</ko-KR>

<nl-NL>
• ...
</nl-NL>

<pl-PL>
• ...
</pl-PL>

<pt-BR>
• ...
</pt-BR>

<pt-PT>
• ...
</pt-PT>

<ru-RU>
• ...
</ru-RU>

<th>
• ...
</th>

<tr-TR>
• ...
</tr-TR>

<vi>
• ...
</vi>

<zh-CN>
• ...
</zh-CN>
```

### 5. Commit and tag
- Stage `app.json`, `package.json`, `android/app/build.gradle`, `docs/RELEASE_NOTES.md`.
- Commit with message: `chore: release v{new_version}`
- Create git tag: `git tag v{new_version}` (skip if tag already exists)

### 6. Developer Summary (internal, not for Play Store)
After the release notes, output a **Developer Summary**:
- Breaking changes
- Migration steps required
- New permissions added
- Firebase Function changes deployed
