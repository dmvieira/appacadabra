/**
 * Secure storage for MCP credentials.
 *
 * Tokens (OAuth access/refresh, static bearer keys) and DCR client secrets
 * live only in expo-secure-store (Android Keystore-backed). Nothing here is
 * ever written to SQLite, AsyncStorage, or logs.
 *
 * Mirrors `lib/api/keyStorage.ts`.
 */

import * as SecureStore from 'expo-secure-store';
import type { McpTokenBundle } from './types';

const SECURE_STORE_OPTIONS: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

function keyFor(slug: string): string {
    return `mcp_tokens_${slug}`;
}

/** SecureStore key reference persisted in the DB (never the token itself). */
export function tokenRefFor(slug: string): string {
    return keyFor(slug);
}

export async function saveTokens(slug: string, bundle: McpTokenBundle): Promise<void> {
    await SecureStore.setItemAsync(keyFor(slug), JSON.stringify(bundle), SECURE_STORE_OPTIONS);
}

export async function getTokens(slug: string): Promise<McpTokenBundle | null> {
    try {
        const raw = await SecureStore.getItemAsync(keyFor(slug), SECURE_STORE_OPTIONS);
        if (!raw) return null;
        const parsed = JSON.parse(raw) as McpTokenBundle;
        return parsed && typeof parsed.accessToken === 'string' ? parsed : null;
    } catch {
        return null;
    }
}

export async function clearTokens(slug: string): Promise<void> {
    try {
        await SecureStore.deleteItemAsync(keyFor(slug), SECURE_STORE_OPTIONS);
    } catch {
        // best-effort
    }
}
