import { saveAiResultToCache } from '../aiCacheUtils';

const mockSaveWebviewAiCache = jest.fn(() => Promise.resolve(42));

jest.mock('../../database/db', () => ({
    saveWebviewAiCache: (...args: any[]) => mockSaveWebviewAiCache(...args),
}));

const BASE = {
    appId: 1,
    callbackName: 'onResult',
    requestData: { prompt: 'hello' },
    creditsUsed: 5,
};

beforeEach(() => {
    mockSaveWebviewAiCache.mockClear();
});

describe('saveAiResultToCache', () => {
    describe('AI_GENERATE', () => {
        it('saves on success with non-empty result', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: 'hello world' });
            expect(id).toBe(42);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledTimes(1);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                appId: 1,
                callbackName: 'onResult',
                action: 'AI_GENERATE',
                result: 'hello world',
                creditsUsed: 5,
                success: 1,
            }));
        });

        it('does not save on failure', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: false, result: 'error msg' });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });

        it('does not save when result is empty', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: '' });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });

        it('serialises requestData as JSON', async () => {
            await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: 'ok', requestData: { prompt: 'test' } });
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                requestData: JSON.stringify({ prompt: 'test' }),
            }));
        });
    });

    describe('AI_SIMILARITY', () => {
        it('saves on success — garante que similarity é persistido', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_SIMILARITY', success: true, result: '{"matrix":[[1]]}' });
            expect(id).toBe(42);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledTimes(1);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                action: 'AI_SIMILARITY',
                result: '{"matrix":[[1]]}',
                success: 1,
            }));
        });

        it('does not save on failure', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_SIMILARITY', success: false, result: 'err' });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });
    });

    describe('AI_GENERATE_IMAGE', () => {
        it('saves when mediaLocalPath is provided', async () => {
            const id = await saveAiResultToCache({
                ...BASE, type: 'AI_GENERATE_IMAGE', success: true,
                result: 'file:///path/img.png', mediaLocalPath: '/path/img.png',
            });
            expect(id).toBe(42);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                action: 'AI_GENERATE_IMAGE',
                mediaLocalPath: '/path/img.png',
                success: 1,
            }));
        });

        it('does not save when mediaLocalPath is absent', async () => {
            const id = await saveAiResultToCache({
                ...BASE, type: 'AI_GENERATE_IMAGE', success: true, result: 'base64data',
            });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });
    });

    describe('AI_GENERATE_VIDEO', () => {
        it('saves when mediaLocalPath is provided', async () => {
            const id = await saveAiResultToCache({
                ...BASE, type: 'AI_GENERATE_VIDEO', success: true,
                result: 'file:///path/vid.mp4', mediaLocalPath: '/path/vid.mp4',
            });
            expect(id).toBe(42);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                action: 'AI_GENERATE_VIDEO',
                mediaLocalPath: '/path/vid.mp4',
            }));
        });

        it('does not save when mediaLocalPath is absent', async () => {
            const id = await saveAiResultToCache({
                ...BASE, type: 'AI_GENERATE_VIDEO', success: true, result: 'base64vid',
            });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });
    });

    describe('AUDIO_SPEAK_AI', () => {
        it('saves when mediaLocalPath is provided', async () => {
            const id = await saveAiResultToCache({
                ...BASE, type: 'AUDIO_SPEAK_AI', success: true,
                result: 'file:///path/audio.mp3', mediaLocalPath: '/path/audio.mp3',
            });
            expect(id).toBe(42);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledWith(expect.objectContaining({
                action: 'AUDIO_SPEAK_AI',
                mediaLocalPath: '/path/audio.mp3',
            }));
        });
    });

    describe('tipos desconhecidos', () => {
        it('não salva para tipos não-AI', async () => {
            const id = await saveAiResultToCache({ ...BASE, type: 'STORAGE_SET', success: true, result: 'OK' });
            expect(id).toBeNull();
            expect(mockSaveWebviewAiCache).not.toHaveBeenCalled();
        });
    });

    describe('acumulação de histórico', () => {
        it('salva múltiplas entradas com o mesmo callbackName sem deduplicar', async () => {
            mockSaveWebviewAiCache.mockResolvedValueOnce(1).mockResolvedValueOnce(2);

            const id1 = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: 'resultado de ontem' });
            const id2 = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: 'resultado de hoje' });

            expect(id1).toBe(1);
            expect(id2).toBe(2);
            expect(mockSaveWebviewAiCache).toHaveBeenCalledTimes(2);
        });
    });

    describe('resiliência a erros de DB', () => {
        it('retorna null sem lançar quando saveWebviewAiCache falha', async () => {
            mockSaveWebviewAiCache.mockRejectedValueOnce(new Error('DB error'));
            const id = await saveAiResultToCache({ ...BASE, type: 'AI_GENERATE', success: true, result: 'ok' });
            expect(id).toBeNull();
        });
    });
});
