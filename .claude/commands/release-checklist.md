Generate a Play Store submission checklist for the current state of Appacadabra.

**Target version (optional):** $ARGUMENTS

## Steps

1. Read `app.json` for the current `version` and `versionCode`.
2. Read `android/app/build.gradle` for the Gradle `versionCode` and `versionName`.
3. Read `docs/APP_STORE_REVIEW.md` for known review requirements.
4. Check `AndroidManifest.xml` for declared permissions.

## Checklist to verify and report on

### Testes de qualidade de IA (opcional)

Antes de continuar, pergunte ao usuário:

> "Deseja rodar os testes metamórficos de qualidade de IA? Eles validam criação, edição, capabilities e busca online contra o modelo real (~30 min, custa créditos de API). Recomendado se os prompts ou modelos mudaram desde o último release."

Se o usuário confirmar, execute:
```
cd firebase/functions && npm test -- --testPathPatterns=ai-quality --verbose
```
Reporte o resultado (quantos passaram/falharam) antes de prosseguir com o restante do checklist.

---

### Pre-submission
- [ ] `versionCode` in `app.json` and `build.gradle` match and are incremented
- [ ] `versionName` follows semver and is updated in both files
- [ ] `npm run sync-capabilities` was run (capabilities → AndroidManifest.xml sync)
- [ ] All Firebase Functions deployed (`firebase deploy --only functions`)
- [ ] Release APK/AAB built with `--release` flag and code shrinking enabled (R8)
- [ ] Crashlytics is initializing in release build (not silently failing)

### Play Console configuration
- [ ] Data Safety form reflects current permissions and data flows:
  - Spell descriptions → Gemini API (disclosed)
  - No PII collected or stored server-side
  - Health Connect permissions declared if health capability enabled
- [ ] Target Audience: 13+ (COPPA compliance)
- [ ] Content Rating questionnaire completed
- [ ] AI-generated content disclosure present (2024 policy requirement)
- [ ] App access credentials provided (if login required for review)

### Store listing
- [ ] Short description ≤ 80 characters
- [ ] Full description ≤ 4000 characters
- [ ] Screenshots: minimum 2 phone screenshots
- [ ] Feature graphic present (1024×500px)
- [ ] Release notes updated for this version (all 20 locales)

### Git tag
- [ ] Git tag for this version exists: run `git tag | grep "v{version}"` and confirm output is non-empty. If missing, run `git tag v{version}` before proceeding.

### Rollout strategy
- [ ] Start at 5% staged rollout
- [ ] Monitor crash-free rate for 24h before expanding
- [ ] Escalation threshold: if crash-free rate drops below 99%, halt rollout

Report each item as ✅ (confirmed), ❌ (issue found), or ⚠️ (manual check required) with the evidence from the codebase.
