import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import { DeviceEventEmitter } from 'react-native';
import { GeneratedApp, NewGeneratedApp } from './database/types';
import * as db from './database/db';
import * as FileSystem from 'expo-file-system/legacy';
import { Paths, File } from 'expo-file-system/next';
import * as ai from './api/ai';
import * as openrouter from './api/openrouter';
import { MODELS } from './api/pricing';
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

    // Bumped after the user saves/clears the OpenRouter key.
    // Components that depend on key presence subscribe to this to re-read
    // hasOpenRouterKey() without polling.
    aiKeyVersion: number;
    bumpAiKeyVersion: () => void;

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
    aiKeyVersion: 0,

    clearLastFailedPrompt: () => set({ lastFailedPrompt: null }),
    bumpAiKeyVersion: () => set(state => ({ aiKeyVersion: state.aiKeyVersion + 1 })),

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
                db.getDismissedUris()
            ]);
            set({ apps, dismissedUris, isLoading: false });

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
        set(state => ({
            error: null,
            creatingApps: [...state.creatingApps, { jobId, description, timestamp: Date.now() }],
            statusMessage: t('jobStarted'),
        }));

        try {
            const result = await ai.generateApp(description);

            const appName = (result.appName && result.appName.trim()) || description.slice(0, 40);
            const now = Date.now();
            const newApp: NewGeneratedApp = {
                name: appName,
                code: result.text,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: now,
                createdAt: now,
                consoleLogs: '',
                totalSpendUsd: 0,
                jobId,
                requiresBiometric: false,
                shortDescription: description,
                sortOrder: 0,
            };

            const id = await db.insertApp(newApp);

            await Notifications.setNotificationChannelAsync(`spell-${id}`, {
                name: appName,
                importance: Notifications.AndroidImportance.HIGH,
                vibrationPattern: [0, 250, 250, 250],
                lightColor: '#FF9500',
            });

            const app = await db.getAppById(id);
            if (app) {
                SharingShortcuts.publishShortcut(id.toString(), app.name, app.iconPath);
                await db.insertVersion({
                    appId: id,
                    version: 1,
                    code: result.text,
                    instruction: description || t('initialGeneration'),
                    selectedContext: null,
                    createdAt: Date.now(),
                    jobId,
                });

                await get().loadApps();
                set({
                    statusMessage: t('appReadyNotify', { name: appName }),
                    statusActionAppId: id,
                    lastCreatedAppId: id,
                });
                markBackupDirty();
            }

            return true;
        } catch (error) {
            console.error('Failed to create spell:', error);
            set({
                error: t('spellFailedCreate'),
                lastFailedPrompt: { type: 'create', text: description },
            });
            return false;
        } finally {
            set(state => ({
                creatingApps: state.creatingApps.filter(a => a.jobId !== jobId),
            }));
        }
    },

    updateAppWithAI: async (app: GeneratedApp, instructions: string, selectedContext?: string) => {
        set(state => ({
            error: null,
            updatingAppIds: [...state.updatingAppIds, app.id],
            statusMessage: t('editJobStarted'),
        }));

        try {
            const versions = await db.getVersionsForApp(app.id);
            const previousEdits = versions
                .filter(v => v.instruction)
                .slice(0, 10)
                .map(v => ({ version: v.version, instruction: v.instruction }));

            const storageItems = getStorageFromCache(app.id);
            const storageStructure = storageItems.map(item => {
                try {
                    const parsed = JSON.parse(item.value);
                    return { key: item.key, schema: inferJsonSchema(parsed) };
                } catch {
                    return { key: item.key, schema: { type: 'string' } };
                }
            });

            // storageStructure currently has no consumer client-side — the new BYOK
            // editAppWithContext threads previousEdits and selectedContext only.
            void storageStructure;

            const result = await ai.editAppWithContext(
                app.code,
                instructions,
                selectedContext ?? '',
                previousEdits,
            );

            const newVersion = app.currentVersion + 1;
            const jobId = makeLocalJobId('edit');
            const newTotalSpendUsd = (app.totalSpendUsd ?? 0) + (result.costUsd ?? 0);
            await db.updateAppContent(app.id, result.text, newVersion, newTotalSpendUsd, jobId);
            await db.insertVersion({
                appId: app.id,
                version: newVersion,
                code: result.text,
                instruction: instructions || t('aiEdit'),
                selectedContext: selectedContext ?? null,
                createdAt: Date.now(),
                jobId,
            });

            set({ statusMessage: t('appUpdatedNotify', { name: app.name }), statusActionAppId: app.id });
            await get().loadApps();
            markBackupDirty();

            set({ lastCompletedEditAppId: app.id });
            setTimeout(() => {
                if (get().lastCompletedEditAppId === app.id) get().clearLastCompletedEdit();
            }, 5000);

            DeviceEventEmitter.emit('APP_UPDATED', { appId: app.id });
            return true;
        } catch (error) {
            console.error('Failed to edit spell:', error);
            set({
                error: t('spellFailedEdit'),
                lastFailedPrompt: { type: 'edit', text: instructions, appId: app.id },
            });
            return false;
        } finally {
            set(state => ({
                updatingAppIds: state.updatingAppIds.filter(id => id !== app.id),
            }));
        }
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
        const { images } = await openrouter.generateImage({
            model: MODELS.IMAGE,
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
}));
