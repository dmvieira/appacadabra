/**
 * Round-trip + redaction tests for the OpenRouter key wrapper. The wrapper is
 * the only correct path to read/write the key — everything else routes
 * through it — so misbehaviour here is a security bug, not a UX bug.
 */

jest.mock('expo-secure-store', () => {
    let store: Record<string, string> = {};
    return {
        WHEN_UNLOCKED: 'WHEN_UNLOCKED',
        setItemAsync: jest.fn(async (k: string, v: string) => {
            store[k] = v;
        }),
        getItemAsync: jest.fn(async (k: string) => store[k] ?? null),
        deleteItemAsync: jest.fn(async (k: string) => {
            delete store[k];
        }),
        __reset: () => {
            store = {};
        },
    };
});

import * as SecureStore from 'expo-secure-store';
import {
    getOpenRouterKey,
    setOpenRouterKey,
    clearOpenRouterKey,
    hasOpenRouterKey,
    maskKey,
} from '../api/keyStorage';

beforeEach(() => {
    (SecureStore as any).__reset();
});

describe('keyStorage', () => {
    it('returns null when nothing has been written', async () => {
        expect(await getOpenRouterKey()).toBeNull();
        expect(await hasOpenRouterKey()).toBe(false);
    });

    it('round-trips a key value through SecureStore', async () => {
        await setOpenRouterKey('sk-or-v1-abcdef');
        expect(await getOpenRouterKey()).toBe('sk-or-v1-abcdef');
        expect(await hasOpenRouterKey()).toBe(true);
    });

    it('uses WHEN_UNLOCKED accessibility on write', async () => {
        await setOpenRouterKey('sk-or-v1-test');
        expect((SecureStore.setItemAsync as jest.Mock)).toHaveBeenCalledWith(
            expect.any(String),
            'sk-or-v1-test',
            expect.objectContaining({ keychainAccessible: 'WHEN_UNLOCKED' }),
        );
    });

    it('trims whitespace before storing', async () => {
        await setOpenRouterKey('   sk-or-v1-xyz  \n');
        expect(await getOpenRouterKey()).toBe('sk-or-v1-xyz');
    });

    it('rejects empty input rather than writing an empty value', async () => {
        await expect(setOpenRouterKey('   ')).rejects.toThrow();
    });

    it('clear removes the key', async () => {
        await setOpenRouterKey('sk-or-v1-keep');
        await clearOpenRouterKey();
        expect(await getOpenRouterKey()).toBeNull();
    });

    it('treats SecureStore read errors as "no key" so the UI fails closed', async () => {
        (SecureStore.getItemAsync as jest.Mock).mockRejectedValueOnce(new Error('keystore broken'));
        expect(await getOpenRouterKey()).toBeNull();
    });
});

describe('maskKey', () => {
    it('returns empty string for empty input', () => {
        expect(maskKey('')).toBe('');
    });
    it('returns bullets for very short keys (never shows the key)', () => {
        expect(maskKey('abc')).toBe('•••');
    });
    it('preserves the sk-or-v1- prefix and last 4 chars only', () => {
        expect(maskKey('sk-or-v1-abcdefghijklmn')).toBe('sk-or-v1-...klmn');
    });
});
