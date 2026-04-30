Generate user-facing release notes for the next Play Store release in Appacadabra's brand voice.

**Version or range (optional):** $ARGUMENTS

## Steps

1. Run `git log --oneline $(git describe --tags --abbrev=0)..HEAD` to get commits since last tag.
   If a version/range was provided as argument, use that instead.
2. Read `docs/RELEASE_NOTES.md` for the existing format and tone.
3. Read `docs/PLAY_STORE_TRANSLATIONS.md` for the 20 supported languages and their locale codes.

## Brand voice rules
- Tone: magical, playful, empowering — matches the "spell casting" metaphor
- Features → "cast" or "conjure", bugs → "gremlins" or "enchantments removed"
- Short sentences. No technical jargon for user-facing notes.
- Max 500 characters per locale (Play Store limit)

## Output format

Produce release notes in ALL 20 supported languages (as listed in `docs/PLAY_STORE_TRANSLATIONS.md`).

Format:
```
## v{version} — {date}

### EN
What's new: ...
Bug fixes: ...

### PT
...
```

Also produce a **Developer Summary** (internal, not for Play Store) with:
- Breaking changes
- Migration steps required
- New permissions added
- Firebase Function changes deployed
