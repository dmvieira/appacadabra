import * as FileSystem from 'expo-file-system/legacy';
import { createCallbackScript, buildBlobMarker, saveAiMediaToFile, AI_MEDIA_EXT } from '../mediaHelpers';

describe('createCallbackScript', () => {
    it('returns a string containing the callback name', () => {
        const script = createCallbackScript('myCallback', true, 'hello');
        expect(script).toContain('myCallback');
    });

    it('handles string data directly (no JSON.stringify)', () => {
        const script = createCallbackScript('cb', true, 'hello world');
        expect(script).toContain('hello world');
    });

    it('handles object data by JSON.stringifying it', () => {
        const script = createCallbackScript('cb', true, { key: 'value' });
        expect(script).toContain('key');
        expect(script).toContain('value');
    });

    it('works with success = false', () => {
        const script = createCallbackScript('cb', false, 'error');
        expect(script).toContain('false');
    });

    it('escapes backslashes', () => {
        const script = createCallbackScript('cb', true, 'a\\b');
        expect(script).toContain('a\\\\b');
    });

    it('escapes double quotes', () => {
        const script = createCallbackScript('cb', true, 'say "hi"');
        expect(script).toContain('\\"hi\\"');
    });

    it('escapes newlines', () => {
        const script = createCallbackScript('cb', true, 'line1\nline2');
        expect(script).toContain('\\n');
        expect(script).not.toMatch(/line1\nline2/);
    });

    it('escapes carriage returns', () => {
        const script = createCallbackScript('cb', true, 'line1\rline2');
        expect(script).toContain('\\r');
    });

    it('escapes tabs', () => {
        const script = createCallbackScript('cb', true, 'col1\tcol2');
        expect(script).toContain('\\t');
    });

    it('escapes Unicode line separator \\u2028', () => {
        const script = createCallbackScript('cb', true, 'a\u2028b');
        expect(script).toContain('\\u2028');
    });

    it('escapes Unicode paragraph separator \\u2029', () => {
        const script = createCallbackScript('cb', true, 'a\u2029b');
        expect(script).toContain('\\u2029');
    });
});

describe('buildBlobMarker', () => {
    it('returns __appblob__:mimeType|callbackName|path', () => {
        const marker = buildBlobMarker('image/jpeg', 'cb_test', '/path/to/file.jpg');
        expect(marker).toBe('__appblob__:image/jpeg|cb_test|/path/to/file.jpg');
    });

    it('includes all three components separated by |', () => {
        const marker = buildBlobMarker('video/mp4', 'myCb', '/data/video.mp4');
        expect(marker).toContain('video/mp4');
        expect(marker).toContain('myCb');
        expect(marker).toContain('/data/video.mp4');
        expect(marker.split('|')).toHaveLength(3);
    });
});

describe('saveAiMediaToFile', () => {
    const mockMakeDir = FileSystem.makeDirectoryAsync as jest.Mock;
    const mockWrite = FileSystem.writeAsStringAsync as jest.Mock;

    beforeEach(() => {
        mockMakeDir.mockResolvedValue(undefined);
        mockWrite.mockResolvedValue(undefined);
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('calls makeDirectoryAsync with intermediates: true', async () => {
        await saveAiMediaToFile(1, 'cb_test', 'AI_GENERATE_IMAGE', 'base64data');
        expect(mockMakeDir).toHaveBeenCalledWith(
            expect.stringContaining('appacadabra_media/1'),
            { intermediates: true }
        );
    });

    it('calls writeAsStringAsync with Base64 encoding', async () => {
        await saveAiMediaToFile(1, 'cb_test', 'AI_GENERATE_IMAGE', 'base64data');
        expect(mockWrite).toHaveBeenCalledWith(
            expect.any(String),
            'base64data',
            { encoding: FileSystem.EncodingType.Base64 }
        );
    });

    it('uses jpg extension for AI_GENERATE_IMAGE', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'AI_GENERATE_IMAGE', 'data');
        expect(path).toMatch(/\.jpg$/);
    });

    it('uses mp4 extension for AI_GENERATE_VIDEO', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'AI_GENERATE_VIDEO', 'data');
        expect(path).toMatch(/\.mp4$/);
    });

    it('uses m4a extension for AUDIO_RECORD_STOP', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'AUDIO_RECORD_STOP', 'data');
        expect(path).toMatch(/\.m4a$/);
    });

    it('uses wav extension for AUDIO_SPEAK_AI', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'AUDIO_SPEAK_AI', 'data');
        expect(path).toMatch(/\.wav$/);
    });

    it('uses jpg extension for CAMERA_TAKE_PHOTO', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'CAMERA_TAKE_PHOTO', 'data');
        expect(path).toMatch(/\.jpg$/);
    });

    it('uses mp4 extension for CAMERA_RECORD_VIDEO', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'CAMERA_RECORD_VIDEO', 'data');
        expect(path).toMatch(/\.mp4$/);
    });

    it('falls back to bin for unknown action', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'UNKNOWN_ACTION', 'data');
        expect(path).toMatch(/\.bin$/);
    });

    it('returns a bare path without file:// prefix', async () => {
        const path = await saveAiMediaToFile(1, 'cb', 'AI_GENERATE_IMAGE', 'data');
        expect(path).not.toMatch(/^file:\/\//);
    });

    it('includes the appId in the path', async () => {
        const path = await saveAiMediaToFile(42, 'cb', 'AI_GENERATE_IMAGE', 'data');
        expect(path).toContain('/42/');
    });

    it('uses callbackName as the filename base', async () => {
        const path = await saveAiMediaToFile(1, 'my_callback', 'AI_GENERATE_IMAGE', 'data');
        expect(path).toContain('my_callback');
    });

    it('silently ignores makeDirectoryAsync errors (directory already exists)', async () => {
        mockMakeDir.mockRejectedValueOnce(new Error('Directory already exists'));
        // Should not throw even when mkdir fails
        await expect(saveAiMediaToFile(1, 'cb', 'AI_GENERATE_IMAGE', 'data')).resolves.toBeDefined();
    });

    it('works when documentDirectory is null (uses empty string fallback)', async () => {
        const FileSystemModule = require('expo-file-system/legacy');
        const original = FileSystemModule.documentDirectory;
        FileSystemModule.documentDirectory = null;
        try {
            // Should not throw; uses '' as the base directory
            await expect(saveAiMediaToFile(1, 'cb', 'AI_GENERATE_IMAGE', 'data')).resolves.toBeDefined();
        } finally {
            FileSystemModule.documentDirectory = original;
        }
    });
});

describe('AI_MEDIA_EXT', () => {
    it('maps all expected action types', () => {
        expect(AI_MEDIA_EXT['AI_GENERATE_IMAGE']).toBe('jpg');
        expect(AI_MEDIA_EXT['AI_GENERATE_VIDEO']).toBe('mp4');
        expect(AI_MEDIA_EXT['CAMERA_TAKE_PHOTO']).toBe('jpg');
        expect(AI_MEDIA_EXT['CAMERA_RECORD_VIDEO']).toBe('mp4');
        expect(AI_MEDIA_EXT['AUDIO_RECORD_STOP']).toBe('m4a');
        expect(AI_MEDIA_EXT['AUDIO_SPEAK_AI']).toBe('wav');
    });
});
