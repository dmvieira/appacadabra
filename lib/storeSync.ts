import { create } from 'zustand';
import * as Localization from 'expo-localization';
import * as firebase from './firebase';
import { getAppById, updateAppStoreLink, getAppByStoreSpellId, getAppsWithStoreSpellId, insertApp } from './database/db';
import { useAppStore } from './store';

/**
 * Spell Store sync — owns the round-trip between a local spell and its
 * published Firestore counterpart. UI components stay thin: they call
 * `publishSpell` / `unpublishSpell` here and let the store update both
 * Firebase and the local SQLite row atomically.
 */

export interface PublishOptions {
    /** Local SQLite row id (generated_apps.id) */
    appId: number;
    /** Display name shown in the Store listing. */
    name: string;
    /** Description shown in the Store listing. Translated to 17 languages by the backend. */
    description: string;
    /** Optional PNG preview as base64 (no data: prefix). */
    previewImageBase64?: string;
    /** Optional PNG icon as base64 (no data: prefix). */
    iconBase64?: string;
    /** Defaults to 'public'. Use 'unlisted' for share-link-only spells. */
    visibility?: 'public' | 'unlisted';
}

export interface PublishOutcome {
    spellId: string;
    slug: string;
    storeUrl: string;
}

interface StoreSyncState {
    /** True while a publish or unpublish call is in flight. */
    isPublishing: boolean;
    /** True while a learned-spell sync round-trip is in flight. */
    isSyncing: boolean;
    /** Last error from publish/unpublish, surfaced for UI display. */
    lastError: string | null;

    publishSpell: (opts: PublishOptions) => Promise<PublishOutcome>;
    unpublishSpell: (appId: number, storeSpellId: string) => Promise<void>;
    syncLearnedSpells: () => Promise<void>;
    syncPublishedSpellsStatus: () => Promise<void>;
    clearError: () => void;
}

export const useStoreSyncStore = create<StoreSyncState>((set, get) => ({
    isPublishing: false,
    isSyncing: false,
    lastError: null,

    publishSpell: async (opts) => {
        set({ isPublishing: true, lastError: null });
        try {
            const app = await getAppById(opts.appId);
            if (!app) {
                throw new Error('Spell not found in local database');
            }

            const result = await firebase.publishSpell({
                name: opts.name,
                description: opts.description,
                htmlBase64: firebase.compressContent(firebase.decompressContent(app.code ?? '')),
                version: app.currentVersion,
                previewImageBase64: opts.previewImageBase64,
                iconBase64: opts.iconBase64,
                visibility: opts.visibility ?? 'public',
                forkOfSpellId: app.forkOfStoreSpellId ?? undefined,
                locale: Localization.getLocales()[0]?.languageCode ?? undefined,
                existingSpellId: app.storeSpellId ?? undefined,
            });

            // Persist the link so the AppCard menu can show "View in Store" / "Unpublish"
            await updateAppStoreLink(opts.appId, result.spellId, result.slug, opts.visibility ?? 'public');
            try { useAppStore.getState().loadApps(); } catch {}

            set({ isPublishing: false });
            return result;
        } catch (e: any) {
            const message = e?.message || 'Failed to publish spell';
            console.error('[StoreSync] publishSpell error:', message);
            set({ isPublishing: false, lastError: message });
            throw e;
        }
    },

    unpublishSpell: async (appId, storeSpellId) => {
        set({ isPublishing: true, lastError: null });
        try {
            await firebase.unpublishSpell(storeSpellId);
            await updateAppStoreLink(appId, null, null);
            try { useAppStore.getState().loadApps(); } catch {}
            set({ isPublishing: false });
        } catch (e: any) {
            const message = e?.message || 'Failed to unpublish spell';
            console.error('[StoreSync] unpublishSpell error:', message);
            set({ isPublishing: false, lastError: message });
            throw e;
        }
    },

    syncLearnedSpells: async () => {
        const { isSyncing } = get();
        if (isSyncing) return; // prevent concurrent runs
        set({ isSyncing: true });
        try {
            const { spells } = await firebase.syncLearnedSpells();
            let imported = 0;
            const now = Date.now();
            for (const spell of spells) {
                // Dedup: skip if already imported
                const existing = await getAppByStoreSpellId(spell.spellId);
                if (existing) {
                    // Already imported — make sure the server-side flag is in sync
                    try {
                        await firebase.markSpellSynced(spell.spellId, existing.id, true);
                    } catch (e: any) {
                        console.warn('[StoreSync] markSpellSynced (dedup) failed:', e?.message);
                    }
                    continue;
                }
                // Download HTML from signed URL
                let html: string;
                try {
                    const response = await fetch(spell.signedHtmlUrl);
                    if (!response.ok) {
                        console.warn(`[StoreSync] HTML fetch failed for ${spell.spellId}: ${response.status}`);
                        continue;
                    }
                    html = await response.text();
                } catch (e: any) {
                    console.warn(`[StoreSync] HTML fetch error for ${spell.spellId}:`, e?.message);
                    continue;
                }
                // Pick the locale-matched metadata; fall back to EN, then to the raw fields.
                const userLang = Localization.getLocales()[0]?.languageCode ?? 'en';
                const meta = spell.translations?.[userLang]
                    ?? spell.translations?.['en']
                    ?? { name: spell.name, description: spell.description };

                // Insert into SQLite — isolated so one bad row doesn't stop the rest
                try {
                    const appId = await insertApp({
                        name: meta.name,
                        code: html,
                        currentVersion: spell.publishedVersion,
                        shortDescription: meta.description,
                        source: 'store',
                        storeSpellId: spell.spellId,
                        storeSpellSlug: spell.slug,
                        forkOfStoreSpellId: spell.forkOfSpellId ?? null,
                        iconPath: null,
                        lastUpdated: now,
                        createdAt: now,
                        consoleLogs: '',
                        totalManaCost: 0,
                        requiresBiometric: false,
                        sortOrder: 0,
                    });
                    try {
                        await firebase.markSpellSynced(spell.spellId, appId, true);
                    } catch (e: any) {
                        console.warn('[StoreSync] markSpellSynced failed:', e?.message);
                    }
                    imported++;
                } catch (e: any) {
                    console.warn(`[StoreSync] insertApp failed for ${spell.spellId}:`, e?.message);
                }
            }
            if (imported > 0) {
                try { useAppStore.getState().loadApps(); } catch {}
            }
        } catch (e: any) {
            console.error('[StoreSync] syncLearnedSpells error:', e?.message);
        } finally {
            set({ isSyncing: false });
        }
    },

    syncPublishedSpellsStatus: async () => {
        let cleared = 0;
        try {
            const published = await getAppsWithStoreSpellId();
            for (const app of published) {
                if (!app.storeSpellId) continue;
                const status = await firebase.getStoreSpellStatus(app.storeSpellId);
                if (status !== 'active') {
                    await updateAppStoreLink(app.id, null, null);
                    cleared++;
                }
            }
        } catch (e: any) {
            console.warn('[StoreSync] syncPublishedSpellsStatus error:', e?.message);
        }
        if (cleared > 0) {
            try { useAppStore.getState().loadApps(); } catch {}
        }
    },

    clearError: () => set({ lastError: null }),
}));
