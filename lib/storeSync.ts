import { create } from 'zustand';
import * as Localization from 'expo-localization';
import * as FileSystem from 'expo-file-system/legacy';
import firebaseFirestore, { collection, query, where, getDocs } from '@react-native-firebase/firestore';
import * as firebase from './firebase';
import { publicStorageUrl } from './firebase';
import {
    getAppById,
    updateAppStoreLink,
    getAppByStoreSpellId,
    getAppsWithStoreSpellId,
    getAllApps,
    insertApp,
    getDeletedStoreSpellTombstones,
    removeDeletedStoreSpellTombstone,
    touchAppLastUpdated,
} from './database/db';
import { useAppStore } from './store';
import { t } from './i18n';

/**
 * Server flag mirror. The callable wrapper was removed with the BYOK refactor
 * and Firestore rules block client writes to users/{uid}/learned_spells/{id}
 * (`allow write: if false`). The local SQLite row (storeSpellId column) is the
 * source of truth, so a stale `syncedAt` flag on the server doc is non-fatal.
 * TODO(Phase4-rules): if/when rules grow a self-write allowance, replace this
 * with a `setDoc({ syncedAt, localAppId }, { merge: true })`.
 */
async function markSpellSyncedStub(_spellId: string, _appId: number, _synced: boolean): Promise<void> {
    return;
}

interface MyPublishedSpellEntry {
    spellId: string;
    name: string;
    slug: string;
    visibility: 'public' | 'unlisted';
}

/**
 * Lists the current user's published store spells by querying
 * `store_spells where authorUid == uid and status == 'active'`. Firestore
 * rules allow reads on active store_spells, so this works client-side.
 */
async function getMyPublishedSpells(): Promise<{ spells: MyPublishedSpellEntry[] }> {
    const uid = firebase.getCurrentUserId();
    if (!uid) return { spells: [] };
    try {
        const firestore = firebaseFirestore();
        const q = query(
            collection(firestore, 'store_spells'),
            where('authorUid', '==', uid),
            where('status', '==', 'active'),
        );
        const snap = await getDocs(q);
        const spells: MyPublishedSpellEntry[] = snap.docs.map((d: any) => {
            const data = d.data() ?? {};
            const visibility: 'public' | 'unlisted' = data.visibility === 'unlisted' ? 'unlisted' : 'public';
            return {
                spellId: d.id,
                name: typeof data.name === 'string' ? data.name : '',
                slug: typeof data.slug === 'string' ? data.slug : '',
                visibility,
            };
        });
        return { spells };
    } catch (e: any) {
        console.warn('[StoreSync] getMyPublishedSpells query failed:', e?.message);
        return { spells: [] };
    }
}

export interface SyncLearnedSpellsOptions {
    triggeredByDeepLink?: boolean;
    forceSpellId?: string;
    recoverAll?: boolean;
}

export interface SyncLearnedSpellsResult {
    imported: number;
    dedupHits: number;
    failed: number;
}

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
    syncLearnedSpells: (opts?: SyncLearnedSpellsOptions) => Promise<SyncLearnedSpellsResult>;
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
                forkOfSpellId: app.source === 'store'
                    ? (app.storeSpellId ?? undefined)
                    : (app.forkOfStoreSpellId ?? undefined),
                locale: Localization.getLocales()[0]?.languageCode ?? undefined,
                existingSpellId: app.storeSpellId ?? undefined,
            });

            // Persist the link so the AppCard menu can show "View in Store" / "Unpublish".
            // The author UID is the current authenticated user — server requires Google auth to publish.
            await updateAppStoreLink(
                opts.appId,
                result.spellId,
                result.slug,
                opts.visibility ?? 'public',
                firebase.getCurrentUserId(),
            );
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

    syncLearnedSpells: async (opts) => {
        const triggeredByDeepLink = opts?.triggeredByDeepLink === true;
        const forceSpellId = opts?.forceSpellId;
        const recoverAll = opts?.recoverAll === true;
        // Bypass the in-flight guard only when a deep link demands a specific spell — the
        // dedup-by-storeSpellId guard inside the loop prevents any duplicate inserts even
        // if a parallel sync completes between calls.
        if (get().isSyncing && !forceSpellId) {
            return { imported: 0, dedupHits: 0, failed: 0 };
        }
        set({ isSyncing: true });
        let imported = 0;
        let dedupHits = 0;
        let failed = 0;
        let lastImportedAppId: number | null = null;
        let dedupHitAppId: number | null = null;
        try {
            const callablePayload: { forceSpellId?: string; recoverAll?: boolean } = {};
            if (forceSpellId) callablePayload.forceSpellId = forceSpellId;
            if (recoverAll) callablePayload.recoverAll = true;
            const { spells: rawSpells } = await firebase.syncLearnedSpells(
                Object.keys(callablePayload).length > 0 ? callablePayload : undefined
            );

            // Filter out tombstoned spells so locally-deleted spells never bounce back via recoverAll.
            const tombstones = new Set(await getDeletedStoreSpellTombstones());
            // forceSpellId always overrides tombstones: an explicit deep link means the user wants
            // this spell back (re-learn after delete), so clear the tombstone if present below.
            const spells = rawSpells.filter(s => {
                if (forceSpellId && s.spellId === forceSpellId) return true;
                return !tombstones.has(s.spellId);
            });

            const now = Date.now();
            for (const spell of spells) {
                // Dedup: skip if already imported
                const existing = await getAppByStoreSpellId(spell.spellId);
                if (existing) {
                    // Already imported — make sure the server-side flag is in sync
                    try {
                        await markSpellSyncedStub(spell.spellId, existing.id, true);
                    } catch (e: any) {
                        console.warn('[StoreSync] markSpellSynced (dedup) failed:', e?.message);
                    }
                    dedupHits++;
                    if (forceSpellId && spell.spellId === forceSpellId) {
                        dedupHitAppId = existing.id;
                        // Deep link explicitly targets this spell — bubble it to the top of the
                        // listing so the "Open in app" CTA lands on a visible row, not buried.
                        try { await touchAppLastUpdated(existing.id); } catch {}
                    } else if (dedupHitAppId == null) {
                        dedupHitAppId = existing.id;
                    }
                    continue;
                }
                // Download HTML from signed URL
                let html: string;
                try {
                    const response = await fetch(spell.signedHtmlUrl);
                    if (!response.ok) {
                        console.warn(`[StoreSync] HTML fetch failed for ${spell.spellId}: ${response.status}`);
                        failed++;
                        continue;
                    }
                    html = await response.text();
                } catch (e: any) {
                    console.warn(`[StoreSync] HTML fetch error for ${spell.spellId}:`, e?.message);
                    failed++;
                    continue;
                }
                // Pick the locale-matched metadata; fall back to EN, then to the raw fields.
                const userLang = Localization.getLocales()[0]?.languageCode ?? 'en';
                const meta = spell.translations?.[userLang]
                    ?? spell.translations?.['en']
                    ?? { name: spell.name, description: spell.description };

                // Download icon to local FS — same pattern as generateAndSaveAppIcon
                // (lib/store.ts:561-591). Defensive: a failed download must not abort
                // the whole import, mirroring the HTML-fetch error handling above.
                let localIconPath: string | null = null;
                if (spell.iconPath) {
                    try {
                        const iconUrl = publicStorageUrl(spell.iconPath);
                        if (iconUrl) {
                            const iconDir = `${FileSystem.documentDirectory}icons/`;
                            const dirInfo = await FileSystem.getInfoAsync(iconDir);
                            if (!dirInfo.exists) {
                                await FileSystem.makeDirectoryAsync(iconDir, { intermediates: true });
                            }
                            const target = `${iconDir}store_icon_${spell.spellId}.png`;
                            const dl = await FileSystem.downloadAsync(iconUrl, target);
                            if (dl.status >= 200 && dl.status < 300) {
                                localIconPath = target;
                            } else {
                                console.warn(`[StoreSync] icon download ${spell.spellId} status ${dl.status}`);
                            }
                        }
                    } catch (e: any) {
                        console.warn(`[StoreSync] icon download error for ${spell.spellId}:`, e?.message);
                    }
                }

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
                        storeAuthorUid: spell.authorUid || null,
                        forkOfStoreSpellId: spell.forkOfSpellId ?? null,
                        iconPath: localIconPath,
                        lastUpdated: now,
                        createdAt: now,
                        consoleLogs: '',
                        totalSpendUsd: 0,
                        requiresBiometric: false,
                        sortOrder: 0,
                    });
                    // Clear any tombstone for this spell now that the user has it locally again.
                    if (tombstones.has(spell.spellId)) {
                        try { await removeDeletedStoreSpellTombstone(spell.spellId); } catch {}
                    }
                    try {
                        await markSpellSyncedStub(spell.spellId, appId, true);
                    } catch (e: any) {
                        console.warn('[StoreSync] markSpellSynced failed:', e?.message);
                    }
                    imported++;
                    lastImportedAppId = appId;
                } catch (e: any) {
                    console.warn(`[StoreSync] insertApp failed for ${spell.spellId}:`, e?.message);
                    failed++;
                }
            }
            // Refresh the listing whenever we imported something OR a deep-link arrived for a
            // spell that already existed locally (dedup hit) — the user expects the listing to
            // surface the spell either way so the "Open in app" button feels responsive.
            if (imported > 0 || (triggeredByDeepLink && (dedupHits > 0 || forceSpellId))) {
                try { useAppStore.getState().loadApps(); } catch {}
            }

            if (triggeredByDeepLink) {
                const store = useAppStore.getState();
                if (imported > 0) {
                    store.setStatusMessage(t('learnSpellSuccess'));
                    if (lastImportedAppId != null) {
                        try { useAppStore.setState({ statusActionAppId: lastImportedAppId }); } catch {}
                    }
                } else if (dedupHits > 0) {
                    store.setStatusMessage(t('learnSpellAlreadyOwned'));
                    if (dedupHitAppId != null) {
                        try { useAppStore.setState({ statusActionAppId: dedupHitAppId }); } catch {}
                    }
                } else if (failed > 0) {
                    try { useAppStore.setState({ error: t('learnSpellFailed') }); } catch {}
                } else {
                    if (forceSpellId) {
                        // Backend returned no spells despite an explicit forceSpellId — almost
                        // always means syncLearnedSpells wasn't deployed with the forceSpellId
                        // branch, OR the learned_spells/{spellId} doc was never created.
                        console.warn(
                            `[StoreSync] forceSpellId="${forceSpellId}" returned no spells from backend. ` +
                            `Check that syncLearnedSpells is deployed with forceSpellId support and that ` +
                            `users/{uid}/learned_spells/${forceSpellId} exists.`
                        );
                    }
                    store.setStatusMessage(t('learnSpellNothingToSync'));
                }
            }
        } catch (e: any) {
            console.error('[StoreSync] syncLearnedSpells error:', e?.message);
            if (triggeredByDeepLink) {
                try { useAppStore.setState({ error: t('learnSpellFailed') }); } catch {}
            }
        } finally {
            set({ isSyncing: false });
        }
        return { imported, dedupHits, failed };
    },

    syncPublishedSpellsStatus: async () => {
        let cleared = 0;
        try {
            const published = await getAppsWithStoreSpellId();
            for (const app of published) {
                if (!app.storeSpellId) continue;
                const status = await firebase.getStoreSpellStatus(app.storeSpellId);
                if (status === 'not_found' || status === 'removed') {
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

        // Restore storeSpellId for spells published on another device / after reinstall
        let restored = 0;
        try {
            const { spells: remoteSpells } = await getMyPublishedSpells();
            if (remoteSpells.length > 0) {
                const allLocalApps = await getAllApps();
                for (const spell of remoteSpells) {
                    const match = allLocalApps.find(a => !a.storeSpellId && a.name === spell.name);
                    if (match) {
                        // getMyPublishedSpells filters to the current user's spells, so the current UID is the author.
                        await updateAppStoreLink(match.id, spell.spellId, spell.slug, spell.visibility, firebase.getCurrentUserId());
                        restored++;
                    }
                }
            }
        } catch (e: any) {
            console.warn('[StoreSync] reconcilePublishedSpells error:', e?.message);
        }
        if (restored > 0) {
            try { useAppStore.getState().loadApps(); } catch {}
        }
    },

    clearError: () => set({ lastError: null }),
}));
