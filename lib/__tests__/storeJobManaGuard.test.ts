/**
 * Garante que mana nunca é debitada localmente quando um job falha —
 * seja spell create, spell edit ou geração de logo.
 *
 * Debit local (db.incrementManaCost) só deve ocorrer em:
 *   - _processCompletedJob com creditsUsed > 0
 *   - generateAndSaveAppIcon com creditsUsed > 0 e imagem salva com sucesso
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockIncrementManaCost = jest.fn(() => Promise.resolve());
const mockInsertApp = jest.fn(() => Promise.resolve(1));
const mockGetAppById = jest.fn(() => Promise.resolve({ id: 1, currentVersion: 1, totalManaCost: 0, name: 'Test' }));
const mockInsertVersion = jest.fn(() => Promise.resolve());
const mockMarkJobAsProcessed = jest.fn(() => Promise.resolve());
const mockUpdateAppContent = jest.fn(() => Promise.resolve());
const mockUpdateApp = jest.fn(() => Promise.resolve());
const mockHasJobBeenProcessed = jest.fn(() => Promise.resolve(false));

jest.mock('../database/db', () => ({
    incrementManaCost: (...args: any[]) => mockIncrementManaCost(...args),
    insertApp: (...args: any[]) => mockInsertApp(...args),
    getAppById: (...args: any[]) => mockGetAppById(...args),
    insertVersion: (...args: any[]) => mockInsertVersion(...args),
    markJobAsProcessed: (...args: any[]) => mockMarkJobAsProcessed(...args),
    updateAppContent: (...args: any[]) => mockUpdateAppContent(...args),
    updateApp: (...args: any[]) => mockUpdateApp(...args),
    hasJobBeenProcessed: (...args: any[]) => mockHasJobBeenProcessed(...args),
}));

const mockGenerateSpellLogoGen = jest.fn();
const mockDecompressContent = jest.fn((x: any) => (typeof x === 'string' ? x : ''));
const mockGetCredits = jest.fn(() => Promise.resolve(100));

jest.mock('../firebase', () => ({
    generateSpellLogoGen: (...args: any[]) => mockGenerateSpellLogoGen(...args),
    decompressContent: (x: any) => mockDecompressContent(x),
    getCredits: () => mockGetCredits(),
    onAuthStateChanged: jest.fn(),
    onCreditsChanged: jest.fn(),
}));

jest.mock('expo-notifications', () => ({
    setNotificationChannelAsync: jest.fn(() => Promise.resolve()),
    scheduleNotificationAsync: jest.fn(() => Promise.resolve()),
    AndroidImportance: { HIGH: 4 },
    deleteNotificationChannelAsync: jest.fn(() => Promise.resolve()),
}));

const mockGetInfoAsync = jest.fn(() => Promise.resolve({ exists: true }));
const mockWriteAsStringAsync = jest.fn(() => Promise.resolve());
const mockDownloadAsync = jest.fn(() => Promise.resolve());
const mockMakeDirectoryAsync = jest.fn(() => Promise.resolve());

jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: '/docs/',
    cacheDirectory: '/cache/',
    getInfoAsync: (...args: any[]) => mockGetInfoAsync(...args),
    writeAsStringAsync: (...args: any[]) => mockWriteAsStringAsync(...args),
    downloadAsync: (...args: any[]) => mockDownloadAsync(...args),
    makeDirectoryAsync: (...args: any[]) => mockMakeDirectoryAsync(...args),
    deleteAsync: jest.fn(() => Promise.resolve()),
    EncodingType: { Base64: 'base64', UTF8: 'utf8' },
}));

jest.mock('expo-file-system/next', () => ({
    Paths: { document: '/docs' },
    File: class { exists = false; base64 = jest.fn(); },
}));

const mockPublishShortcut = jest.fn();
jest.mock('../bridges/SharingShortcuts', () => ({
    __esModule: true,
    default: { publishShortcut: (...args: any[]) => mockPublishShortcut(...args), removeShortcut: jest.fn() },
}));

jest.mock('../i18n', () => ({ t: (k: string) => k }));

jest.mock('../manaStore', () => ({
    useManaStore: { getState: () => ({ openShop: jest.fn(), setBalance: jest.fn() }) },
}));

jest.mock('../backupSync', () => ({ markBackupDirty: jest.fn() }));

jest.mock('../bridges/messageHandlers', () => ({
    cancelSpellNotifications: jest.fn(() => Promise.resolve()),
    migrateStorageBlobsToFiles: jest.fn(),
}));

jest.mock('../api/ai', () => ({}));
jest.mock('../backup', () => ({}));
jest.mock('../onboardingTemplates', () => ({ onboardingTemplates: [] }));
jest.mock('../projectConverter', () => ({}));
jest.mock('../storageCache', () => ({ getStorageFromCache: jest.fn(() => []) }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { useAppStore } from '../store';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCreateJob(overrides: Partial<any> = {}): any {
    return {
        id: 'job-create-1',
        action: 'create',
        payload: { prompt: 'build a todo app' },
        result: { text: '<html><title>Todo</title></html>', creditsUsed: 5, usage: {} },
        error: null,
        ...overrides,
    };
}

function makeEditJob(overrides: Partial<any> = {}): any {
    return {
        id: 'job-edit-1',
        action: 'edit',
        payload: { appId: 1, instruction: 'add dark mode' },
        result: { text: '<html><title>Todo</title></html>', creditsUsed: 3, usage: {} },
        error: null,
        ...overrides,
    };
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockDecompressContent.mockImplementation((x: any) => (typeof x === 'string' ? x : ''));
    mockHasJobBeenProcessed.mockResolvedValue(false);
    mockInsertApp.mockResolvedValue(1);
    mockGetAppById.mockResolvedValue({ id: 1, currentVersion: 1, totalManaCost: 0, name: 'Test' });
    mockGetInfoAsync.mockResolvedValue({ exists: true });
    mockWriteAsStringAsync.mockResolvedValue(undefined);
    mockDownloadAsync.mockResolvedValue(undefined);
    mockMakeDirectoryAsync.mockResolvedValue(undefined);

    // Prevent loadApps from hitting the DB
    useAppStore.setState({
        loadApps: jest.fn(() => Promise.resolve()),
        apps: [{ id: 1, currentVersion: 1, totalManaCost: 0, name: 'Test', iconPath: null } as any],
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo A — _processFailedJob nunca debita mana (testes 1–3)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo A — _processFailedJob nunca debita mana', () => {
    it('1 — create falha → db.incrementManaCost NOT called', () => {
        useAppStore.getState()._processFailedJob({
            id: 'job-create-fail',
            action: 'create',
            payload: { prompt: 'todo app' },
            result: null,
            error: 'AI call failed',
        } as any);

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('2 — edit falha → db.incrementManaCost NOT called', () => {
        useAppStore.setState({ updatingAppIds: [1] });
        useAppStore.getState()._processFailedJob({
            id: 'job-edit-fail',
            action: 'edit',
            payload: { appId: 1, instruction: 'add dark mode' },
            result: null,
            error: 'timeout',
        } as any);

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('3 — create falha com erro de mana → db.incrementManaCost NOT called', () => {
        useAppStore.getState()._processFailedJob({
            id: 'job-create-mana-fail',
            action: 'create',
            payload: { prompt: 'todo app' },
            result: null,
            error: 'insufficient credits',
        } as any);

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo B — _processCompletedJob create debita corretamente (testes 4–5)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo B — _processCompletedJob create debita corretamente', () => {
    it('4 — create com creditsUsed=5 → db.incrementManaCost(1, 5) chamado', async () => {
        await useAppStore.getState()._processCompletedJob(makeCreateJob({ result: { text: '<html><title>T</title></html>', creditsUsed: 5 } }));

        expect(mockIncrementManaCost).toHaveBeenCalledTimes(1);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(1, 5);
    });

    it('5 — create com creditsUsed=0 → db.incrementManaCost NOT called', async () => {
        await useAppStore.getState()._processCompletedJob(makeCreateJob({ result: { text: '<html><title>T</title></html>', creditsUsed: 0 } }));

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo C — _processCompletedJob edit debita corretamente (testes 6–7)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo C — _processCompletedJob edit debita corretamente', () => {
    it('6 — edit com creditsUsed=3 → db.incrementManaCost(1, 3) chamado + totalManaCost somado', async () => {
        mockGetAppById.mockResolvedValue({ id: 1, currentVersion: 1, totalManaCost: 10, name: 'Test' });

        await useAppStore.getState()._processCompletedJob(makeEditJob({ result: { text: '<html></html>', creditsUsed: 3 } }));

        expect(mockIncrementManaCost).toHaveBeenCalledWith(1, 3);
        expect(mockUpdateAppContent).toHaveBeenCalledWith(
            1, expect.any(String), 2, 13, 'job-edit-1'
        );
    });

    it('7 — edit com creditsUsed=0 → db.incrementManaCost NOT called, totalManaCost inalterado', async () => {
        mockGetAppById.mockResolvedValue({ id: 1, currentVersion: 1, totalManaCost: 10, name: 'Test' });

        await useAppStore.getState()._processCompletedJob(makeEditJob({ result: { text: '<html></html>', creditsUsed: 0 } }));

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
        expect(mockUpdateAppContent).toHaveBeenCalledWith(
            1, expect.any(String), 2, 10, 'job-edit-1'
        );
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo D — generateAndSaveAppIcon nunca debita quando falha (testes 8–10)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo D — generateAndSaveAppIcon nunca debita quando falha', () => {
    it('8 — generateSpellLogoGen throws → db.incrementManaCost NOT called', async () => {
        mockGenerateSpellLogoGen.mockRejectedValue(new Error('API error'));

        await expect(
            useAppStore.getState().generateAndSaveAppIcon(1, 'icon prompt')
        ).rejects.toThrow('API error');

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('9 — API retorna sem imagem (text vazio) → db.incrementManaCost NOT called', async () => {
        mockGenerateSpellLogoGen.mockResolvedValue({ text: '', creditsUsed: 2 });

        const result = await useAppStore.getState().generateAndSaveAppIcon(1, 'icon prompt');

        expect(result.iconPath).toBe('');
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('10 — FileSystem.writeAsStringAsync falha → db.incrementManaCost NOT called', async () => {
        mockGenerateSpellLogoGen.mockResolvedValue({ text: 'base64imagedata==', creditsUsed: 2 });
        mockWriteAsStringAsync.mockRejectedValue(new Error('disk full'));

        await expect(
            useAppStore.getState().generateAndSaveAppIcon(1, 'icon prompt')
        ).rejects.toThrow('disk full');

        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo E — generateAndSaveAppIcon debita corretamente no sucesso (testes 11–12)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo E — generateAndSaveAppIcon debita corretamente no sucesso', () => {
    it('11 — sucesso com creditsUsed=2 → db.incrementManaCost(1, 2) chamado', async () => {
        mockGenerateSpellLogoGen.mockResolvedValue({ text: 'base64imagedata==', creditsUsed: 2 });

        const result = await useAppStore.getState().generateAndSaveAppIcon(1, 'icon prompt');

        expect(result.iconPath).toContain('ai_icon_1_');
        expect(result.creditsUsed).toBe(2);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(1, 2);
    });

    it('12 — sucesso com creditsUsed=0 → db.incrementManaCost NOT called', async () => {
        mockGenerateSpellLogoGen.mockResolvedValue({ text: 'base64imagedata==', creditsUsed: 0 });

        const result = await useAppStore.getState().generateAndSaveAppIcon(1, 'icon prompt');

        expect(result.iconPath).toContain('ai_icon_1_');
        expect(result.creditsUsed).toBe(0);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});
