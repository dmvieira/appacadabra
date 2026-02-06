// Global storage cache - preloaded on app startup
// This avoids race conditions when loading storage for individual apps

import * as db from './database/db';

export interface StorageItem {
    key: string;
    value: string;
}

// Cache structure: appId -> storage items
const storageCache: Map<number, StorageItem[]> = new Map();
let cacheLoaded = false;
let cacheLoadPromise: Promise<void> | null = null;

// Preload all storage for all apps
export async function preloadAllStorage(): Promise<void> {
    if (cacheLoaded) return;

    if (cacheLoadPromise) {
        return cacheLoadPromise;
    }

    cacheLoadPromise = (async () => {
        console.log('[StorageCache] Preloading all app storage...');
        const startTime = Date.now();

        try {
            // Get all apps
            const apps = await db.getAllApps();

            // Load storage for each app
            for (const app of apps) {
                const storage = await db.getStorageForApp(app.id);
                const items = storage.map(s => ({ key: s.key, value: s.value }));
                storageCache.set(app.id, items);
            }

            cacheLoaded = true;
            const elapsed = Date.now() - startTime;
            console.log(`[StorageCache] Preloaded storage for ${apps.length} apps in ${elapsed}ms`);
        } catch (error) {
            console.error('[StorageCache] Error preloading storage:', error);
            throw error;
        }
    })();

    return cacheLoadPromise;
}

// Get storage for a specific app from cache
export function getStorageFromCache(appId: number): StorageItem[] {
    const cached = storageCache.get(appId);
    if (cached) {
        console.log(`[StorageCache] Cache hit for app ${appId}: ${cached.length} items`);
        return cached;
    }
    console.log(`[StorageCache] Cache miss for app ${appId}`);
    return [];
}

// Update cache when storage is modified
export function updateStorageCache(appId: number, key: string, value: string): void {
    let items = storageCache.get(appId) || [];
    const existingIndex = items.findIndex(item => item.key === key);

    if (existingIndex >= 0) {
        items[existingIndex].value = value;
    } else {
        items = [...items, { key, value }];
    }

    storageCache.set(appId, items);
}

// Remove item from cache
export function removeFromStorageCache(appId: number, key: string): void {
    const items = storageCache.get(appId);
    if (items) {
        storageCache.set(appId, items.filter(item => item.key !== key));
    }
}

// Clear storage cache for an app
export function clearStorageCache(appId: number): void {
    storageCache.set(appId, []);
}

// Reload storage for a specific app (useful after database changes)
export async function reloadStorageForApp(appId: number): Promise<StorageItem[]> {
    console.log(`[StorageCache] Reloading storage for app ${appId}`);
    const storage = await db.getStorageForApp(appId);
    const items = storage.map(s => ({ key: s.key, value: s.value }));
    storageCache.set(appId, items);
    return items;
}

// Check if cache is ready
export function isCacheLoaded(): boolean {
    return cacheLoaded;
}

// Wait for cache to be ready
export async function waitForCache(): Promise<void> {
    if (cacheLoaded) return;
    if (cacheLoadPromise) {
        await cacheLoadPromise;
    }
}
