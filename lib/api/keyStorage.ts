/**
 * Secure storage wrapper for the user's OpenRouter API key.
 *
 * Storage layer: expo-secure-store (Android Keystore-backed via
 * EncryptedSharedPreferences, AES-256-GCM, hardware-backed in devices with TEE).
 *
 * Invariants enforced here:
 *   - The key never lives in AsyncStorage, SQLite, or in plain logs.
 *   - Reads are lazy at call sites (no module-level cache) to minimize the
 *     window in which the key sits in heap as a JS string.
 *   - `WHEN_UNLOCKED` keychain accessibility — only readable when the device
 *     is unlocked, which prevents background reads on a locked device.
 *
 * See Phase 1 of `ux-agent-agent-engineering-wondrous-snowglobe.md`,
 * section "Segurança da chave (token OpenRouter no dispositivo)".
 */

import * as SecureStore from 'expo-secure-store';

const KEY_NAME = 'openrouter_api_key';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

export async function getOpenRouterKey(): Promise<string | null> {
    try {
        const value = await SecureStore.getItemAsync(KEY_NAME, SECURE_STORE_OPTIONS);
        return value && value.length > 0 ? value : null;
    } catch {
        return null;
    }
}

export async function setOpenRouterKey(key: string): Promise<void> {
    const trimmed = key.trim();
    if (trimmed.length === 0) {
        throw new Error('OpenRouter key cannot be empty');
    }
    await SecureStore.setItemAsync(KEY_NAME, trimmed, SECURE_STORE_OPTIONS);
}

export async function clearOpenRouterKey(): Promise<void> {
    await SecureStore.deleteItemAsync(KEY_NAME, SECURE_STORE_OPTIONS);
}

export async function hasOpenRouterKey(): Promise<boolean> {
    const value = await getOpenRouterKey();
    return value !== null;
}

/**
 * Returns a redacted preview of the key for UI display.
 * Format: "sk-or-v1-...XXXX" (last 4 chars), or "•••" if too short.
 */
export function maskKey(key: string): string {
    if (!key) return '';
    if (key.length <= 8) return '•••';
    const prefixMatch = key.match(/^(sk-or-[a-z0-9]+-)/i);
    const prefix = prefixMatch ? prefixMatch[1] : key.slice(0, 6);
    const suffix = key.slice(-4);
    return `${prefix}...${suffix}`;
}
