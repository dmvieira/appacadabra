/**
 * Facade tests for lib/webviewAiKeepAlive.
 *
 * The facade routes to `BackgroundGenerator.acquireKeepAlive/releaseKeepAlive`
 * on iOS (extends the ~30s background window) and to `WebViewAiKeepAlive.
 * acquire/release` on Android (holds a ref-counted foreground service). These
 * tests pin:
 *   - Platform routing (iOS → BackgroundGenerator; Android → WebViewAiKeepAlive)
 *   - Balanced acquire/release calls at the native layer
 *   - Missing-module and error paths degrade to no-op so an AI call never
 *     fails because keep-alive couldn't be armed
 *   - Multiple concurrent tokens are independent (one release doesn't clear
 *     another token's grip)
 *   - `release("")` short-circuits (never routes to the native module)
 */

jest.mock('react-native', () => ({
    // Mutable so tests can flip iOS → Android inside a single suite.
    Platform: { OS: 'ios' as 'ios' | 'android' | 'web' },
    NativeModules: {
        BackgroundGenerator: {
            acquireKeepAlive: jest.fn(),
            releaseKeepAlive: jest.fn(),
        },
        WebViewAiKeepAlive: {
            acquire: jest.fn(),
            release: jest.fn(),
        },
    },
    DeviceEventEmitter: { addListener: jest.fn(), removeAllListeners: jest.fn() },
}));

jest.mock('../i18n', () => ({
    t: (key: string) => (key === 'webviewAiKeepAliveNotification' ? 'Running AI…' : key),
}));

import { NativeModules, Platform } from 'react-native';
import * as keepAlive from '../webviewAiKeepAlive';

const iosMod = (NativeModules as any).BackgroundGenerator as {
    acquireKeepAlive: jest.Mock;
    releaseKeepAlive: jest.Mock;
};
const androidMod = (NativeModules as any).WebViewAiKeepAlive as {
    acquire: jest.Mock;
    release: jest.Mock;
};
const platformRef = Platform as unknown as { OS: 'ios' | 'android' | 'web' };

beforeEach(() => {
    iosMod.acquireKeepAlive.mockReset();
    iosMod.releaseKeepAlive.mockReset();
    androidMod.acquire.mockReset();
    androidMod.release.mockReset();
    platformRef.OS = 'ios';
});

describe('webviewAiKeepAlive — iOS routing', () => {
    it('acquire routes to BackgroundGenerator.acquireKeepAlive with reason', async () => {
        iosMod.acquireKeepAlive.mockResolvedValueOnce('ka-1');
        const token = await keepAlive.acquire('generate');
        expect(token).toBe('ka-1');
        expect(iosMod.acquireKeepAlive).toHaveBeenCalledWith('generate');
        expect(androidMod.acquire).not.toHaveBeenCalled();
    });

    it('release routes to BackgroundGenerator.releaseKeepAlive with token', async () => {
        iosMod.releaseKeepAlive.mockResolvedValueOnce(undefined);
        await keepAlive.release('ka-1');
        expect(iosMod.releaseKeepAlive).toHaveBeenCalledWith('ka-1');
        expect(androidMod.release).not.toHaveBeenCalled();
    });
});

describe('webviewAiKeepAlive — Android routing', () => {
    beforeEach(() => { platformRef.OS = 'android'; });

    it('acquire routes to WebViewAiKeepAlive.acquire with reason and localized title', async () => {
        androidMod.acquire.mockResolvedValueOnce('wka-1');
        const token = await keepAlive.acquire('image');
        expect(token).toBe('wka-1');
        expect(androidMod.acquire).toHaveBeenCalledWith('image', 'Running AI…');
        expect(iosMod.acquireKeepAlive).not.toHaveBeenCalled();
    });

    it('release routes to WebViewAiKeepAlive.release with token', async () => {
        androidMod.release.mockResolvedValueOnce(undefined);
        await keepAlive.release('wka-1');
        expect(androidMod.release).toHaveBeenCalledWith('wka-1');
        expect(iosMod.releaseKeepAlive).not.toHaveBeenCalled();
    });
});

describe('webviewAiKeepAlive — safe fallbacks', () => {
    it('acquire returns empty string when the native module throws', async () => {
        iosMod.acquireKeepAlive.mockRejectedValueOnce(new Error('boom'));
        const token = await keepAlive.acquire('generate');
        expect(token).toBe('');
    });

    it('release swallows native errors so the AI call finally-block never throws', async () => {
        iosMod.releaseKeepAlive.mockRejectedValueOnce(new Error('boom'));
        await expect(keepAlive.release('ka-1')).resolves.toBeUndefined();
    });

    it('release("") is a no-op that never routes to the native module', async () => {
        await keepAlive.release('');
        expect(iosMod.releaseKeepAlive).not.toHaveBeenCalled();
        expect(androidMod.release).not.toHaveBeenCalled();
    });

    it('acquire on an unsupported platform returns empty string without throwing', async () => {
        platformRef.OS = 'web';
        const token = await keepAlive.acquire('generate');
        expect(token).toBe('');
        expect(iosMod.acquireKeepAlive).not.toHaveBeenCalled();
        expect(androidMod.acquire).not.toHaveBeenCalled();
    });
});

describe('webviewAiKeepAlive — concurrency', () => {
    it('preserves independent tokens across parallel acquires', async () => {
        iosMod.acquireKeepAlive
            .mockResolvedValueOnce('ka-1')
            .mockResolvedValueOnce('ka-2');
        const [a, b] = await Promise.all([
            keepAlive.acquire('generate'),
            keepAlive.acquire('image'),
        ]);
        expect(a).toBe('ka-1');
        expect(b).toBe('ka-2');
        expect(iosMod.acquireKeepAlive).toHaveBeenCalledTimes(2);
    });

    it('releasing one token does not release the other', async () => {
        iosMod.releaseKeepAlive.mockResolvedValue(undefined);
        await keepAlive.release('ka-1');
        expect(iosMod.releaseKeepAlive).toHaveBeenCalledTimes(1);
        expect(iosMod.releaseKeepAlive).toHaveBeenCalledWith('ka-1');
        await keepAlive.release('ka-2');
        expect(iosMod.releaseKeepAlive).toHaveBeenCalledTimes(2);
        expect(iosMod.releaseKeepAlive).toHaveBeenLastCalledWith('ka-2');
    });
});
