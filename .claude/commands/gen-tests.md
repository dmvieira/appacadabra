Generate Jest unit test scaffolding for the given file or function.

**Target:** $ARGUMENTS

## Instructions

1. Read the target file. Identify all exported functions, classes, and React hooks.
2. For each testable unit, generate a `describe` block with the function name.
3. Follow the test patterns from `lib/capabilities/__tests__/aiManaGuard.test.ts` and `lib/bridges/__tests__/aiCacheUtils.test.ts`:
   - Mock all external dependencies (db, firebase, expo-*, react-native modules) at the top
   - Group tests by scenario using nested `describe` blocks
   - Use Portuguese for describe/it labels (matches existing test style)
   - `beforeEach` clears mocks and resets state
   - Test names follow the pattern: `N — description → expected behavior`

## Appacadabra mock patterns

```typescript
// DB mock
jest.mock('../database/db', () => ({ functionName: jest.fn() }));

// Firebase mock
jest.mock('../firebase', () => ({ generateSpell: jest.fn(), decompressContent: (x) => x }));

// Store mock
jest.mock('../store', () => ({
  useAppStore: { getState: () => ({ incrementAppManaCost: jest.fn() }) }
}));

// i18n mock
jest.mock('../i18n', () => ({ t: (k) => k }));
```

## Output format

Generate the complete test file content, ready to save as `__tests__/<filename>.test.ts` next to the source file. Include:
- All required mocks
- Happy path tests
- Error/failure path tests
- Edge cases (empty input, zero values, null/undefined)
- For mana-related functions: always test that `db.incrementManaCost` is NOT called on failure
