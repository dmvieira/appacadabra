/**
 * Tests for lib/shareRead — the three-strategy fallback pipeline that reads
 * a shared content:// URI as base64.
 *
 * The bug this fixes: `FileSystem.copyAsync` throws (or returns a 0-byte
 * file) on quirky ContentProviders — most notably WhatsApp voice-note URIs
 * (`content://com.whatsapp.provider.media/...`). The old code wrapped the
 * read in a single try/catch that swallowed the error, letting the
 * downstream payload go out with `base64: undefined`. The spell then
 * "reconhecia como áudio e explodia rápido" because the file had 0 bytes.
 *
 * The pipeline: copyAsync+read → direct read → native openInputStream (Android).
 * The first strategy that returns a non-empty base64 wins. If all fail,
 * the caller must surface the failure to the user rather than navigating
 * with an empty payload.
 */

jest.mock('react-native', () => ({
    Platform: { OS: 'android' as 'ios' | 'android' | 'web' },
}));

jest.mock('expo-file-system/legacy', () => ({
    cacheDirectory: '/cache/',
    EncodingType: { Base64: 'base64' },
    copyAsync: jest.fn(),
    getInfoAsync: jest.fn(),
    readAsStringAsync: jest.fn(),
    deleteAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('share-intent', () => ({
    readContentUriBase64: jest.fn(),
}));

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ShareIntent from 'share-intent';
import { readContentUriAsBase64 } from '../shareRead';

const fs = FileSystem as unknown as {
    copyAsync: jest.Mock;
    getInfoAsync: jest.Mock;
    readAsStringAsync: jest.Mock;
    deleteAsync: jest.Mock;
};
const si = ShareIntent as unknown as {
    readContentUriBase64: jest.Mock;
};
const platformRef = Platform as unknown as { OS: 'ios' | 'android' | 'web' };

beforeEach(() => {
    fs.copyAsync.mockReset();
    fs.getInfoAsync.mockReset();
    fs.readAsStringAsync.mockReset();
    fs.deleteAsync.mockReset().mockResolvedValue(undefined);
    si.readContentUriBase64.mockReset();
    platformRef.OS = 'android';
    // silence console.warn noise from the module's fallthrough logging
    jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    (console.warn as jest.Mock).mockRestore?.();
});

const URI = 'content://com.whatsapp.provider.media/item/1234';

describe('readContentUriAsBase64 — strategy 1 (copyAsync) success', () => {
    it('returns base64 when copyAsync + readAsStringAsync succeed with non-empty file', async () => {
        fs.copyAsync.mockResolvedValueOnce(undefined);
        fs.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 42 });
        fs.readAsStringAsync.mockResolvedValueOnce('SGVsbG8=');
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBe('SGVsbG8=');
        expect(fs.copyAsync).toHaveBeenCalledTimes(1);
        expect(fs.readAsStringAsync).toHaveBeenCalledTimes(1);
        // Should not fall through to strategy 2/3
        expect(si.readContentUriBase64).not.toHaveBeenCalled();
    });

    it('strips \\r\\n from strategy 1 output', async () => {
        fs.copyAsync.mockResolvedValueOnce(undefined);
        fs.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 42 });
        fs.readAsStringAsync.mockResolvedValueOnce('SGVs\r\nbG8=\n');
        const result = await readContentUriAsBase64(URI, 'x.mp3');
        expect(result).toBe('SGVsbG8=');
    });
});

describe('readContentUriAsBase64 — strategy 1 falls through', () => {
    it('falls through when copyAsync throws, strategy 2 succeeds', async () => {
        fs.copyAsync.mockRejectedValueOnce(new Error('provider not readable'));
        fs.readAsStringAsync.mockResolvedValueOnce('QUJD');
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBe('QUJD');
        expect(fs.readAsStringAsync).toHaveBeenCalledWith(URI, { encoding: 'base64' });
    });

    it('falls through when copyAsync succeeds but produces 0-byte file', async () => {
        fs.copyAsync.mockResolvedValueOnce(undefined);
        fs.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 0 });
        fs.readAsStringAsync.mockResolvedValueOnce('WFla'); // strategy 2 direct read
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBe('WFla');
        // strategy 1 must NOT have called readAsStringAsync on the cache path
        // (only strategy 2's call on the content:// URI)
        expect(fs.readAsStringAsync).toHaveBeenCalledTimes(1);
        expect(fs.readAsStringAsync).toHaveBeenCalledWith(URI, { encoding: 'base64' });
    });

    it('falls through when copyAsync produces a file that reads back as empty string', async () => {
        fs.copyAsync.mockResolvedValueOnce(undefined);
        fs.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 42 });
        fs.readAsStringAsync
            .mockResolvedValueOnce('') // strategy 1 read
            .mockResolvedValueOnce('WFla'); // strategy 2 read
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBe('WFla');
    });
});

describe('readContentUriAsBase64 — strategy 3 (native) rescue', () => {
    it('rescues via native readContentUriBase64 when 1 and 2 both fail', async () => {
        fs.copyAsync.mockRejectedValueOnce(new Error('boom'));
        fs.readAsStringAsync.mockRejectedValueOnce(new Error('cannot read content://'));
        si.readContentUriBase64.mockReturnValueOnce('T1BVUw==');
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBe('T1BVUw==');
        expect(si.readContentUriBase64).toHaveBeenCalledWith(URI);
    });
});

describe('readContentUriAsBase64 — total failure', () => {
    it('returns null when all three Android strategies fail', async () => {
        fs.copyAsync.mockRejectedValueOnce(new Error('boom'));
        fs.readAsStringAsync.mockRejectedValueOnce(new Error('nope'));
        si.readContentUriBase64.mockReturnValueOnce(null);
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBeNull();
    });

    it('returns null when native rescue returns empty string', async () => {
        fs.copyAsync.mockRejectedValueOnce(new Error('boom'));
        fs.readAsStringAsync.mockRejectedValueOnce(new Error('nope'));
        si.readContentUriBase64.mockReturnValueOnce('');
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBeNull();
    });

    it('returns null when native rescue throws', async () => {
        fs.copyAsync.mockRejectedValueOnce(new Error('boom'));
        fs.readAsStringAsync.mockRejectedValueOnce(new Error('nope'));
        si.readContentUriBase64.mockImplementationOnce(() => {
            throw new Error('native crashed');
        });
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBeNull();
    });
});

describe('readContentUriAsBase64 — iOS skips strategy 3', () => {
    it('does not call native readContentUriBase64 on iOS even if 1 and 2 fail', async () => {
        platformRef.OS = 'ios';
        fs.copyAsync.mockRejectedValueOnce(new Error('boom'));
        fs.readAsStringAsync.mockRejectedValueOnce(new Error('nope'));
        const result = await readContentUriAsBase64(URI, 'voice.opus');
        expect(result).toBeNull();
        expect(si.readContentUriBase64).not.toHaveBeenCalled();
    });
});

describe('readContentUriAsBase64 — filename sanitization', () => {
    it('sanitizes filename with special characters when building cache path', async () => {
        fs.copyAsync.mockResolvedValueOnce(undefined);
        fs.getInfoAsync.mockResolvedValueOnce({ exists: true, size: 10 });
        fs.readAsStringAsync.mockResolvedValueOnce('SGVsbG8=');
        await readContentUriAsBase64(URI, 'crazy name?with*chars.opus');
        const cachePath = fs.copyAsync.mock.calls[0][0].to as string;
        // Only \w, ., - allowed; other chars became underscores
        expect(cachePath.startsWith('/cache/share_')).toBe(true);
        expect(/[\?\*\s]/.test(cachePath)).toBe(false);
    });
});
