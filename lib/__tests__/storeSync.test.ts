/**
 * Unit tests for storeSync.syncLearnedSpells — Learn Spell deep-link flow.
 *
 * Coverage:
 *   - Happy path: 1 spell downloaded, status message set with success key,
 *     statusActionAppId points to imported app.
 *   - Dedup: spell already in local DB, status message uses already-owned key.
 *   - Nothing-to-sync: empty server response with deep link trigger.
 *   - Total failure: server rejects, error set with failed key.
 *   - Partial failure: 1 ok + 1 fetch fail, status message still success and
 *     result reflects imported=1, failed=1.
 *   - No deep link trigger: no status message side-effects (silent background sync).
 */

const mockGetAppByStoreSpellId = jest.fn(() => Promise.resolve(null as any));
const mockInsertApp = jest.fn(() => Promise.resolve(42));
const mockUpdateAppStoreLink = jest.fn(() => Promise.resolve());
const mockGetAppsWithStoreSpellId = jest.fn(() => Promise.resolve([]));
const mockGetAllApps = jest.fn(() => Promise.resolve([]));
const mockGetAppById = jest.fn(() => Promise.resolve(null as any));
const mockGetDeletedStoreSpellTombstones = jest.fn(() => Promise.resolve([] as string[]));
const mockRemoveDeletedStoreSpellTombstone = jest.fn(() => Promise.resolve());
const mockTouchAppLastUpdated = jest.fn(() => Promise.resolve());

jest.mock('../database/db', () => ({
    getAppById: (...args: any[]) => mockGetAppById(...args),
    getAppByStoreSpellId: (...args: any[]) => mockGetAppByStoreSpellId(...args),
    getAppsWithStoreSpellId: (...args: any[]) => mockGetAppsWithStoreSpellId(...args),
    getAllApps: (...args: any[]) => mockGetAllApps(...args),
    insertApp: (...args: any[]) => mockInsertApp(...args),
    updateAppStoreLink: (...args: any[]) => mockUpdateAppStoreLink(...args),
    getDeletedStoreSpellTombstones: (...args: any[]) => mockGetDeletedStoreSpellTombstones(...args),
    removeDeletedStoreSpellTombstone: (...args: any[]) => mockRemoveDeletedStoreSpellTombstone(...args),
    touchAppLastUpdated: (...args: any[]) => mockTouchAppLastUpdated(...args),
}));

const mockSyncLearnedSpells = jest.fn();
const mockMarkSpellSynced = jest.fn(() => Promise.resolve({ success: true }));
const mockPublishSpell = jest.fn();
const mockUnpublishSpell = jest.fn();
const mockGetStoreSpellStatus = jest.fn();
const mockGetMyPublishedSpells = jest.fn(() => Promise.resolve({ spells: [] }));
const mockCompressContent = jest.fn((x: string) => x);
const mockDecompressContent = jest.fn((x: string) => x);

jest.mock('../firebase', () => ({
    syncLearnedSpells: (...args: any[]) => mockSyncLearnedSpells(...args),
    markSpellSynced: (...args: any[]) => mockMarkSpellSynced(...args),
    publishSpell: (...args: any[]) => mockPublishSpell(...args),
    unpublishSpell: (...args: any[]) => mockUnpublishSpell(...args),
    getStoreSpellStatus: (...args: any[]) => mockGetStoreSpellStatus(...args),
    getMyPublishedSpells: (...args: any[]) => mockGetMyPublishedSpells(...args),
    compressContent: (x: string) => mockCompressContent(x),
    decompressContent: (x: string) => mockDecompressContent(x),
    onAuthStateChanged: jest.fn(),
    onCreditsChanged: jest.fn(),
    getCredits: jest.fn(() => Promise.resolve(0)),
}));

jest.mock('expo-localization', () => ({
    getLocales: () => [{ languageCode: 'en' }],
}));

jest.mock('../i18n', () => ({ t: (k: string) => k }));

// Minimal store mock — only methods/props the SUT touches.
const mockSetStatusMessage = jest.fn();
const mockLoadApps = jest.fn(() => Promise.resolve());
let mockStoreState: any = {
    statusActionAppId: null,
    error: null,
    setStatusMessage: (m: string) => {
        mockSetStatusMessage(m);
        mockStoreState.statusMessage = m;
    },
    loadApps: () => mockLoadApps(),
};

jest.mock('../store', () => ({
    useAppStore: {
        getState: () => mockStoreState,
        setState: (patch: any) => {
            mockStoreState = { ...mockStoreState, ...(typeof patch === 'function' ? patch(mockStoreState) : patch) };
        },
    },
}));

// Provide a global fetch mock — Node 24 has fetch but we control it here.
const mockFetch = jest.fn();
(global as any).fetch = (...args: any[]) => mockFetch(...args);

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { useStoreSyncStore } from '../storeSync';

function makeSpell(overrides: Partial<any> = {}) {
    return {
        spellId: 'spell-1',
        slug: 'test-spell',
        name: 'Test Spell',
        description: 'A test spell',
        iconPath: null,
        authorName: 'Tester',
        publishedVersion: 1,
        signedHtmlUrl: 'https://storage.example/spell-1.html',
        translations: {},
        forkOfSpellId: null,
        rootSpellId: 'spell-1',
        ...overrides,
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    mockStoreState = {
        statusActionAppId: null,
        error: null,
        setStatusMessage: (m: string) => {
            mockSetStatusMessage(m);
            mockStoreState.statusMessage = m;
        },
        loadApps: () => mockLoadApps(),
    };
    useStoreSyncStore.setState({ isSyncing: false, isPublishing: false, lastError: null });
    mockGetAppByStoreSpellId.mockResolvedValue(null);
    mockInsertApp.mockResolvedValue(42);
    mockGetDeletedStoreSpellTombstones.mockResolvedValue([]);
    mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve('<html>spell</html>') });
});

describe('syncLearnedSpells — Learn Spell deep-link flow', () => {
    it('happy path: 1 spell downloaded → setStatusMessage(learnSpellSuccess) + statusActionAppId set', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell()] });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 1, dedupHits: 0, failed: 0 });
        expect(mockInsertApp).toHaveBeenCalledTimes(1);
        expect(mockSetStatusMessage).toHaveBeenCalledWith('learnSpellSuccess');
        expect(mockStoreState.statusActionAppId).toBe(42);
    });

    it('dedup: spell already in local DB → setStatusMessage(learnSpellAlreadyOwned)', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell()] });
        mockGetAppByStoreSpellId.mockResolvedValue({ id: 7, name: 'Existing' });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 0, dedupHits: 1, failed: 0 });
        expect(mockInsertApp).not.toHaveBeenCalled();
        expect(mockSetStatusMessage).toHaveBeenCalledWith('learnSpellAlreadyOwned');
        expect(mockStoreState.statusActionAppId).toBe(7);
    });

    it('nothing to sync: empty server response → setStatusMessage(learnSpellNothingToSync)', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [] });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 0, dedupHits: 0, failed: 0 });
        expect(mockSetStatusMessage).toHaveBeenCalledWith('learnSpellNothingToSync');
    });

    it('total failure: callable rejects → error set with learnSpellFailed', async () => {
        mockSyncLearnedSpells.mockRejectedValue(new Error('network down'));

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 0, dedupHits: 0, failed: 0 });
        expect(mockStoreState.error).toBe('learnSpellFailed');
        expect(mockSetStatusMessage).not.toHaveBeenCalled();
    });

    it('partial failure: 1 ok + 1 fetch failure → success status + result reflects counts', async () => {
        mockSyncLearnedSpells.mockResolvedValue({
            spells: [makeSpell({ spellId: 'spell-1' }), makeSpell({ spellId: 'spell-2', signedHtmlUrl: 'https://bad' })],
        });
        mockFetch
            .mockResolvedValueOnce({ ok: true, text: () => Promise.resolve('<html>1</html>') })
            .mockResolvedValueOnce({ ok: false, status: 500 });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 1, dedupHits: 0, failed: 1 });
        expect(mockSetStatusMessage).toHaveBeenCalledWith('learnSpellSuccess');
    });

    it('background sync (no triggeredByDeepLink) → no status side-effects on happy path', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell()] });

        const result = await useStoreSyncStore.getState().syncLearnedSpells();

        expect(result).toEqual({ imported: 1, dedupHits: 0, failed: 0 });
        expect(mockSetStatusMessage).not.toHaveBeenCalled();
        expect(mockStoreState.error).toBeNull();
    });

    it('background sync (no triggeredByDeepLink) → no error on total failure', async () => {
        mockSyncLearnedSpells.mockRejectedValue(new Error('network down'));

        const result = await useStoreSyncStore.getState().syncLearnedSpells();

        expect(result).toEqual({ imported: 0, dedupHits: 0, failed: 0 });
        expect(mockStoreState.error).toBeNull();
        expect(mockSetStatusMessage).not.toHaveBeenCalled();
    });

    it('forceSpellId is forwarded to the firebase callable', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [] });

        await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true, forceSpellId: 'spell-x' });

        expect(mockSyncLearnedSpells).toHaveBeenCalledWith({ forceSpellId: 'spell-x' });
    });

    it('concurrent run guard: returns zero-counts when sync is already in flight', async () => {
        useStoreSyncStore.setState({ isSyncing: true });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(result).toEqual({ imported: 0, dedupHits: 0, failed: 0 });
        expect(mockSyncLearnedSpells).not.toHaveBeenCalled();
    });

    it('forceSpellId bypasses the in-flight guard so deep links never silently no-op', async () => {
        useStoreSyncStore.setState({ isSyncing: true });
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell()] });

        const result = await useStoreSyncStore.getState().syncLearnedSpells({
            triggeredByDeepLink: true,
            forceSpellId: 'spell-1',
        });

        expect(mockSyncLearnedSpells).toHaveBeenCalledWith({ forceSpellId: 'spell-1' });
        expect(result).toEqual({ imported: 1, dedupHits: 0, failed: 0 });
    });

    it('triggeredByDeepLink with dedupHits>0 still refreshes the listing via loadApps()', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell()] });
        mockGetAppByStoreSpellId.mockResolvedValue({ id: 7, name: 'Existing' });

        await useStoreSyncStore.getState().syncLearnedSpells({ triggeredByDeepLink: true });

        expect(mockLoadApps).toHaveBeenCalled();
    });

    it('tombstoned spells are filtered out during recoverAll', async () => {
        mockSyncLearnedSpells.mockResolvedValue({
            spells: [makeSpell({ spellId: 'spell-tombstoned' }), makeSpell({ spellId: 'spell-keep' })],
        });
        mockGetDeletedStoreSpellTombstones.mockResolvedValue(['spell-tombstoned']);

        await useStoreSyncStore.getState().syncLearnedSpells({ recoverAll: true });

        // Only the non-tombstoned spell should reach insertApp.
        expect(mockInsertApp).toHaveBeenCalledTimes(1);
        const insertedSpellId = mockInsertApp.mock.calls[0][0].storeSpellId;
        expect(insertedSpellId).toBe('spell-keep');
    });

    it('forceSpellId overrides the tombstone filter (re-learn after delete)', async () => {
        mockSyncLearnedSpells.mockResolvedValue({
            spells: [makeSpell({ spellId: 'spell-deleted' })],
        });
        mockGetDeletedStoreSpellTombstones.mockResolvedValue(['spell-deleted']);

        const result = await useStoreSyncStore.getState().syncLearnedSpells({
            triggeredByDeepLink: true,
            forceSpellId: 'spell-deleted',
        });

        expect(mockInsertApp).toHaveBeenCalledTimes(1);
        expect(result.imported).toBe(1);
        // Re-import must clear the tombstone so future recoverAll syncs work normally.
        expect(mockRemoveDeletedStoreSpellTombstone).toHaveBeenCalledWith('spell-deleted');
    });

    it('recoverAll: true is forwarded to the firebase callable', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [] });

        await useStoreSyncStore.getState().syncLearnedSpells({ recoverAll: true });

        expect(mockSyncLearnedSpells).toHaveBeenCalledWith({ recoverAll: true });
    });

    it('dedup hit with forceSpellId touches lastUpdated to bubble the spell to the top', async () => {
        mockSyncLearnedSpells.mockResolvedValue({ spells: [makeSpell({ spellId: 'spell-x' })] });
        mockGetAppByStoreSpellId.mockResolvedValue({ id: 99, name: 'Existing' });

        await useStoreSyncStore.getState().syncLearnedSpells({
            triggeredByDeepLink: true,
            forceSpellId: 'spell-x',
        });

        expect(mockTouchAppLastUpdated).toHaveBeenCalledWith(99);
    });
});
