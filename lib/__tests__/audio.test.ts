import { audioCapability } from '../capabilities/audio';
import { Audio } from 'expo-av';
import * as FileSystem from 'expo-file-system/legacy';
import { HandlerContext } from '../capabilities/types';

// Mock stores — Phase 4 (BYOK) baseline. No mana, no shop.
jest.mock('../bridgeUIStore', () => ({
    useBridgeUIStore: {
        getState: jest.fn(() => ({
            requestCostEstimate: jest.fn(() => Promise.resolve(true)),
            requestKeyMissing: jest.fn(() => Promise.resolve('openSettings')),
        })),
    },
}));

jest.mock('../api/keyStorage', () => ({
    hasOpenRouterKey: jest.fn(() => Promise.resolve(true)),
}));

jest.mock('../database/db', () => ({
    getSetting: jest.fn(() => Promise.resolve('true')),
    setSetting: jest.fn(),
}));

jest.mock('../capabilities/mediaHelpers', () => ({
    ...jest.requireActual('../capabilities/mediaHelpers'),
    saveAiMediaToFile: jest.fn(() => Promise.resolve('/mock/documents/appacadabra_media/1/onAudio.m4a')),
}));

jest.mock('../api/ai', () => ({
    aiGenerateTTS: jest.fn(() => Promise.resolve({ audioBase64: 'mock-base64', creditsUsed: 0 })),
}));

// Helper to create mock context
const createMockCtx = (appId: number | null = 1, callbackName: string = 'onDone'): HandlerContext => ({
    webViewRef: { current: { injectJavaScript: jest.fn() } },
    appId,
    callbackName,
});

describe('audioCapability', () => {
    beforeEach(() => {
        jest.clearAllMocks();
    });

    describe('AUDIO_RECORD_START', () => {
        it('should request permissions and start recording', async () => {
            const ctx = createMockCtx();
            const mockRequestPermissions = jest.fn(() => Promise.resolve({ granted: true }));
            (Audio.requestPermissionsAsync as jest.Mock) = mockRequestPermissions;

            const mockCreateAsync = jest.fn(() => Promise.resolve({ recording: { stopAndUnloadAsync: jest.fn() } }));
            (Audio.Recording.createAsync as jest.Mock) = mockCreateAsync;

            const result = await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            expect(mockRequestPermissions).toHaveBeenCalled();
            expect(mockCreateAsync).toHaveBeenCalledWith(Audio.RecordingOptionsPresets.HIGH_QUALITY);
            expect(result).toEqual({ success: true, result: 'Recording started' });
        });

        it('should return error if permission denied', async () => {
            const ctx = createMockCtx();
            (Audio.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });

            const result = await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            expect(result?.success).toBe(false);
            expect(result?.result).toContain('denied');
        });
    });

    describe('AUDIO_RECORD_STOP', () => {
        it('should stop recording and return base64 or marker', async () => {
            const ctx = createMockCtx(1, 'onAudio');
            const mockStopAndUnload = jest.fn();
            const mockGetURI = jest.fn(() => 'file://mock/recording.m4a');

            // Set the module-level currentRecording by starting it first
            (Audio.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
            (Audio.Recording.createAsync as jest.Mock).mockResolvedValue({
                recording: { stopAndUnloadAsync: mockStopAndUnload, getURI: mockGetURI }
            });
            await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            (FileSystem.readAsStringAsync as jest.Mock).mockResolvedValue('mock-b64-data');

            const result = await audioCapability.handleMessage('AUDIO_RECORD_STOP', {}, ctx);

            expect(mockStopAndUnload).toHaveBeenCalled();
            expect(mockGetURI).toHaveBeenCalled();
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

            const mockCreateSound = jest.fn(() => Promise.resolve({
                sound: {
                    playAsync: jest.fn(),
                    stopAsync: jest.fn(),
                    unloadAsync: jest.fn(),
                    setOnPlaybackStatusUpdate: jest.fn(),
                }
            }));
            (Audio.Sound.createAsync as jest.Mock) = mockCreateSound;

            const result = await audioCapability.handleMessage('AUDIO_PLAY', data, ctx);

            expect(FileSystem.writeAsStringAsync).toHaveBeenCalled();
            expect(mockCreateSound).toHaveBeenCalled();
            expect(result).toEqual({ success: true, result: 'Playing' });
        });

        it('should play from URL', async () => {
            const ctx = createMockCtx();
            const data = { url: 'https://example.com/audio.mp3' };

            const mockCreateSound = jest.fn(() => Promise.resolve({
                sound: {
                    playAsync: jest.fn(),
                    stopAsync: jest.fn(),
                    unloadAsync: jest.fn(),
                    setOnPlaybackStatusUpdate: jest.fn(),
                }
            }));
            (Audio.Sound.createAsync as jest.Mock) = mockCreateSound;

            const result = await audioCapability.handleMessage('AUDIO_PLAY', data, ctx);

            expect(mockCreateSound).toHaveBeenCalledWith({ uri: data.url }, { shouldPlay: true });
            expect(result).toEqual({ success: true, result: 'Playing' });
        });
    });

    describe('AUDIO_STOP', () => {
        it('should stop active playback', async () => {
            const ctx = createMockCtx();

            // First start playing to set currentAITTS
            const mockStopAsync = jest.fn();
            const mockUnloadAsync = jest.fn();
            (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({
                sound: {
                    stopAsync: mockStopAsync,
                    unloadAsync: mockUnloadAsync,
                    setOnPlaybackStatusUpdate: jest.fn(),
                }
            });
            await audioCapability.handleMessage('AUDIO_PLAY', { url: '...' }, ctx);

            const result = await audioCapability.handleMessage('AUDIO_STOP', {}, ctx);

            expect(mockStopAsync).toHaveBeenCalled();
            expect(mockUnloadAsync).toHaveBeenCalled();
            expect(result).toEqual({ success: true, result: 'Stopped' });
        });
    });

    describe('cleanup', () => {
        it('should stop recording and playback', async () => {
            const ctx = createMockCtx();

            // Set up state
            const mockStopRecording = jest.fn();
            (Audio.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
            (Audio.Recording.createAsync as jest.Mock).mockResolvedValue({
                recording: { stopAndUnloadAsync: mockStopRecording, getURI: jest.fn() }
            });
            await audioCapability.handleMessage('AUDIO_RECORD_START', {}, ctx);

            const mockStopSound = jest.fn();
            (Audio.Sound.createAsync as jest.Mock).mockResolvedValue({
                sound: { stopAsync: mockStopSound, unloadAsync: jest.fn(), setOnPlaybackStatusUpdate: jest.fn() }
            });
            await audioCapability.handleMessage('AUDIO_PLAY', { url: '...' }, ctx);

            if (audioCapability.cleanup) {
                await audioCapability.cleanup();
            }

            expect(mockStopRecording).toHaveBeenCalled();
            expect(mockStopSound).toHaveBeenCalled();
        });
    });
});
