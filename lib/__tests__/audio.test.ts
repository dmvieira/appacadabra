import { audioCapability } from '../capabilities/audio';
import { AudioModule, createAudioPlayer, setAudioModeAsync, RecordingPresets } from 'expo-audio';
import * as FileSystem from 'expo-file-system/legacy';
import { HandlerContext } from '../capabilities/types';

// Mock stores — Phase 4 (BYOK) baseline. No mana, no shop.
jest.mock('../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: jest.fn(() => ({
            requestCostEstimate: jest.fn(() => Promise.resolve(true)),
            requestKeyMissing: jest.fn(() => Promise.resolve('openSettings')),
            requestModelUnavailable: jest.fn(),
        })),
    },
}));

jest.mock('../api/keyStorage', () => ({
    hasOpenRouterKey: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../database/db', () => ({
    getSetting: jest.fn(() => Promise.resolve('true')),
    setSetting: jest.fn(),
    incrementSpendUsd: jest.fn(() => Promise.resolve()),
}));

jest.mock('../capabilities/mediaHelpers', () => ({
    ...jest.requireActual('../capabilities/mediaHelpers'),
    saveAiMediaToFile: jest.fn(() => Promise.resolve('/mock/documents/appacadabra_media/1/onAudio.m4a')),
}));

jest.mock('../api/ai', () => ({
    aiGenerateTTS: jest.fn(() => Promise.resolve({ audioBase64: 'mock-base64', creditsUsed: 0 })),
    aiGenerateMusic: jest.fn(() => Promise.resolve({ audioBase64: 'mock-music-base64', usage: null, creditsUsed: 0, costUsd: 0.08 })),
}));

jest.mock('../api/modelPreferences', () => ({
    getPreferredModel: jest.fn(async (task: string) => `fallback/${task.toLowerCase()}`),
}));

jest.mock('../webviewAiKeepAlive', () => {
    const acquire = jest.fn((_reason: string) => Promise.resolve('tok-music'));
    const release = jest.fn((_token: string) => Promise.resolve());
    return {
        acquire,
        release,
        // Preserve the real wrapper's contract so the finally-path assertion
        // in the failure test actually exercises the release.
        withKeepAlive: jest.fn(async (reason: string, fn: () => Promise<unknown>) => {
            const token = await acquire(reason);
            try { return await fn(); }
            finally { await release(token); }
        }),
    };
});

// Helper to create mock context
const createMockCtx = (appId: number | null = 1, callbackName: string = 'onDone'): HandlerContext => ({
    webViewRef: { current: { injectJavaScript: jest.fn() } },
    appId,
    callbackName,
});

const createMockRecorder = (overrides: Record<string, unknown> = {}) => {
    const instance = {
        prepareToRecordAsync: jest.fn(() => Promise.resolve()),
        record: jest.fn(),
        stop: jest.fn(() => Promise.resolve()),
        release: jest.fn(),
        uri: 'file://mock/recording.m4a' as string | null,
        ...overrides,
    };
    (AudioModule.AudioRecorder as jest.Mock).mockImplementation(() => instance);
    return instance;
};

const createMockPlayer = () => {
    const instance = {
        play: jest.fn(),
        pause: jest.fn(),
        remove: jest.fn(),
        isLoaded: true,
        playing: true,
        addListener: jest.fn(() => ({ remove: jest.fn() })),
    };
    (createAudioPlayer as jest.Mock).mockReturnValue(instance);
    return instance;
};

describe('audioCapability', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('AUDIO_RECORD_START', () => {
        it('should request permissions, prepare and start recording', async () => {
            const ctx = createMockCtx();
            (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
            const recorder = createMockRecorder();

            const result = await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            expect(AudioModule.requestRecordingPermissionsAsync).toHaveBeenCalled();
            expect(recorder.prepareToRecordAsync).toHaveBeenCalled();
            expect(recorder.record).toHaveBeenCalled();
            // Platform options must be flattened for the native constructor
            expect(AudioModule.AudioRecorder).toHaveBeenCalledWith(
                expect.objectContaining({ extension: RecordingPresets.HIGH_QUALITY.extension })
            );
            expect(result).toEqual({ success: true, result: 'Recording started' });
        });

        it('should return error if permission denied', async () => {
            const ctx = createMockCtx();
            (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

            const result = await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            expect(result?.success).toBe(false);
            expect(result?.result).toContain('denied');
        });
    });

    describe('AUDIO_RECORD_STOP', () => {
        it('should stop recording and return base64 or marker', async () => {
            const ctx = createMockCtx(1, 'onAudio');
            const recorder = createMockRecorder();

            // Set the module-level currentRecording by starting it first
            (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
            await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('mock-b64-data');

            const result = await audioCapability.handleMessage('AUDIO_RECORD_STOP', {}, ctx);

            expect(recorder.stop).toHaveBeenCalled();
            expect(recorder.release).toHaveBeenCalled();
            expect(result?.success).toBe(true);
            expect(result?.result).toContain('__appblob__:audio/mp4|onAudio|');
        });

        it('should fail if no recording is active', async () => {
            const ctx = createMockCtx();
            const result = await audioCapability.handleMessage('AUDIO_RECORD_STOP', {}, ctx);
            expect(result?.success).toBe(false);
            expect(result?.result).toBe('No recording active');
        });
    });

    describe('AUDIO_PLAY', () => {
        it('should play from base64 data', async () => {
            const ctx = createMockCtx();
            const data = { base64: 'data:audio/mp4;base64,mockdata' };

            const player = createMockPlayer();

            const result = await audioCapability.handleMessage('AUDIO_PLAY', data, ctx);

            expect(FileSystem.writeAsStringAsync).toHaveBeenCalled();
            expect(createAudioPlayer).toHaveBeenCalledWith({ uri: expect.stringContaining('audio_play_') });
            expect(player.play).toHaveBeenCalled();
            expect(result).toEqual({ success: true, result: 'Playing' });
        });

        it('should play from URL', async () => {
            const ctx = createMockCtx();
            const data = { url: 'https://example.com/audio.mp3' };

            const player = createMockPlayer();

            const result = await audioCapability.handleMessage('AUDIO_PLAY', data, ctx);

            expect(createAudioPlayer).toHaveBeenCalledWith({ uri: data.url });
            expect(player.play).toHaveBeenCalled();
            expect(result).toEqual({ success: true, result: 'Playing' });
        });

        it('removes the player when playback finishes (didJustFinish)', async () => {
            const ctx = createMockCtx();
            let statusListener: ((status: { isLoaded: boolean; didJustFinish: boolean }) => void) | undefined;
            const player = createMockPlayer();
            (player.addListener as jest.Mock).mockImplementation((_event: string, listener: typeof statusListener) => {
                statusListener = listener;
                return { remove: jest.fn() };
            });

            await audioCapability.handleMessage('AUDIO_PLAY', { url: 'https://example.com/audio.mp3' }, ctx);

            statusListener?.({ isLoaded: true, didJustFinish: true });

            expect(player.remove).toHaveBeenCalled();
        });
    });

    describe('AUDIO_SPEAK_AI', () => {
        it('sets the audio session mode before creating the player', async () => {
            // Regression bar: without setAudioModeAsync a prior recordStart (or
            // another capability) leaves the session in a mode where MediaPlayer
            // silently drops playback on Android. Mirrors AUDIO_PLAY.
            const ctx = createMockCtx(1, 'onSpeak');

            (setAudioModeAsync as jest.Mock).mockClear();
            const player = createMockPlayer();

            await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'hello' }, ctx);

            expect(setAudioModeAsync).toHaveBeenCalledWith(expect.objectContaining({
                allowsRecording: false,
                playsInSilentMode: true,
            }));
            const modeOrder = (setAudioModeAsync as jest.Mock).mock.invocationCallOrder[0];
            const createOrder = (createAudioPlayer as jest.Mock).mock.invocationCallOrder[0];
            expect(modeOrder).toBeLessThan(createOrder);
        });

        it('signals ModelUnavailableModal when aiGenerateTTS throws byok.error.modelUnavailable', async () => {
            const ctx = createMockCtx(1, 'onSpeak');
            const requestModelUnavailable = jest.fn();
            const { useBridgeUIStore } = require('../bridgeUIStore');
            (useBridgeUIStore.getState as jest.Mock).mockReturnValue({
                requestCostEstimate: jest.fn(() => Promise.resolve(true)),
                requestKeyMissing: jest.fn(),
                requestModelUnavailable,
            });
            const { OpenRouterError } = require('../api/openrouter');
            const { aiGenerateTTS } = require('../api/ai');
            (aiGenerateTTS as jest.Mock).mockRejectedValueOnce(
                new OpenRouterError('byok.error.modelUnavailable', 'gone', 404, false, 'x/dead-tts'),
            );

            await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'hi', language: 'en' }, ctx);

            expect(requestModelUnavailable).toHaveBeenCalledWith(1, 'TTS', 'x/dead-tts');
        });

        it('stops and removes the previous TTS player before creating a new one', async () => {
            const ctx = createMockCtx(1, 'onSpeak');

            const firstPlayer = createMockPlayer();
            await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'first' }, ctx);

            const secondPlayer = createMockPlayer();
            await audioCapability.handleMessage('AUDIO_SPEAK_AI', { text: 'second' }, ctx);

            expect(firstPlayer.pause).toHaveBeenCalled();
            expect(firstPlayer.remove).toHaveBeenCalled();
        });
    });

    describe('AUDIO_GENERATE_MUSIC', () => {
        it('returns raw base64 and reports costUsd as creditsUsed on happy path', async () => {
            const ctx = createMockCtx(1, 'onMusic');

            const result = await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'upbeat lo-fi hip hop' },
                ctx,
            );

            expect(result?.success).toBe(true);
            expect(result?.result).toBe('mock-music-base64');
            expect(result?.creditsUsed).toBe(0.08);
        });

        it('surfaces requestKeyMissing when no OpenRouter key is set', async () => {
            const ctx = createMockCtx(1, 'onMusic');
            const { hasOpenRouterKey } = require('../api/keyStorage');
            const requestKeyMissing = jest.fn(() => Promise.resolve('openSettings'));
            (hasOpenRouterKey as jest.Mock).mockResolvedValueOnce(false);
            const { useBridgeUIStore } = require('../bridgeUIStore');
            (useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestKeyMissing,
                requestCostEstimate: jest.fn(),
            });

            const result = await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'anything' },
                ctx,
            );

            expect(requestKeyMissing).toHaveBeenCalledWith('music');
            expect(result?.success).toBe(false);
        });

        it('aborts if the cost estimate is cancelled', async () => {
            const ctx = createMockCtx(1, 'onMusic');
            const { useBridgeUIStore } = require('../bridgeUIStore');
            (useBridgeUIStore.getState as jest.Mock).mockReturnValueOnce({
                requestKeyMissing: jest.fn(),
                requestCostEstimate: jest.fn(() => Promise.resolve(false)),
            });

            const result = await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'anything' },
                ctx,
            );

            expect(result?.success).toBe(false);
            expect(result?.result).toBe('Cost confirmation cancelled.');
        });

        it('signals ModelUnavailableModal when aiGenerateMusic throws byok.error.modelUnavailable', async () => {
            const ctx = createMockCtx(2, 'onMusic');
            const requestModelUnavailable = jest.fn();
            const { useBridgeUIStore } = require('../bridgeUIStore');
            (useBridgeUIStore.getState as jest.Mock).mockReturnValue({
                requestCostEstimate: jest.fn(() => Promise.resolve(true)),
                requestKeyMissing: jest.fn(),
                requestModelUnavailable,
            });
            const { OpenRouterError } = require('../api/openrouter');
            const { aiGenerateMusic } = require('../api/ai');
            (aiGenerateMusic as jest.Mock).mockRejectedValueOnce(
                new OpenRouterError('byok.error.modelUnavailable', 'gone', 404, false, 'x/dead-music'),
            );

            const result = await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'anything' },
                ctx,
            );

            expect(requestModelUnavailable).toHaveBeenCalledWith(2, 'MUSIC', 'x/dead-music');
            expect(result?.success).toBe(false);
        });

        it('acquires the keep-alive before aiGenerateMusic and releases after (Android FGS / iOS BG task)', async () => {
            const ctx = createMockCtx(1, 'onMusic');
            const { acquire, release } = require('../webviewAiKeepAlive');
            const { aiGenerateMusic } = require('../api/ai');

            await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'jazz' },
                ctx,
            );

            expect(acquire).toHaveBeenCalledWith('music');
            expect(release).toHaveBeenCalledWith('tok-music');
            const acquireOrder = (acquire as jest.Mock).mock.invocationCallOrder[0];
            const generateOrder = (aiGenerateMusic as jest.Mock).mock.invocationCallOrder[0];
            const releaseOrder = (release as jest.Mock).mock.invocationCallOrder[0];
            expect(acquireOrder).toBeLessThan(generateOrder);
            expect(generateOrder).toBeLessThan(releaseOrder);
        });

        it('releases the keep-alive even when aiGenerateMusic rejects (finally path)', async () => {
            // Regression bar: if release is skipped on error, the Android
            // foreground service notification stays up indefinitely.
            const ctx = createMockCtx(1, 'onMusic');
            const { release } = require('../webviewAiKeepAlive');
            const { aiGenerateMusic } = require('../api/ai');
            (aiGenerateMusic as jest.Mock).mockRejectedValueOnce(new Error('boom'));

            const result = await audioCapability.handleMessage(
                'AUDIO_GENERATE_MUSIC',
                { prompt: 'anything' },
                ctx,
            );

            expect(result?.success).toBe(false);
            expect(release).toHaveBeenCalledWith('tok-music');
        });
    });

    describe('AUDIO_STOP', () => {
        it('should stop active playback', async () => {
            const ctx = createMockCtx();

            // First start playing to set currentAITTS
            const player = createMockPlayer();
            await audioCapability.handleMessage('AUDIO_PLAY', { url: '...' }, ctx);

            const result = await audioCapability.handleMessage('AUDIO_STOP', {}, ctx);

            expect(player.pause).toHaveBeenCalled();
            expect(player.remove).toHaveBeenCalled();
            expect(result).toEqual({ success: true, result: 'Stopped' });
        });
    });

    describe('cleanup', () => {
        it('should stop recording and playback', async () => {
            const ctx = createMockCtx();

            // Set up state
            const recorder = createMockRecorder();
            (AudioModule.requestRecordingPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
            await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            const player = createMockPlayer();
            await audioCapability.handleMessage('AUDIO_PLAY', { url: '...' }, ctx);

            if (audioCapability.cleanup) {
                await audioCapability.cleanup();
            }

            expect(recorder.stop).toHaveBeenCalled();
            expect(player.pause).toHaveBeenCalled();
            expect(player.remove).toHaveBeenCalled();
        });
    });
});
