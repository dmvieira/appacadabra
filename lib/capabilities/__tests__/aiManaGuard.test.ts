/**
 * Garante que mana nunca é debitada quando uma chamada de AI falha —
 * seja por erro na API ou por erro no processamento local do resultado.
 *
 * Debit só deve ocorrer quando: API retorna com sucesso E creditsUsed > 0.
 */

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockIncrementManaCost = jest.fn();
jest.mock('../../store', () => ({
    useAppStore: { getState: () => ({ incrementAppManaCost: mockIncrementManaCost }) },
}));

const mockOpenShop = jest.fn();
let mockBalance = 1000;
jest.mock('../../manaStore', () => ({
    useManaStore: { getState: () => ({ balance: mockBalance, openShop: mockOpenShop }) },
}));

const mockRequestManaConfirmation = jest.fn();
jest.mock('../../bridgeUIStore', () => ({
    useBridgeUIStore: { getState: () => ({ requestManaConfirmation: mockRequestManaConfirmation }) },
}));

jest.mock('../../api/ai', () => ({
    estimateManaCost: jest.fn(),
    aiGenerate: jest.fn(),
    aiSimilarity: jest.fn(),
    aiGenerateImage: jest.fn(),
    aiGenerateVideo: jest.fn(),
    aiGenerateTTS: jest.fn(),
}));

jest.mock('../../database/db', () => ({
    getSetting: jest.fn(() => Promise.resolve('true')),
    setSetting: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../i18n', () => ({ t: (k: string) => k }));

jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: '/docs/',
    cacheDirectory: '/cache/',
    makeDirectoryAsync: jest.fn(() => Promise.resolve()),
    writeAsStringAsync: jest.fn(() => Promise.resolve()),
    deleteAsync: jest.fn(() => Promise.resolve()),
    EncodingType: { Base64: 'base64' },
}));

jest.mock('expo-av', () => ({
    Audio: {
        Sound: { createAsync: jest.fn() },
        setAudioModeAsync: jest.fn(() => Promise.resolve()),
        Recording: class {},
        RecordingOptionsPresets: {},
    },
}));

jest.mock('expo-speech', () => ({ speak: jest.fn() }));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import * as ai from '../../api/ai';
import * as FileSystem from 'expo-file-system/legacy';
import { Audio } from 'expo-av';
import { aiCapability } from '../ai';
import { audioCapability } from '../audio';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeCtx(appId = 42) {
    return {
        appId,
        callbackName: 'onResult',
        webViewRef: { current: { injectJavaScript: jest.fn() } },
        viewContainerRef: { current: null },
        onJobCreated: jest.fn(),
        isEditMode: false,
    };
}

function mockSound() {
    return { setOnPlaybackStatusUpdate: jest.fn(), unloadAsync: jest.fn() };
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
    jest.clearAllMocks();
    mockBalance = 1000;
    // Preflight passa por padrão
    (ai.estimateManaCost as jest.Mock).mockResolvedValue({ mana: '5', value: 5 });
    mockRequestManaConfirmation.mockResolvedValue(true);
    // Audio mock funcional
    (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({ sound: mockSound() });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo A — Erros de API → sem debit (testes 1–6)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo A — erros de API não debitam mana', () => {
    it('1 — AI_GENERATE: erro genérico da API → success:false, sem debit', async () => {
        (ai.aiGenerate as jest.Mock).mockRejectedValue(new Error('API timeout'));
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('2 — AI_GENERATE: erro "insufficient credits" → success:false, openShop, sem debit', async () => {
        (ai.aiGenerate as jest.Mock).mockRejectedValue(new Error('insufficient credits'));
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(mockOpenShop).toHaveBeenCalled();
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('3 — AI_SIMILARITY: erro da API → success:false, sem debit', async () => {
        (ai.aiSimilarity as jest.Mock).mockRejectedValue(new Error('network error'));
        const result = await aiCapability.handleMessage('AI_SIMILARITY', { items: ['a', 'b'] }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('4 — AI_GENERATE_IMAGE: erro da API → success:false, sem debit', async () => {
        (ai.aiGenerateImage as jest.Mock).mockRejectedValue(new Error('model unavailable'));
        const result = await aiCapability.handleMessage('AI_GENERATE_IMAGE', { prompt: 'a cat' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('5 — AI_GENERATE_VIDEO: erro da API → success:false, sem debit', async () => {
        (ai.aiGenerateVideo as jest.Mock).mockRejectedValue(new Error('video service down'));
        const result = await aiCapability.handleMessage('AI_GENERATE_VIDEO', { prompt: 'sunrise' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('6 — AUDIO_SPEAK_AI: erro de API (não-mana) → fallback Speech.speak, sem debit', async () => {
        (ai.aiGenerateTTS as jest.Mock).mockRejectedValue(new Error('TTS service unavailable'));
        const result = await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'hello' }, makeCtx() as any);
        // Fallback: Speech.speak() é chamado e retorna success:true sem debitar
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo B — Erro no processamento local pós-API → sem debit (teste 7)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo B — erro no tratamento do dado pós-API não debita mana', () => {
    it('7 — AUDIO_SPEAK_AI: API ok (creditsUsed=3), FileSystem falha → fallback, sem debit', async () => {
        (ai.aiGenerateTTS as jest.Mock).mockResolvedValue({
            audioBase64: 'aGVsbG8=',
            creditsUsed: 3,
        });
        // Primeira escrita (permanent path, inner try-catch) resolve
        // Segunda escrita (cache file para Audio.Sound, outer try) rejeita
        (FileSystem.writeAsStringAsync as jest.Mock)
            .mockResolvedValueOnce(undefined)
            .mockRejectedValueOnce(new Error('disk full'));

        const result = await audioCapability.handleMessage(
            'AUDIO_SPEAK_AI', { text: 'hello' }, makeCtx() as any
        );

        // Cai no catch externo → fallback Speech.speak → success:true
        expect(result?.success).toBe(true);
        // Mana NÃO debitada — debit fica APÓS o writeAsStringAsync que falhou
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo C — Preflight falha → sem API call, sem debit (testes 8–10)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo C — falhas no preflight não debitam mana nem chamam a API', () => {
    it('8 — AI_GENERATE: estimateManaCost lança → sem API call, sem debit', async () => {
        (ai.estimateManaCost as jest.Mock).mockRejectedValue(new Error('estimation failed'));
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(ai.aiGenerate).not.toHaveBeenCalled();
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
        expect(mockOpenShop).toHaveBeenCalled();
    });

    it('9 — AI_GENERATE: balance insuficiente → sem API call, sem debit', async () => {
        (ai.estimateManaCost as jest.Mock).mockResolvedValue({ mana: '100', value: 100 });
        mockBalance = 50; // menor que o custo
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(ai.aiGenerate).not.toHaveBeenCalled();
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
        expect(mockOpenShop).toHaveBeenCalledWith(100);
    });

    it('10 — AI_GENERATE: modal cancelado → sem API call, sem debit', async () => {
        mockRequestManaConfirmation.mockResolvedValue(false);
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(false);
        expect(ai.aiGenerate).not.toHaveBeenCalled();
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Grupo D — Sucesso → debit correto (testes 11–16)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Grupo D — sucesso debita mana corretamente', () => {
    it('11 — AI_GENERATE: creditsUsed=5 → incrementAppManaCost(42, 5) chamado', async () => {
        (ai.aiGenerate as jest.Mock).mockResolvedValue({ text: 'result', creditsUsed: 5 });
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).toHaveBeenCalledTimes(1);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(42, 5);
    });

    it('12 — AI_GENERATE: creditsUsed=0 → sem debit (guard > 0)', async () => {
        (ai.aiGenerate as jest.Mock).mockResolvedValue({ text: 'result', creditsUsed: 0 });
        const result = await aiCapability.handleMessage('AI_GENERATE', { prompt: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).not.toHaveBeenCalled();
    });

    it('13 — AI_SIMILARITY: creditsUsed=3 → debit correto', async () => {
        (ai.aiSimilarity as jest.Mock).mockResolvedValue({ text: '{"matrix":[[1]]}', creditsUsed: 3 });
        const result = await aiCapability.handleMessage('AI_SIMILARITY', { items: ['a', 'b'] }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(42, 3);
    });

    it('14 — AI_GENERATE_IMAGE: creditsUsed=8 → debit correto', async () => {
        (ai.aiGenerateImage as jest.Mock).mockResolvedValue({ imageBase64: 'img==', creditsUsed: 8 });
        const result = await aiCapability.handleMessage('AI_GENERATE_IMAGE', { prompt: 'a cat' }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(42, 8);
    });

    it('15 — AI_GENERATE_VIDEO: creditsUsed=10 → debit correto', async () => {
        (ai.aiGenerateVideo as jest.Mock).mockResolvedValue({ videoBase64: 'vid==', creditsUsed: 10 });
        const result = await aiCapability.handleMessage('AI_GENERATE_VIDEO', { prompt: 'sunrise' }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(42, 10);
    });

    it('16 — AUDIO_SPEAK_AI: creditsUsed=3 → debit correto', async () => {
        (ai.aiGenerateTTS as jest.Mock).mockResolvedValue({ audioBase64: 'aGVsbG8=', creditsUsed: 3 });
        const result = await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'hello' }, makeCtx() as any);
        expect(result?.success).toBe(true);
        expect(mockIncrementManaCost).toHaveBeenCalledWith(42, 3);
    });
});
