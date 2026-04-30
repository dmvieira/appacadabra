Evaluate a new Appacadabra feature against the cultural contexts of our active markets.

**Feature to evaluate:** $ARGUMENTS

## Appacadabra's active markets (in priority order)

1. **Brazil (PT)** — primary market, largest user base
2. **United States (EN)** — English-speaking global
3. **India (HI + EN)** — mobile-first, data-conscious users
4. **Japan (JA)** — minimalist aesthetic preference, high quality expectations
5. **Southeast Asia (VI, TH + EN)** — TikTok-native discovery, value-conscious
6. **Spain/Latin America (ES)** — Spanish-speaking, varies by country
7. **Germany (DE)** — privacy-conscious, formal tone preferred
8. **South Korea (KO)** — high mobile usage, competitive landscape with local alternatives
9. **Russia (RU)** — specific localization needs, payment limitations
10. **Arabic-speaking markets (AR)** — RTL layout, religious content sensitivity

## Evaluation dimensions

For each active market, assess:

### 1. UX pattern compatibility
- Does the feature's interaction model match this market's conventions?
- Any gestures or navigation patterns that feel unnatural?
- Information density: too dense (Japan problem) or too sparse?

### 2. Cultural content sensitivity
- Does the "magic/spell" metaphor land well in this culture?
- Any terminology that has negative connotations locally?
- Any imagery or icons that could be misread?

### 3. Language/localization impact
- Is this feature's text already covered by our 17-language system?
- Any new strings needed? (feed to `/add-locale-string` command)
- RTL impact for Arabic market?

### 4. Technical/regulatory flags
- Any feature behavior that's restricted in specific markets?
- Privacy implications that are more sensitive in specific markets (Germany: GDPR strictness)?
- Payment flow changes that affect specific markets?

### 5. Feature adaptation recommendations
- Does this feature need a market-specific variant? Or is the global version acceptable?
- Priority order for rollout across markets

## Output

A table with each market and its assessment, followed by prioritized adaptation recommendations.
Flag any market where the feature could cause user friction or regulatory issues as: 🟢 CLEAR / 🟡 ADAPT / 🔴 BLOCK
