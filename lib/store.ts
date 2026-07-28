import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import { DeviceEventEmitter, Platform, ToastAndroid } from 'react-native';
import { GeneratedApp, NewGeneratedApp, PendingJob } from './database/types';
import * as db from './database/db';
import * as FileSystem from 'expo-file-system/legacy';
import { Paths, File } from 'expo-file-system/next';
import * as bgGen from './backgroundGenerator';
import type { BgGenCompletedEvent, BgGenFailedEvent } from './backgroundGenerator';
import * as openrouter from './api/openrouter';
import type { OpenRouterErrorCode } from './api/openrouter';
import { useBridgeUIStore } from './bridgeUIStore';
import { calcImageUsd } from './api/pricing';
import { getPreferredModel, getAllPreferredModels } from './api/modelPreferences';
import {
    loadPricingSnapshotIntoMemory,
    getModelCatalog,
    findMissingModelTasks,
    type TaskKey,
} from './api/modelCatalog';
import * as backup from './backup';
import { onboardingTemplates } from './onboardingTemplates';
import * as projectConverter from './projectConverter';
import * as firebase from './firebase';
import SharingShortcuts from './bridges/SharingShortcuts';
import { t } from './i18n';
import { getStorageFromCache } from './storageCache';
import { cancelSpellNotifications } from './bridges/messageHandlers';
import { markBackupDirty } from './backupSync';

const DISMISSED_URI_TTL_MS = 15000;

// Module-scoped one-shot latch for the startup missing-models toast. Reset
// only when the process restarts, so a manual picker refresh doesn't spam.
let missingModelTasksToastFired = false;

interface AppState {
    apps: GeneratedApp[];
    isLoading: boolean;
    isGenerating: boolean;
    isImporting: boolean;
    error: string | null;
    statusMessage: string | null;
    statusActionAppId: number | null;
    pendingImportUrl: string | null; // For confirming imports in UI context

    // Window Management (Multitasking)
    runningInstances: { id: number; mode: 'run' | 'edit' }[];
    activeAppId: number | null;

    // Shared Content (for share-to-webapp feature)
    sharedContent: {
        mimeType: string;
        text?: string;
        uri?: string;
        base64?: string;
        fileName?: string;
        shareId?: string; // Unique ID for each share session
    } | null;

    // In-flight create/edit tracking (synchronous BYOK — placeholder UX only).
    creatingApps: { jobId: string; description: string; timestamp: number }[];

    // Signal for RunnerScreen to navigate back after edit completes
    lastCompletedEditAppId: number | null;
    updatingAppIds: number[];

    // Signal for HomeScreen to show post-creation setup modal
    lastCreatedAppId: number | null;

    // Dismissed content URIs to prevent re-prompting
    dismissedUris: Record<string, number>;
    dismissContent: (uri: string) => void;

    // Failed prompt recovery — preserve user's text when a job fails
    lastFailedPrompt: { type: 'create' | 'edit'; text: string; appId?: number } | null;
    clearLastFailedPrompt: () => void;

    // Actionable error from a create/edit AI call (key missing, rate limit,
    // upstream 5xx, generation aborted by app kill, etc). Drives
    // GenerationErrorModal. Separate from `error` (generic 5s toast) so it
    // survives until the user dismisses/retries.
    generationError: {
        jobId: string;
        type: 'create' | 'edit';
        code: OpenRouterErrorCode | 'unknown' | 'aborted';
        message: string;
        promptText: string;
        appId: number | null;
        selectedContext: string | null;
    } | null;
    clearGenerationError: () => void;
    retryGeneration: () => void;

    // Bumped after the user saves/clears the OpenRouter key.
    // Components that depend on key presence subscribe to this to re-read
    // hasOpenRouterKey() without polling.
    aiKeyVersion: number;
    bumpAiKeyVersion: () => void;

    // Tasks whose user-chosen model is no longer in the current OpenRouter
    // catalog. Computed at boot (Cache A load) and after any picker change.
    // Consumed by the Settings entry-point badge and the startup toast.
    missingModelTasks: TaskKey[];
    refreshMissingModelTasks: () => Promise<void>;

    initializeListeners: () => void;

    // Actions
    loadApps: () => Promise<void>;
    openApp: (id: number, mode?: 'run' | 'edit') => void;
    closeApp: (id: number) => void;
    minimizeApp: () => void;
    clearLastCompletedEdit: () => void;
    clearLastCreatedApp: () => void;
    createApp: (description: string) => Promise<boolean>;
    updateAppWithAI: (app: GeneratedApp, instructions: string, selectedContext?: string) => Promise<boolean>;
    deleteApp: (id: number) => Promise<void>;
    renameApp: (id: number, newName: string) => Promise<void>;
    updateAppDescription: (id: number, description: string) => Promise<void>;
    updateAppIcon: (id: number, iconPath: string) => Promise<void>;
    updateAppCode: (id: number, code: string, instruction?: string) => Promise<void>;
    clearAppStorage: (id: number) => Promise<void>;
    incrementAppSpendUsd: (id: number, amount: number) => Promise<void>;
    exportBackup: () => Promise<void>;
    importBackup: (uri?: string, triggerSetup?: boolean) => Promise<void>;
    importOnboardingSpell: (chipIndex: number) => Promise<number | null>;
    importProject: (zipUri: string) => Promise<GeneratedApp | null>;
    clearError: () => void;
    clearStatusMessage: () => void;
    clearStatusActionAppId: () => void;
    setStatusMessage: (message: string) => void;
    setPendingImportUrl: (url: string | null) => void;
    setSharedContent: (content: AppState['sharedContent']) => void;
    clearSharedContent: () => void;
    generateAndSaveAppIcon: (appId: number, prompt: string) => Promise<{ iconPath: string; creditsUsed: number }>;
    reorderApp: (appId: number, direction: 'up' | 'down') => Promise<void>;
    wipeAllData: () => Promise<void>;

    // Reconcile pending_jobs rows left behind by a previous app kill.
    // Called once at boot from app/_layout.tsx after loadApps().
    reconcilePendingJobs: () => Promise<void>;
}

function inferJsonSchema(value: any): object {
    if (value === null) return { type: 'null' };
    if (Array.isArray(value)) {
        if (value.length > 0 && typeof value[0] === 'object' && value[0] !== null) {
            return { type: 'array', items: inferJsonSchema(value[0]) };
        }
        return { type: 'array' };
    }
    if (typeof value === 'object') {
        const properties: Record<string, object> = {};
        for (const key of Object.keys(value)) {
            properties[key] = inferJsonSchema(value[key]);
        }
        return { type: 'object', properties };
    }
    return { type: typeof value };
}

function makeLocalJobId(prefix: string): string {
    return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// BgGenFailedEvent surfaces `code` as a plain string (it may come from
// either the in-process fallback or the native side later). We only trust it
// for the `generationError` union when it matches an OpenRouterErrorCode.
const KNOWN_OPENROUTER_ERROR_CODES: ReadonlySet<string> = new Set<OpenRouterErrorCode>([
    'byok.error.noKey',
    'byok.error.invalidKey',
    'byok.error.outOfCredit',
    'byok.error.rateLimited',
    'byok.error.upstream',
    'byok.error.network',
    'byok.error.aborted',
    'byok.error.parse',
] as const);
function isKnownErrorCode(code: string): boolean {
    return KNOWN_OPENROUTER_ERROR_CODES.has(code);
}

export const useAppStore = create<AppState>((set, get) => ({
    apps: [],
    isLoading: true,
    isGenerating: false,
    isImporting: false,
    error: null,
    statusMessage: null,
    statusActionAppId: null,
    pendingImportUrl: null,
    runningInstances: [],
    activeAppId: null,
    sharedContent: null,
    creatingApps: [],
    updatingAppIds: [],
    lastCompletedEditAppId: null,
    lastCreatedAppId: null,
    dismissedUris: {},
    lastFailedPrompt: null,
    generationError: null,
    aiKeyVersion: 0,
    missingModelTasks: [],

    clearLastFailedPrompt: () => set({ lastFailedPrompt: null }),
    clearGenerationError: () => set({ generationError: null }),
    retryGeneration: () => {
        const err = get().generationError;
        if (!err) return;
        set({ generationError: null });
        if (err.type === 'create') {
            void get().createApp(err.promptText);
            return;
        }
        const app = err.appId != null
            ? get().apps.find(a => a.id === err.appId)
            : undefined;
        if (!app) return;
        void get().updateAppWithAI(app, err.promptText, err.selectedContext ?? undefined);
    },
    bumpAiKeyVersion: () => set(state => ({ aiKeyVersion: state.aiKeyVersion + 1 })),

    refreshMissingModelTasks: async () => {
        try {
            const [catalog, chosen] = await Promise.all([
                getModelCatalog(),
                getAllPreferredModels(),
            ]);
            const missing = findMissingModelTasks(catalog, chosen);
            set({ missingModelTasks: missing });
            // One-shot startup toast (Android) so the user sees the situation
            // even if they haven't opened Settings yet. The Layer-2 badge in
            // Settings still stays until they resolve each task. This fires
            // once per process launch, not once per refresh — a manual
            // refresh from the picker must not re-toast the user.
            if (
                Platform.OS === 'android' &&
                missing.length > 0 &&
                !missingModelTasksToastFired
            ) {
                missingModelTasksToastFired = true;
                ToastAndroid.show(
                    t('openrouterModelUnavailableToast', { count: missing.length }),
                    ToastAndroid.LONG,
                );
            }
        } catch (e) {
            // Network failure at boot must not crash the store. Old missing
            // list is retained — a later manual refresh from the picker will
            // reconcile.
            console.warn('[Store] refreshMissingModelTasks failed:', e);
        }
    },

    dismissContent: (uri: string) => {
        const now = Date.now();
        set(state => {
            if (state.dismissedUris[uri] && now - state.dismissedUris[uri] < DISMISSED_URI_TTL_MS) {
                return state;
            }

            // Persist to DB
            db.addDismissedUri(uri).catch(e => console.error('[Store] Failed to persist dismissed URI:', e));

            return { dismissedUris: { ...state.dismissedUris, [uri]: now } };
        });
    },

    // No-op kept as a public stub during the Phase-4 cutover so existing
    // root-layout callers (`useAppStore.getState().initializeListeners()`)
    // don't need to be touched.
    initializeListeners: () => {},

    loadApps: async () => {
        try {
            // Só mostra loading na primeira carga (apps vazio); refreshes de fundo são silenciosos
            if (get().apps.length === 0) {
                set({ isLoading: true, error: null });
            } else {
                set({ error: null });
            }
            await db.clearOldDismissedUris(DISMISSED_URI_TTL_MS);
            const [apps, dismissedUris] = await Promise.all([
                db.getAllApps(),
                db.getDismissedUris(),
                // Populates the hot in-memory pricing map from the persistent
                // Cache B snapshot before any AI call fires. Idempotent.
                loadPricingSnapshotIntoMemory(),
            ]);
            set({ apps, dismissedUris, isLoading: false });

            // Fire-and-forget: reconcile picker state against Cache A. Uses
            // whatever the cache has (fresh or stale) and dispatches a refresh
            // in the background if stale — never blocks boot.
            void get().refreshMissingModelTasks();

            // Publish Direct Share shortcuts for all apps
            apps.forEach(async (app) => {
                SharingShortcuts.publishShortcut(app.id.toString(), app.name, app.iconPath);

                // Ensure notification channel exists (Android)
                if (Notifications.setNotificationChannelAsync) {
                    await Notifications.setNotificationChannelAsync(`spell-${app.id}`, {
                        name: app.name,
                        importance: Notifications.AndroidImportance.HIGH,
                        vibrationPattern: [0, 250, 250, 250],
                        lightColor: '#FF9500',
                    });
                }
            });
        } catch (error) {
            console.error('Failed to load apps:', error);
            set({ error: t('errorLoadingApps'), isLoading: false });
        }
    },

    openApp: (id: number, mode: 'run' | 'edit' = 'edit') => {
        set(state => {
            const existing = state.runningInstances.find(i => i.id === id);

            // If already running, update mode if needed and activate
            if (existing) {
                return {
                    runningInstances: state.runningInstances.map(i =>
                        i.id === id ? { ...i, mode } : i
                    ),
                    activeAppId: id
                };
            }

            // If not running, add new instance
            return {
                runningInstances: [...state.runningInstances, { id, mode }],
                activeAppId: id
            };
        });
    },

    closeApp: (id: number) => {
        set(state => ({
            runningInstances: state.runningInstances.filter(i => i.id !== id),
            activeAppId: state.activeAppId === id ? null : state.activeAppId
        }));
    },

    minimizeApp: () => {
        set({ activeAppId: null });
    },

    clearLastCompletedEdit: () => {
        set({ lastCompletedEditAppId: null });
    },

    clearLastCreatedApp: () => {
        set({ lastCreatedAppId: null });
    },

    createApp: async (description: string) => {
        const jobId = makeLocalJobId('create');
        const startedAt = Date.now();

        // Persist the in-flight job *before* spawning the async work so we can
        // reconcile (and recover the prompt) if the app is killed mid-call.
        try {
            await db.upsertPendingJob({
                jobId,
                type: 'create',
                appId: null,
                promptText: description,
                selectedContext: null,
                status: 'processing',
                startedAt,
                updatedAt: startedAt,
                lastErrorCode: null,
                lastErrorMessage: null,
            });
            // The draft for create lives under appId=NULL; once we promote it
            // to a processing job, the draft row is no longer needed.
            await db.deleteDraftFor('create');
        } catch (e) {
            console.warn('[Store] Failed to persist pending create job:', e);
        }

        set(state => ({
            error: null,
            generationError: null,
            creatingApps: [...state.creatingApps, { jobId, description, timestamp: startedAt }],
            statusMessage: t('jobStarted'),
        }));

        const completedSub = bgGen.onCompleted(async (e: BgGenCompletedEvent) => {
            if (e.jobId !== jobId) return;
            completedSub.remove();
            failedSub.remove();
            // NOTE: DB insert, version write, shortcut publish, notification
            // post, and pending_jobs cleanup all happen inside the headless
            // task (see `finalizeCreateInline` in backgroundGeneratorTask.ts).
            // This subscriber only refreshes UI state — if it never runs
            // (app killed before this async callback lands), the spell is
            // still saved and the success notification still fires.
            try {
                const appName = (e.appName && e.appName.trim()) || description.slice(0, 40);
                await get().loadApps();
                set({
                    statusMessage: t('appReadyNotify', { name: appName }),
                    statusActionAppId: e.appId,
                    lastCreatedAppId: e.appId,
                });
                markBackupDirty();
            } catch (error) {
                console.error('Failed to refresh UI after spell create:', error);
            } finally {
                set(state => ({
                    creatingApps: state.creatingApps.filter(a => a.jobId !== jobId),
                }));
            }
        });

        const failedSub = bgGen.onFailed(async (e: BgGenFailedEvent) => {
            if (e.jobId !== jobId) return;
            completedSub.remove();
            failedSub.remove();
            // FGS teardown happens in `runJobWithReporting`'s finally block
            // (`finishFgsInline`). A second `finishJob` here was racing the
            // subscriber's async work — remove it to avoid interrupting the
            // failure-notification chain.
            const code: OpenRouterErrorCode | 'unknown' = isKnownErrorCode(e.code)
                ? (e.code as OpenRouterErrorCode)
                : 'unknown';
            if (code === 'byok.error.modelUnavailable' && e.modelId) {
                useBridgeUIStore.getState().requestModelUnavailable(null, 'SPELL_S', e.modelId);
            }
            await db.upsertPendingJob({
                jobId,
                type: 'create',
                appId: null,
                promptText: description,
                selectedContext: null,
                status: 'failed',
                startedAt,
                updatedAt: Date.now(),
                lastErrorCode: code,
                lastErrorMessage: e.message,
            }).catch(() => {});
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: t('spellFailedTitle'),
                    body: t('errorProcessingJob'),
                    data: { jobId, kind: 'create-failure', errorMessage: e.message },
                },
                trigger: null,
            }).catch(() => {});
            set({
                generationError: {
                    jobId,
                    type: 'create',
                    code,
                    message: e.message,
                    promptText: description,
                    appId: null,
                    selectedContext: null,
                },
                lastFailedPrompt: { type: 'create', text: description },
            });
            set(state => ({
                creatingApps: state.creatingApps.filter(a => a.jobId !== jobId),
            }));
        });

        try {
            await bgGen.startCreate({
                jobId,
                prompt: description,
                notificationTitle: t('generatingApp'),
            });
        } catch (error) {
            completedSub.remove();
            failedSub.remove();
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to schedule background create:', error);
            await db.upsertPendingJob({
                jobId,
                type: 'create',
                appId: null,
                promptText: description,
                selectedContext: null,
                status: 'failed',
                startedAt,
                updatedAt: Date.now(),
                lastErrorCode: 'unknown',
                lastErrorMessage: message,
            }).catch(() => {});
            set(state => ({
                creatingApps: state.creatingApps.filter(a => a.jobId !== jobId),
                generationError: {
                    jobId,
                    type: 'create',
                    code: 'unknown',
                    message,
                    promptText: description,
                    appId: null,
                    selectedContext: null,
                },
            }));
        }

        return true;
    },

    updateAppWithAI: async (app: GeneratedApp, instructions: string, selectedContext?: string) => {
        const jobId = makeLocalJobId('edit');
        const startedAt = Date.now();

        try {
            await db.upsertPendingJob({
                jobId,
                type: 'edit',
                appId: app.id,
                promptText: instructions,
                selectedContext: selectedContext ?? null,
                status: 'processing',
                startedAt,
                updatedAt: startedAt,
                lastErrorCode: null,
                lastErrorMessage: null,
            });
            await db.deleteDraftFor('edit', app.id);
        } catch (e) {
            console.warn('[Store] Failed to persist pending edit job:', e);
        }

        set(state => ({
            error: null,
            generationError: null,
            updatingAppIds: [...state.updatingAppIds, app.id],
            statusMessage: t('editJobStarted'),
        }));

        const versions = await db.getVersionsForApp(app.id);
        const previousEdits = versions
            .filter(v => v.instruction)
            .slice(0, 10)
            .map(v => ({ version: v.version, instruction: v.instruction as string }));

        // storageStructure currently has no consumer client-side — the new BYOK
        // editAppWithContext threads previousEdits and selectedContext only. We
        // still compute it so future planners can consume it without another
        // schema change.
        const storageItems = getStorageFromCache(app.id);
        void storageItems.map(item => {
            try {
                const parsed = JSON.parse(item.value);
                return { key: item.key, schema: inferJsonSchema(parsed) };
            } catch {
                return { key: item.key, schema: { type: 'string' } };
            }
        });

        const completedSub = bgGen.onCompleted(async (e: BgGenCompletedEvent) => {
            if (e.jobId !== jobId) return;
            completedSub.remove();
            failedSub.remove();
            // NOTE: DB updateAppContent, version write, notification post,
            // and pending_jobs cleanup happen inside the headless task
            // (`finalizeEditInline` in backgroundGeneratorTask.ts). Store
            // subscriber only refreshes UI state.
            try {
                set({ statusMessage: t('appUpdatedNotify', { name: app.name }), statusActionAppId: app.id });
                await get().loadApps();
                markBackupDirty();

                set({ lastCompletedEditAppId: app.id });
                setTimeout(() => {
                    if (get().lastCompletedEditAppId === app.id) get().clearLastCompletedEdit();
                }, 5000);

                DeviceEventEmitter.emit('APP_UPDATED', { appId: app.id });
            } catch (error) {
                console.error('Failed to refresh UI after spell edit:', error);
            } finally {
                set(state => ({
                    updatingAppIds: state.updatingAppIds.filter(id => id !== app.id),
                }));
            }
        });

        const failedSub = bgGen.onFailed(async (e: BgGenFailedEvent) => {
            if (e.jobId !== jobId) return;
            completedSub.remove();
            failedSub.remove();
            // FGS teardown handled by `runJobWithReporting`'s finally block.
            const code: OpenRouterErrorCode | 'unknown' = isKnownErrorCode(e.code)
                ? (e.code as OpenRouterErrorCode)
                : 'unknown';
            if (code === 'byok.error.modelUnavailable' && e.modelId) {
                useBridgeUIStore.getState().requestModelUnavailable(app.id, 'SPELL_S', e.modelId);
            }
            await db.upsertPendingJob({
                jobId,
                type: 'edit',
                appId: app.id,
                promptText: instructions,
                selectedContext: selectedContext ?? null,
                status: 'failed',
                startedAt,
                updatedAt: Date.now(),
                lastErrorCode: code,
                lastErrorMessage: e.message,
            }).catch(() => {});
            await Notifications.scheduleNotificationAsync({
                content: {
                    title: t('spellEditFailedTitle'),
                    body: t('errorProcessingJob'),
                    data: { appId: app.id, jobId, kind: 'edit-failure', errorMessage: e.message },
                },
                trigger: null,
            }).catch(() => {});
            set({
                generationError: {
                    jobId,
                    type: 'edit',
                    code,
                    message: e.message,
                    promptText: instructions,
                    appId: app.id,
                    selectedContext: selectedContext ?? null,
                },
                lastFailedPrompt: { type: 'edit', text: instructions, appId: app.id },
            });
            set(state => ({
                updatingAppIds: state.updatingAppIds.filter(id => id !== app.id),
            }));
        });

        try {
            await bgGen.startEdit({
                jobId,
                appId: app.id,
                currentCode: app.code,
                instruction: instructions,
                selectedContext,
                previousEdits,
                notificationTitle: t('updatingApp'),
            });
        } catch (error) {
            completedSub.remove();
            failedSub.remove();
            const message = error instanceof Error ? error.message : String(error);
            console.error('Failed to schedule background edit:', error);
            await db.upsertPendingJob({
                jobId,
                type: 'edit',
                appId: app.id,
                promptText: instructions,
                selectedContext: selectedContext ?? null,
                status: 'failed',
                startedAt,
                updatedAt: Date.now(),
                lastErrorCode: 'unknown',
                lastErrorMessage: message,
            }).catch(() => {});
            set(state => ({
                updatingAppIds: state.updatingAppIds.filter(id => id !== app.id),
                generationError: {
                    jobId,
                    type: 'edit',
                    code: 'unknown',
                    message,
                    promptText: instructions,
                    appId: app.id,
                    selectedContext: selectedContext ?? null,
                },
            }));
        }

        return true;
    },

    deleteApp: async (id: number) => {
        try {
            const appToDelete = get().apps.find(a => a.id === id);
            // Capture store linkage before SQLite delete so we can tombstone + unlearn after.
            const storeSpellIdToUnlearn = (appToDelete && appToDelete.source === 'store' && appToDelete.storeSpellId)
                ? appToDelete.storeSpellId
                : null;

            // Cancel all scheduled notifications before removing the channel
            try {
                await cancelSpellNotifications(id);
            } catch (e) {
                console.warn('[Store] Failed to cancel notifications:', e);
            }

            // Remove the notification channel for this spell (Android)
            await Notifications.deleteNotificationChannelAsync(`spell-${id}`);

            try {
                const mediaPaths = await db.getWebviewAiMediaPaths(id);
                for (const p of mediaPaths) {
                    await FileSystem.deleteAsync(p, { idempotent: true }).catch(() => {});
                }
                const dir = `${Paths.document}/appacadabra_media/${id}`;
                await FileSystem.deleteAsync(dir, { idempotent: true }).catch(() => {});
            } catch (e) {
                console.warn('[Store] Failed to cleanup AI media files:', e);
            }

            // Build deletion snapshot before CASCADE wipes versions & storage
            let snapshotJson: string | undefined;
            if (appToDelete) {
                try {
                    const versions = (await db.getVersionsForApp(id)).slice(0, 5);
                    const storageItems = await db.getStorageForApp(id);
                    const localStorage: Record<string, string> = {};
                    storageItems.forEach(s => { localStorage[s.key] = s.value; });

                    let iconBase64: string | undefined;
                    if (appToDelete.iconPath) {
                        try {
                            const iconFile = new File(appToDelete.iconPath);
                            if (iconFile.exists) iconBase64 = await iconFile.base64();
                        } catch (e) {
                            console.warn('[Store] Failed to read icon for snapshot:', e);
                        }
                    }

                    const snapshot: backup.BackupApp = {
                        ...appToDelete,
                        iconBase64,
                        versions: versions.map(v => ({
                            version: v.version,
                            code: v.code,
                            instruction: v.instruction || '',
                            selectedContext: v.selectedContext || '',
                            createdAt: v.createdAt,
                        })),
                        localStorage,
                    };
                    snapshotJson = JSON.stringify(snapshot);
                } catch (e) {
                    console.warn('[Store] Failed to build deletion snapshot:', e);
                }
            }

            await db.deleteApp(id);
            set(state => ({
                apps: state.apps.filter(a => a.id !== id),
            }));

            // Record tombstone so backup sync knows this app was intentionally deleted
            if (appToDelete) {
                await db.addDeletedAppName(appToDelete.name, Date.now(), snapshotJson);
                markBackupDirty();
            }

            // For store-sourced spells: block bulk recovery from re-importing this spell,
            // and best-effort tell the server to forget the learned link so the store UI
            // re-shows "Learn" instead of "Already learned".
            if (storeSpellIdToUnlearn) {
                try {
                    await db.insertDeletedStoreSpellTombstone(storeSpellIdToUnlearn);
                } catch (e) {
                    console.warn('[Store] Failed to insert store-spell tombstone:', e);
                }
                // Fire-and-forget: tombstone is the local source of truth, so offline is fine.
                firebase.unlearnSpell(storeSpellIdToUnlearn).catch(() => {});
            }

            // Remove from Direct Share shortcuts
            SharingShortcuts.removeShortcut(id.toString());
        } catch (error) {
            console.error('Failed to delete app:', error);
            set({ error: t('errorDeletingApp') });
        }
    },

    renameApp: async (id: number, newName: string) => {
        try {
            const app = get().apps.find(a => a.id === id);
            if (!app) return;

            const updatedApp = { ...app, name: newName };
            await db.updateApp(updatedApp);

            set(state => ({
                apps: state.apps.map(a => a.id === id ? updatedApp : a),
            }));
            markBackupDirty();
        } catch (error) {
            console.error('Failed to rename app:', error);
            set({ error: t('errorRenamingApp') });
        }
    },

    updateAppDescription: async (id: number, description: string) => {
        try {
            const app = get().apps.find(a => a.id === id);
            if (!app) return;

            const updatedApp = { ...app, shortDescription: description };
            await db.updateApp(updatedApp);

            set(state => ({
                apps: state.apps.map(a => a.id === id ? updatedApp : a),
            }));
            markBackupDirty();
        } catch (error) {
            console.error('Failed to update app description:', error);
            set({ error: t('errorUpdatingApp') });
        }
    },

    updateAppIcon: async (id: number, iconPath: string) => {
        try {
            const app = get().apps.find(a => a.id === id);
            if (!app) return;

            const updatedApp = { ...app, iconPath, lastUpdated: Date.now() };
            await db.updateApp(updatedApp);

            set(state => ({
                apps: state.apps.map(a => a.id === id ? updatedApp : a),
            }));
            markBackupDirty();
        } catch (error) {
            console.error('Failed to update app icon:', error);
            set({ error: t('errorUpdatingIcon') });
        }
    },

    incrementAppSpendUsd: async (id: number, amount: number) => {
        await db.incrementSpendUsd(id, amount);
    },

    generateAndSaveAppIcon: async (appId: number, prompt: string): Promise<{ iconPath: string; creditsUsed: number }> => {
        const imageModel = await getPreferredModel('IMAGE');
        const { images, usage } = await openrouter.generateImage({
            model: imageModel,
            prompt,
        });
        const first = images[0] ?? '';
        if (!first) {
            return { iconPath: '', creditsUsed: 0 };
        }

        const iconDir = `${FileSystem.documentDirectory}icons/`;
        const dirInfo = await FileSystem.getInfoAsync(iconDir);
        if (!dirInfo.exists) {
            await FileSystem.makeDirectoryAsync(iconDir, { intermediates: true });
        }
        const iconPath = `${iconDir}ai_icon_${appId}_${Date.now()}.png`;

        if (first.startsWith('http')) {
            await FileSystem.downloadAsync(first, iconPath);
        } else {
            const base64 = first.startsWith('data:')
                ? (first.split(',')[1] ?? '')
                : first;
            await FileSystem.writeAsStringAsync(iconPath, base64, {
                encoding: FileSystem.EncodingType.Base64,
            });
        }

        await get().updateAppIcon(appId, iconPath);

        // Same guard as WebView image path in lib/api/ai.ts: prefer OpenRouter's
        // reported cost, fall back to local pricing when absent so the spell's
        // accumulated spend stays honest.
        const reportedCost = (usage as any)?.cost;
        const costUsd =
            typeof reportedCost === 'number' && reportedCost > 0
                ? reportedCost
                : calcImageUsd(0);
        await db.incrementSpendUsd(appId, costUsd);
        set(state => ({
            apps: state.apps.map(a =>
                a.id === appId
                    ? { ...a, totalSpendUsd: (a.totalSpendUsd ?? 0) + costUsd }
                    : a,
            ),
        }));

        return { iconPath, creditsUsed: 0 };
    },

    updateAppCode: async (id: number, code: string, instruction?: string) => {
        try {
            const app = get().apps.find(a => a.id === id);
            if (!app) return;

            const newVersion = app.currentVersion + 1;
            const updatedApp = {
                ...app,
                code,
                currentVersion: newVersion,
                lastUpdated: Date.now()
            };

            await db.updateApp(updatedApp);
            await db.insertVersion({
                appId: id,
                version: newVersion,
                code,
                instruction: instruction || t('manualEdit'),
                selectedContext: null,
                createdAt: Date.now(),
            });

            set(state => ({
                apps: state.apps.map(a => a.id === id ? updatedApp : a),
                isGenerating: false,
            }));
            markBackupDirty();

            // Notify Listeners (RunnerApp)
            DeviceEventEmitter.emit('APP_UPDATED', { appId: id });
        } catch (error) {
            console.error('Failed to update app code:', error);
            set({ error: t('errorUpdatingCode') });
        }
    },

    clearAppStorage: async (id: number) => {
        try {
            await db.clearStorageForApp(id);
            markBackupDirty();
            set({ statusMessage: t('clearDataSuccess') });
        } catch (error) {
            console.error('Failed to clear app storage:', error);
            set({ error: t('errorClearingStorage') });
        }
    },

    exportBackup: async () => {
        try {
            set({ statusMessage: t('exporting') });
            const success = await backup.exportBackup();
            if (success) {
                set({ statusMessage: t('backupExportedSuccess') });
            } else {
                set({ statusMessage: t('errorExportingBackup') });
            }
        } catch (error) {
            console.error('Failed to export backup:', error);
            set({ statusMessage: t('errorExportingBackup') });
        }
    },

    importBackup: async (uri?: string, triggerSetup?: boolean) => {
        try {
            if (get().isImporting) {
                console.log('Store: Import already in progress, skipping.');
                return;
            }
            set({ isImporting: true, statusMessage: t('importing') });
            const result = await backup.importBackup(uri);
            set({ statusMessage: result.message, isImporting: false });

            if (result.success) {
                // Reload apps after import
                const apps = await db.getAllApps();
                set({ apps });

                // Trigger setup modal for the first imported app if it exists and requested
                if (triggerSetup && result.importedIds && result.importedIds.length > 0) {
                    set({ lastCreatedAppId: result.importedIds[0] });
                }
            }
        } catch (error) {
            console.error('Failed to import backup:', error);
            set({ statusMessage: t('errorImportingBackup'), isImporting: false });
        }
    },

    importOnboardingSpell: async (chipIndex: number) => {
        try {
            const templateFactory = onboardingTemplates[chipIndex];
            if (!templateFactory) return null;

            const template = templateFactory(t);

            const newApp: NewGeneratedApp = {
                name: template.name,
                code: template.code,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: Date.now(),
                createdAt: Date.now(),
                consoleLogs: '',
                totalSpendUsd: 0,
                requiresBiometric: false,
                shortDescription: template.shortDescription,
                sortOrder: 0,
            };

            const newId = await db.insertApp(newApp);
            await db.insertVersion({
                appId: newId,
                version: 1,
                code: template.code,
                instruction: template.shortDescription || template.name,
                selectedContext: '',
                createdAt: Date.now(),
            });

            // Refresh the app list
            const apps = await db.getAllApps();
            set({ apps });
            markBackupDirty();
            return newId;
        } catch (error) {
            console.error('Failed to import onboarding spell:', error);
            return null;
        }
    },

    importProject: async (zipUri: string) => {
        try {
            set({ isImporting: true, error: null });

            const result = await projectConverter.convertProject(zipUri);

            if (!result.success || !result.html) {
                set({
                    error: result.error || t('errorConvertingProject'),
                    isImporting: false
                });
                return null;
            }

            const newApp: NewGeneratedApp = {
                name: result.name || t('projectImported'),
                code: result.html,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: Date.now(),
                createdAt: Date.now(),
                consoleLogs: '',
                totalSpendUsd: 0,
                requiresBiometric: false,
                sortOrder: 0,
            };

            const id = await db.insertApp(newApp);

            await db.insertVersion({
                appId: id,
                version: 1,
                code: result.html,
                instruction: t('importedFromZip'),
                selectedContext: null,
                createdAt: Date.now(),
            });

            const createdApp: GeneratedApp = { ...newApp, id };
            set(state => ({
                apps: [createdApp, ...state.apps],
                isImporting: false,
                statusMessage: t('projectImportedSuccess', { name: result.name })
            }));

            SharingShortcuts.publishShortcut(id.toString(), createdApp.name, createdApp.iconPath);
            markBackupDirty();

            return createdApp;
        } catch (error) {
            console.error('Failed to import project:', error);
            const errorMsg = error instanceof Error ? error.message : t('unknownError');
            set({
                error: `${t('importError')} ${errorMsg}`,
                isImporting: false
            });
            return null;
        }
    },

    clearError: () => set({ error: null }),
    clearStatusMessage: () => set({ statusMessage: null, statusActionAppId: null }),
    clearStatusActionAppId: () => set({ statusActionAppId: null }),
    setStatusMessage: (message: string) => set({ statusMessage: message }),
    setPendingImportUrl: (url: string | null) => {
        const current = get().pendingImportUrl;
        if (url === current) return; // Dedupe
        // Also check if we just processed this URL to prevent loops if OS re-sends
        // But we don't have 'lastImportedUrl' in store.
        // Let's just dedupe the pending state.
        set({ pendingImportUrl: url });
    },
    setSharedContent: (content: AppState['sharedContent']) => set({ sharedContent: content }),
    clearSharedContent: () => set({ sharedContent: null }),

    reorderApp: async (appId: number, direction: 'up' | 'down') => {
        const apps = get().apps.filter(a => a.id > 0); // Exclude placeholders
        if (apps.length < 2) return;

        // If no custom order yet (all sortOrder=0), assign sequential order
        const allZero = apps.some(a => (a.sortOrder ?? 0) === 0);
        if (allZero) {
            const updates = apps.map((a, i) => ({ id: a.id, sortOrder: i + 1 }));
            try {
                await db.updateSortOrders(updates);
                // Refresh apps with new sort orders
                const refreshed = await db.getAllApps();
                set({ apps: refreshed });
                // Re-run with updated data
                return get().reorderApp(appId, direction);
            } catch (error) {
                console.error('Failed to initialize sort orders:', error);
                return;
            }
        }

        const idx = apps.findIndex(a => a.id === appId);
        if (idx === -1) return;

        const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
        if (targetIdx < 0 || targetIdx >= apps.length) return;

        const current = apps[idx];
        const neighbor = apps[targetIdx];

        // Swap sortOrders
        const updates = [
            { id: current.id, sortOrder: neighbor.sortOrder },
            { id: neighbor.id, sortOrder: current.sortOrder },
        ];

        try {
            await db.updateSortOrders(updates);
            markBackupDirty();
            await get().loadApps(); // Reload from DB — single source of truth
        } catch (error) {
            console.error('Failed to reorder app:', error);
        }
    },

    wipeAllData: async () => {
        try {
            set({ isLoading: true });
            await db.wipeAllData();
            set({ apps: [], isLoading: false });
        } catch (error) {
            console.error('Failed to wipe all data:', error);
            set({ error: t('errorDeletingApp'), isLoading: false });
        }
    },

    reconcilePendingJobs: async () => {
        // Any pending_jobs row still marked 'processing' means either the
        // previous process was killed mid-generation, the native foreground
        // service is still working on it (Android), or the OS background
        // window has closed and the JS driver was suspended mid-flight (iOS).
        //
        // Age heuristic differs by platform:
        //   Android: 15-min floor — the internal pipeline timeout is 8 min
        //     and the FGS can genuinely run that long.
        //   iOS:     30-sec floor — beginBackgroundTask gives ~30s max; if
        //     a row has been 'processing' longer than that AND is not being
        //     driven by this process, the JS driver was interrupted and we
        //     should try to resume from the last persisted stage.
        try {
            // First: any failed row the background task persisted while the
            // main JS context was down. Model-unavailable is the only code
            // that triggers a modal on reconnect — for it, `lastErrorMessage`
            // was overwritten with the offending modelId by `persistFailure`.
            const orphanUnavailable = await db.listFailedJobsWithCode(
                'byok.error.modelUnavailable',
            );
            for (const j of orphanUnavailable) {
                const modelId = j.lastErrorMessage;
                if (!modelId) continue;
                useBridgeUIStore.getState().requestModelUnavailable(
                    j.appId,
                    'SPELL_S',
                    modelId,
                );
                // Consume the signal so it does not re-fire on the next boot.
                await db.deletePendingJob(j.jobId).catch(() => {});
                break;
            }

            const processing = await db.listProcessingJobs();
            if (processing.length === 0) return;

            const STALE_MS = Platform.OS === 'ios' ? 30 * 1000 : 15 * 60 * 1000;
            const now = Date.now();
            const staleCandidates = processing.filter((j: PendingJob) => {
                // Never touch a row this process is actively driving.
                if (bgGen.isJobActiveInProcess(j.jobId)) return false;
                // Age gate: rows younger than the platform floor are still
                // plausibly in-flight (Android FGS) or just-started (iOS).
                return now - Math.max(j.startedAt, j.updatedAt) > STALE_MS;
            });
            if (staleCandidates.length === 0) return;

            // Filter out jobs the native executor still owns — those get to
            // finish on their own and re-emit BGGen* events when they do.
            // For jobs the native side has forgotten but the DB still shows
            // as processing, try to resume via the native module before
            // falling back to marking them failed. On Android this restarts
            // the FGS in `resume` mode; on iOS it re-opens a background
            // window and drives the persisted state machine in-process.
            const stale: PendingJob[] = [];
            for (const j of staleCandidates) {
                try {
                    const s = await bgGen.status(j.jobId);
                    if (s.state === 'running') continue;
                } catch {
                    // Treat status errors as "not running" — the row is stale.
                }
                const resumed = await bgGen.resume(j.jobId, t('generatingApp')).catch(() => false);
                if (resumed) continue;
                stale.push(j);
            }
            if (stale.length === 0) return;

            // Surface the most recent stale job to the user; older ones just
            // get marked failed silently (their prompt stays in pending_jobs
            // for later inspection if we ever build a history UI).
            const newest = stale.reduce((a: PendingJob, b: PendingJob) =>
                a.startedAt >= b.startedAt ? a : b,
            );

            for (const j of stale) {
                await db.upsertPendingJob({
                    ...j,
                    status: 'failed',
                    updatedAt: now,
                    lastErrorCode: 'byok.error.aborted',
                    lastErrorMessage: 'App was closed during generation',
                }).catch(() => {});
            }

            if (newest.type === 'create' || newest.type === 'edit') {
                set({
                    generationError: {
                        jobId: newest.jobId,
                        type: newest.type,
                        code: 'aborted',
                        message: 'App was closed during generation',
                        promptText: newest.promptText,
                        appId: newest.appId,
                        selectedContext: newest.selectedContext ?? null,
                    },
                    lastFailedPrompt: {
                        type: newest.type,
                        text: newest.promptText,
                        appId: newest.appId ?? undefined,
                    },
                });
            }
        } catch (e) {
            console.warn('[Store] reconcilePendingJobs failed:', e);
        }
    },
}));
