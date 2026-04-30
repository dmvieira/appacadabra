Generate a screen specification for a new Appacadabra UI screen from a user story.

**User story:** $ARGUMENTS

## Context

Read `CLAUDE.md` for the app's navigation structure:
- `/` — Home (spell list, create button)
- `/spell/[id]` — Spell editor (version history, AI cache/relics)
- `/runner/[id]` — Spell runner (WebView + bridge)
- `/import_spell` — Import via file or QR

Key UI patterns:
- Expo Router file-based navigation
- React Native components with `expo-safe-area-context`
- Theme from `lib/theme.ts` (colors, spacing, borderRadius)
- All strings via `lib/i18n.ts` — never hardcoded
- Zustand for global state, local `useState` for ephemeral UI state
- Mana display in top-right via `ManaDisplay` component

## Screen specification to produce

### Screen name and route
`/screens/[route-name]` — proposed file path

### Information hierarchy
List all information elements that must be visible, ordered by priority (most important first):
1. Primary content
2. Secondary metadata
3. Actions

### States to design
- **Loading state**: what shows while data is fetching?
- **Empty state**: what shows when there's no content yet?
- **Error state**: what shows when something fails?
- **Success state**: confirmation or result display

### Interactive elements
For each button/input/gesture:
- Label (in English, to be passed to i18n)
- Action on tap/submit
- Disabled conditions
- Accessibility label

### Navigation
- How does the user arrive here?
- Where can they go from here?
- Back button behavior

### Data requirements
- What Zustand store state is needed?
- What DB queries are needed?
- What Firebase calls are needed?

### HTML mockup scaffold
Generate a simple HTML/CSS interactive mockup of this screen that I can open in a browser to validate the layout before building natively.
