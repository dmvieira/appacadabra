import { create } from 'zustand';
import * as Notifications from 'expo-notifications';
import { DeviceEventEmitter } from 'react-native';
import { GeneratedApp, NewGeneratedApp } from './database/types';
import * as db from './database/db';
import * as ai from './api/ai';
import * as backup from './backup';
import { onboardingTemplates } from './onboardingTemplates';
import * as projectConverter from './projectConverter';
import * as firebase from './firebase'; // Import firebase helper
import { Job } from './firebase';
import SharingShortcuts from './bridges/SharingShortcuts';
import { t } from './i18n';
import { useManaStore } from './manaStore';

const DISMISSED_URI_TTL_MS = 15000;

interface AppState {
    apps: GeneratedApp[];
    isLoading: boolean;
    isGenerating: boolean;
    isImporting: boolean;
    error: string | null;
    statusMessage: string | null;
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

    // Async Job Management
    activeJobs: Job[];
    creatingApps: { jobId: string; description: string; timestamp: number }[];

    // Signal for RunnerScreen to navigate back after edit completes
    lastCompletedEditAppId: number | null;
    updatingAppIds: number[];

    // Signal for HomeScreen to show post-creation setup modal
    lastCreatedAppId: number | null;

    // Dismissed content URIs to prevent re-prompting
    dismissedUris: Record<string, number>;
    dismissContent: (uri: string) => void;

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
    incrementAppManaCost: (id: number, amount: number) => Promise<void>;
    exportBackup: () => Promise<void>;
    importBackup: (uri?: string) => Promise<void>;
    importDemoSpell: () => Promise<void>;
    importOnboardingSpell: (chipIndex: number) => Promise<number | null>;
    importProject: (zipUri: string) => Promise<GeneratedApp | null>;
    clearError: () => void;
    clearStatusMessage: () => void;
    setStatusMessage: (message: string) => void;
    setPendingImportUrl: (url: string | null) => void;
    setSharedContent: (content: AppState['sharedContent']) => void;
    clearSharedContent: () => void;
    _processCompletedJob: (job: Job) => Promise<void>;
    _processFailedJob: (job: Job) => void;
}

export const useAppStore = create<AppState>((set, get) => ({
    apps: [],
    isLoading: true,
    isGenerating: false,
    isImporting: false,
    error: null,
    statusMessage: null,
    pendingImportUrl: null,
    runningInstances: [],
    activeAppId: null,
    sharedContent: null,
    activeJobs: [],
    creatingApps: [],
    updatingAppIds: [],
    lastCompletedEditAppId: null,
    lastCreatedAppId: null,
    dismissedUris: {},

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

    initializeListeners: () => {
        // Prevent double initialization if needed, but useEffect in App usually handles strict mode
        console.log('[Store] Initializing job listeners...');

        // Listen to active jobs
        const unsubscribeJobs = firebase.listenToActiveJobs((jobs) => {
            const currentJobs = get().activeJobs;

            // Check for newly completed jobs to process results
            jobs.forEach(job => {
                const previousJob = currentJobs.find(j => j.id === job.id);
                const wasCompleted = previousJob?.status === 'completed';
                const wasFailed = previousJob?.status === 'failed';

                // Check job age to prevent re-importing old history on login
                // Only process recent jobs (e.g. created < 10 mins ago) if they appear completed
                // This handles the case where user logs in and fetch returns old 'completed' jobs
                let jobTime = 0;
                if (job.createdAt && typeof job.createdAt.toMillis === 'function') {
                    jobTime = job.createdAt.toMillis();
                } else if (typeof job.createdAt === 'number') {
                    jobTime = job.createdAt;
                } else if (job.createdAt && job.createdAt.seconds) {
                    jobTime = job.createdAt.seconds * 1000;
                }

                const isOld = (Date.now() - jobTime) > 10 * 60 * 1000; // 10 minutes

                if (job.status === 'completed' && !wasCompleted) {
                    // Only process result if it's a fresh completion or a recent job recovery
                    if (!isOld) {
                        get()._processCompletedJob(job);
                    } else {
                        console.log('[Store] Ignoring old completed job from history:', job.id);
                    }
                } else if (job.status === 'failed' && !wasFailed) {
                    // Similar logic for failed jobs? Usually we want to know it failed recently
                    if (!isOld) {
                        get()._processFailedJob(job);
                    }
                } else if (job.status === 'processing' && isOld) {
                    // Stuck job: processing for > 10 minutes = likely Cloud Function timeout
                    const wasAlreadyHandled = previousJob?.status === 'failed';
                    if (!wasAlreadyHandled) {
                        console.warn('[Store] Stuck job detected (processing > 10min):', job.id);
                        get()._processFailedJob({
                            ...job,
                            status: 'failed',
                            error: 'timeout',
                        });
                    }
                }
            });

            console.log(`[Store] Active activeJobs updated: ${jobs.length}`, jobs.map(j => ({ id: j.id, status: j.status })));
            set({ activeJobs: jobs });
        });

        // Listen to auth state to clear/reload if needed? 
        // For now, firebase listener handles auth internally.
    },

    // Internal helper to process job results
    _processCompletedJob: async (job: Job) => {
        console.log('[Store] Processing completed job:', job.id, 'Action:', job.action);

        // Cleanup placeholders/locks
        if (job.action === 'create') {
            set(state => ({
                creatingApps: state.creatingApps.filter(a => a.jobId !== job.id)
            }));
        } else if (job.action === 'edit' && job.payload?.appId) {
            set(state => ({
                updatingAppIds: state.updatingAppIds.filter(id => id !== job.payload.appId)
            }));
        }

        if (!job.result) {
            console.warn('[Store] Job completed but has no result:', job.id);
            // If failed/no result, we still cleaned up above.
            return;
        }

        // Idempotency check: Don't re-process if already in processed_jobs history
        // This prevents notifications on app restart AND zombie apps (deleted apps reappearing)
        const alreadyProcessed = await db.hasJobBeenProcessed(job.id);
        if (alreadyProcessed) {
            console.log('[Store] Skipping already processed job (history):', job.id);
            return;
        }

        try {
            const decompressedText = firebase.decompressContent(job.result.text);
            const usage = job.result.usage;

            if (job.action === 'create') {
                // Extract title
                let appName = 'New App';
                const titleMatch = decompressedText.match(/<title[^>]*>([^<]+)<\/title>/i);
                if (titleMatch && titleMatch[1]) {
                    appName = titleMatch[1].trim();
                }

                const now = Date.now();
                const newApp: NewGeneratedApp = {
                    name: appName,
                    code: decompressedText,
                    currentVersion: 1,
                    iconPath: null,
                    lastUpdated: now,
                    createdAt: now,
                    consoleLogs: '',
                    totalManaCost: 0,
                    jobId: job.id,
                    requiresBiometric: false,
                    shortDescription: job.payload?.prompt ? firebase.decompressContent(job.payload.prompt) : '' // Set initial description from prompt
                };

                // Insert into DB (idempotent check inside db.insertApp)
                const id = await db.insertApp(newApp);

                // Log creation mana cost (both totalManaCost + mana_events for recentManaCost)
                const creationCredits = job.result.creditsUsed || 0;
                if (creationCredits > 0) {
                    await db.incrementManaCost(id, creationCredits);
                }

                // Create a dedicated notification channel for this spell (Android)
                await Notifications.setNotificationChannelAsync(`spell-${id}`, {
                    name: appName,
                    importance: Notifications.AndroidImportance.HIGH,
                    vibrationPattern: [0, 250, 250, 250],
                    lightColor: '#FF9500',
                });

                // Publish shortcut
                const app = await db.getAppById(id);
                if (app) {
                    SharingShortcuts.publishShortcut(id.toString(), app.name, app.iconPath);
                    // Insert version
                    await db.insertVersion({
                        appId: id,
                        version: 1,
                        code: decompressedText,
                        instruction: job.payload?.prompt ? firebase.decompressContent(job.payload.prompt) : t('initialGeneration'),
                        selectedContext: null,
                        createdAt: Date.now(),
                        jobId: job.id
                    });

                    // Reload apps to update UI
                    await get().loadApps();
                    set({ statusMessage: t('appReadyNotify', { name: appName }), lastCreatedAppId: id });

                    // Schedule Local Notification
                    await Notifications.scheduleNotificationAsync({
                        content: {
                            title: t('appReadyTitle', { name: appName }),
                            body: t('appReadyBody', { name: appName }),
                            data: { appId: id, notificationType: 'app_created' },
                            channelId: `spell-${id}`, // Use spell-specific channel
                        } as any, // channelId is valid on Android but types may lag
                        trigger: null, // Show immediately
                    });

                    // Mark as processed in history to prevent zombies
                    await db.markJobAsProcessed(job.id, job.action);
                }
            } else if (job.action === 'edit') {
                const appId = job.payload?.appId;

                if (appId) {
                    const app = await db.getAppById(appId);
                    if (app) {
                        const newVersion = app.currentVersion + 1;
                        const editCredits = job.result.creditsUsed || 0;
                        const updatedApp: GeneratedApp = {
                            ...app,
                            code: decompressedText,
                            currentVersion: newVersion,
                            lastUpdated: Date.now(),
                        };

                        await db.updateApp(updatedApp);

                        // Log edit mana cost (both totalManaCost + mana_events for recentManaCost)
                        if (editCredits > 0) {
                            await db.incrementManaCost(appId, editCredits);
                        }

                        await db.insertVersion({
                            appId: appId,
                            version: newVersion,
                            code: decompressedText,
                            instruction: job.payload?.instruction ? firebase.decompressContent(job.payload.instruction) : t('aiEdit'),
                            selectedContext: null,
                            createdAt: Date.now(),
                            jobId: job.id
                        });

                        set({ statusMessage: t('appUpdatedNotify', { name: app.name }) });

                        // Reload to reflect changes
                        await get().loadApps();

                        // Schedule Local Notification for Edit
                        await Notifications.scheduleNotificationAsync({
                            content: {
                                title: t('appUpdatedTitle', { name: app.name }),
                                body: t('appUpdatedBody', { name: app.name }),
                                data: { appId: appId },
                                channelId: `spell-${appId}`, // Use spell-specific channel
                            } as any, // channelId is valid on Android but types may lag
                            trigger: null,
                        });

                        // Mark as processed in history to prevent zombies
                        await db.markJobAsProcessed(job.id, job.action);


                        // Signal RunnerScreen to exit edit mode via router
                        set({ lastCompletedEditAppId: appId });

                        // Notify Listeners (RunnerApp)
                        DeviceEventEmitter.emit('APP_UPDATED', { appId });
                    }
                }
            }
        } catch (e) {
            console.error('[Store] Error processing completed job:', e);
            set({ error: t('errorProcessingJob') });
        }
    },

    // Internal helper to process job failures (especially mana-related)
    _processFailedJob: (job: Job) => {
        console.log('[Store] Processing failed job:', job.id, 'Error:', job.error);

        // Cleanup placeholders/locks
        if (job.action === 'create') {
            set(state => ({
                creatingApps: state.creatingApps.filter(a => a.jobId !== job.id)
            }));
        } else if (job.action === 'edit' && job.payload?.appId) {
            set(state => ({
                updatingAppIds: state.updatingAppIds.filter(id => id !== job.payload.appId)
            }));
        }

        // Check if error is mana-related
        const isManaError = job.error?.toLowerCase().includes('insufficient credits') ||
            job.error?.toLowerCase().includes('insufficient mana');

        if (isManaError) {
            // Show special mana depletion notification
            set({ statusMessage: t('manaDepletedMessage') });

            // Schedule push notification
            Notifications.scheduleNotificationAsync({
                content: {
                    title: t('manaDepletedTitle'),
                    body: t('manaDepletedMessage'),
                },
                trigger: null,
            });

            // Auto-open the mana shop
            useManaStore.getState().openShop();
        } else {
            // Generic job failure
            const errorMsg = job.action === 'create' ? t('spellFailedCreate') : t('spellFailedEdit');
            set({ error: errorMsg });
        }
    },

    loadApps: async () => {
        try {
            set({ isLoading: true, error: null });
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
        try {
            // FIRE & FORGET
            set({ error: null });

            const jobId = await firebase.submitJob('create', {
                prompt: firebase.compressContent(description)
            });

            // Add placeholder with timeout
            set(state => ({
                creatingApps: [...state.creatingApps, { jobId, description, timestamp: Date.now() }],
                statusMessage: t('jobStarted')
            }));

            // Safety timeout (10m)
            setTimeout(() => {
                set(state => ({
                    creatingApps: state.creatingApps.filter(a => a.jobId !== jobId)
                }));
            }, 600000);

            return true;
        } catch (error) {
            console.error('Failed to submit create job:', error);
            set({ error: t('spellFailedCreate') });
            return false;
        }
    },

    updateAppWithAI: async (app: GeneratedApp, instructions: string, selectedContext?: string) => {
        try {
            set({ error: null });

            // Get previous versions for context
            const versions = await db.getVersionsForApp(app.id);
            const previousEdits = versions
                .filter(v => v.instruction)
                .slice(0, 10)
                .map(v => ({ version: v.version, instruction: v.instruction }));

            const jobId = await firebase.submitJob('edit', {
                appId: app.id, // IMPORTANT: Pass appId so we know what to update
                currentCode: firebase.compressContent(app.code),
                instruction: firebase.compressContent(instructions),
                previousEdits, // Already objects, sanitizePayload will handle? Yes.
                selectedContext: selectedContext ? firebase.compressContent(selectedContext) : undefined,
            });

            // Lock the app
            set(state => ({
                updatingAppIds: [...state.updatingAppIds, app.id],
                statusMessage: t('editJobStarted')
            }));

            // Safety timeout (10m)
            setTimeout(() => {
                set(state => ({
                    updatingAppIds: state.updatingAppIds.filter(id => id !== app.id)
                }));
            }, 600000);

            return true;
        } catch (error) {
            console.error('Failed to submit edit job:', error);
            set({ error: t('spellFailedEdit') });
            return false;
        }
    },

    deleteApp: async (id: number) => {
        try {
            // Remove the notification channel for this spell (Android)
            await Notifications.deleteNotificationChannelAsync(`spell-${id}`);

            await db.deleteApp(id);
            set(state => ({
                apps: state.apps.filter(a => a.id !== id),
            }));

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
        } catch (error) {
            console.error('Failed to update app icon:', error);
            set({ error: t('errorUpdatingIcon') });
        }
    },

    incrementAppManaCost: async (id: number, amount: number) => {
        try {
            await db.incrementManaCost(id, amount);
            set(state => ({
                apps: state.apps.map(a =>
                    a.id === id ? { ...a, totalManaCost: (a.totalManaCost || 0) + amount } : a
                ),
            }));
        } catch (error) {
            console.warn('Failed to increment app mana cost:', error);
        }
    },

    updateAppCode: async (id: number, code: string, instruction?: string) => {
        try {
            // Check Mana for manual edit? 
            // "Edit App" cost usually implies AI Edit. Manual edit should be free?
            // User prompt: "consumo nas chamadas de IA".
            // So manual updateAppCode (from editor typing) should be FREE unless it uses AI features.
            // This function is called by the Editor save.
            // Wait, `updateAppWithAI` is the AI one. `updateAppCode` is manual save.
            // So NO CHARGE here.

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

            // Notify Listeners (RunnerApp)
            DeviceEventEmitter.emit('APP_UPDATED', { appId: id });
        } catch (error) {
            console.error('Failed to update app code:', error);
            set({ error: t('errorUpdatingCode') });
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

    importBackup: async (uri?: string) => {
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
            }
        } catch (error) {
            console.error('Failed to import backup:', error);
            set({ statusMessage: t('errorImportingBackup'), isImporting: false });
        }
    },

    importDemoSpell: async () => {
        try {
            if (get().isImporting) return;
            set({ isImporting: true, statusMessage: t('importingDemo') });

            const result = await backup.importDemoSpell();

            set({ statusMessage: result.message, isImporting: false });

            if (result.success) {
                const apps = await db.getAllApps();
                set({ apps });
            }
        } catch (error) {
            console.error('Failed to import demo spell:', error);
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
                totalManaCost: 0, // Free!
                requiresBiometric: false,
                shortDescription: template.shortDescription,
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
                totalManaCost: 0,
                requiresBiometric: false,
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

            return createdApp;
        } catch (error) {
            console.error('Failed to import project:', error);
            const errorMsg = error instanceof Error ? error.message : t('unknownError');

            // Check if error is mana-related
            const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                errorMsg.toLowerCase().includes('insufficient mana');

            if (isManaError) {
                set({
                    statusMessage: t('manaDepletedMessage'),
                    isImporting: false
                });

                // Schedule push notification
                Notifications.scheduleNotificationAsync({
                    content: {
                        title: t('manaDepletedTitle'),
                        body: t('manaDepletedMessage'),
                    },
                    trigger: null,
                });

                // Auto-open the mana shop
                useManaStore.getState().openShop();
            } else {
                set({
                    error: `${t('importError')} ${errorMsg}`,
                    isImporting: false
                });
            }
            return null;
        }
    },

    clearError: () => set({ error: null }),
    clearStatusMessage: () => set({ statusMessage: null }),
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
}));
