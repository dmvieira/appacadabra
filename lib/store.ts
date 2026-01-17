import { create } from 'zustand';
import { GeneratedApp, NewGeneratedApp } from './database/types';
import * as db from './database/db';
import * as gemini from './api/gemini';
import * as backup from './backup';
import * as projectConverter from './projectConverter';
import SharingShortcuts from './bridges/SharingShortcuts';
import { t } from './i18n';
import { useManaStore, MANA_COSTS, calculateManaCost } from './manaStore';

interface AppState {
    apps: GeneratedApp[];
    isLoading: boolean;
    isGenerating: boolean;
    isImporting: boolean;
    error: string | null;
    statusMessage: string | null;

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

    // Actions
    loadApps: () => Promise<void>;
    openApp: (id: number, mode?: 'run' | 'edit') => void;
    closeApp: (id: number) => void;
    minimizeApp: () => void;
    createApp: (description: string) => Promise<GeneratedApp | null>;
    updateAppWithAI: (app: GeneratedApp, instructions: string, selectedContext?: string) => Promise<GeneratedApp | null>;
    deleteApp: (id: number) => Promise<void>;
    renameApp: (id: number, newName: string) => Promise<void>;
    updateAppIcon: (id: number, iconPath: string) => Promise<void>;
    updateAppCode: (id: number, code: string, instruction?: string) => Promise<void>;
    exportBackup: () => Promise<void>;
    importBackup: (uri?: string) => Promise<void>;
    importProject: (zipUri: string) => Promise<GeneratedApp | null>;
    clearError: () => void;
    clearStatusMessage: () => void;
    setStatusMessage: (message: string) => void;
    setSharedContent: (content: AppState['sharedContent']) => void;
    clearSharedContent: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
    apps: [],
    isLoading: true,
    isGenerating: false,
    isImporting: false,
    error: null,
    statusMessage: null,
    runningInstances: [],
    activeAppId: null,
    sharedContent: null,

    loadApps: async () => {
        try {
            set({ isLoading: true, error: null });
            const apps = await db.getAllApps();
            set({ apps, isLoading: false });

            // Publish Direct Share shortcuts for all apps
            apps.forEach(app => {
                SharingShortcuts.publishShortcut(app.id.toString(), app.name, app.iconPath);
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

    createApp: async (description: string) => {
        try {
            // Check Mana
            const manaStore = useManaStore.getState();
            // Just check if they have enough to start (minimum required)
            if (manaStore.balance < MANA_COSTS.MIN_REQUIRED) {
                manaStore.openShop();
                set({ error: t('insufficientManaMessage', { cost: MANA_COSTS.MIN_REQUIRED, balance: manaStore.balance.toFixed(2) }), isGenerating: false });
                return null;
            }

            set({ isGenerating: true, error: null });

            const result = await gemini.generateApp(description);
            const code = result.text;
            const usage = result.usage;

            // Deduct Mana based on actual usage
            const cost = calculateManaCost(usage?.totalTokens || 0);
            manaStore.deductMana(cost);
            console.log(`[Store] App generated. Tokens: ${usage?.totalTokens}. Cost: ${cost} Mana.`);

            const newApp: NewGeneratedApp = {
                name: description.slice(0, 20) + '...',
                code,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: Date.now(),
                consoleLogs: '',
                totalManaCost: cost, // Initial cost
            };

            const id = await db.insertApp(newApp);

            // Save initial version
            await db.insertVersion({
                appId: id,
                version: 1,
                code,
                instruction: null,
                selectedContext: null,
                createdAt: Date.now(),
            });

            const createdApp: GeneratedApp = { ...newApp, id };
            set(state => ({
                apps: [createdApp, ...state.apps],
                isGenerating: false
            }));

            // Publish as Direct Share shortcut
            SharingShortcuts.publishShortcut(id.toString(), createdApp.name, createdApp.iconPath);

            return createdApp;
        } catch (error) {
            console.error('Failed to create app:', error);
            set({
                error: t('spellFailedCreate'),
                isGenerating: false
            });
            return null;
        }
    },

    updateAppWithAI: async (app: GeneratedApp, instructions: string, selectedContext?: string) => {
        try {
            // Check Mana
            const manaStore = useManaStore.getState();
            if (manaStore.balance < MANA_COSTS.MIN_REQUIRED) {
                manaStore.openShop();
                set({ error: t('insufficientManaMessage', { cost: MANA_COSTS.MIN_REQUIRED, balance: manaStore.balance.toFixed(2) }), isGenerating: false });
                return null;
            }

            set({ isGenerating: true, error: null });

            // Get previous versions for context
            const versions = await db.getVersionsForApp(app.id);
            const previousEdits = versions
                .filter(v => v.instruction)
                .slice(0, 10)
                .map(v => ({ version: v.version, instruction: v.instruction }));

            const result = await gemini.editAppWithContext(
                app.code,
                instructions,
                selectedContext || '',
                previousEdits
            );
            const newCode = result.text;
            const usage = result.usage;

            const newVersion = app.currentVersion + 1;
            const updatedApp: GeneratedApp = {
                ...app,
                code: newCode,
                currentVersion: newVersion,
                lastUpdated: Date.now(),
                totalManaCost: (app.totalManaCost || 0) + calculateManaCost(usage?.totalTokens || 0), // Add edit cost
            };

            await db.updateApp(updatedApp);

            // Deduct Mana
            const cost = calculateManaCost(usage?.totalTokens || 0);
            manaStore.deductMana(cost);
            console.log(`[Store] App edited. Tokens: ${usage?.totalTokens}. Cost: ${cost} Mana.`);

            await db.insertVersion({
                appId: app.id,
                version: newVersion,
                code: newCode,
                instruction: instructions,
                selectedContext: selectedContext || null,
                createdAt: Date.now(),
            });

            set(state => ({
                apps: state.apps.map(a => a.id === app.id ? updatedApp : a),
                isGenerating: false,
            }));

            return updatedApp;
        } catch (error) {
            console.error('Failed to update app:', error);
            set({
                error: t('spellFailedEdit'),
                isGenerating: false
            });
            return null;
        }
    },

    deleteApp: async (id: number) => {
        try {
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
                consoleLogs: '',
                totalManaCost: 0,
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
            set({
                error: `${t('importError')} ${error instanceof Error ? error.message : t('unknownError')}`,
                isImporting: false
            });
            return null;
        }
    },

    clearError: () => set({ error: null }),
    clearStatusMessage: () => set({ statusMessage: null }),
    setStatusMessage: (message) => set({ statusMessage: message }),
    setSharedContent: (content) => set({ sharedContent: content }),
    clearSharedContent: () => set({ sharedContent: null }),
}));
