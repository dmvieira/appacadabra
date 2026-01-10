import { create } from 'zustand';
import { GeneratedApp, NewGeneratedApp } from './database/types';
import * as db from './database/db';
import * as gemini from './api/gemini';
import * as backup from './backup';
import * as projectConverter from './projectConverter';
import SharingShortcuts from './bridges/SharingShortcuts';

interface AppState {
    apps: GeneratedApp[];
    isLoading: boolean;
    isGenerating: boolean;
    isImporting: boolean;
    error: string | null;
    backupStatus: string | null;

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
    importBackup: () => Promise<void>;
    importProject: (zipUri: string) => Promise<GeneratedApp | null>;
    clearError: () => void;
    clearBackupStatus: () => void;
    setSharedContent: (content: AppState['sharedContent']) => void;
    clearSharedContent: () => void;
}

export const useAppStore = create<AppState>((set, get) => ({
    apps: [],
    isLoading: true,
    isGenerating: false,
    isImporting: false,
    error: null,
    backupStatus: null,
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
            set({ error: 'Erro ao carregar apps', isLoading: false });
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
            set({ isGenerating: true, error: null });

            const code = await gemini.generateApp(description);

            const newApp: NewGeneratedApp = {
                name: description.slice(0, 20) + '...',
                code,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: Date.now(),
                consoleLogs: '',
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
                error: `Erro ao criar app: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
                isGenerating: false
            });
            return null;
        }
    },

    updateAppWithAI: async (app: GeneratedApp, instructions: string, selectedContext?: string) => {
        try {
            set({ isGenerating: true, error: null });

            // Get previous versions for context
            const versions = await db.getVersionsForApp(app.id);
            const previousEdits = versions
                .filter(v => v.instruction)
                .slice(0, 10)
                .map(v => ({ version: v.version, instruction: v.instruction }));

            const newCode = await gemini.editAppWithContext(
                app.code,
                instructions,
                selectedContext || '',
                previousEdits
            );

            const newVersion = app.currentVersion + 1;
            const updatedApp: GeneratedApp = {
                ...app,
                code: newCode,
                currentVersion: newVersion,
                lastUpdated: Date.now(),
            };

            await db.updateApp(updatedApp);
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
                error: `Erro ao atualizar app: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
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
            set({ error: 'Erro ao deletar app' });
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
            set({ error: 'Erro ao renomear app' });
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
            set({ error: 'Erro ao atualizar ícone' });
        }
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
                instruction: instruction || 'Edição manual',
                selectedContext: null,
                createdAt: Date.now(),
            });

            set(state => ({
                apps: state.apps.map(a => a.id === id ? updatedApp : a),
                isGenerating: false,
            }));
        } catch (error) {
            console.error('Failed to update app code:', error);
            set({ error: 'Erro ao atualizar código' });
        }
    },

    exportBackup: async () => {
        try {
            set({ backupStatus: 'Exportando...' });
            const success = await backup.exportBackup();
            if (success) {
                set({ backupStatus: 'Backup exportado com sucesso!' });
            } else {
                set({ backupStatus: 'Erro ao exportar backup' });
            }
        } catch (error) {
            console.error('Failed to export backup:', error);
            set({ backupStatus: 'Erro ao exportar backup' });
        }
    },

    importBackup: async () => {
        try {
            set({ backupStatus: 'Importando...' });
            const result = await backup.importBackup();
            set({ backupStatus: result.message });

            if (result.success) {
                // Reload apps after import
                const apps = await db.getAllApps();
                set({ apps });
            }
        } catch (error) {
            console.error('Failed to import backup:', error);
            set({ backupStatus: 'Erro ao importar backup' });
        }
    },

    importProject: async (zipUri: string) => {
        try {
            set({ isImporting: true, error: null });

            const result = await projectConverter.convertProject(zipUri);

            if (!result.success || !result.html) {
                set({
                    error: result.error || 'Erro ao converter projeto',
                    isImporting: false
                });
                return null;
            }

            const newApp: NewGeneratedApp = {
                name: result.name || 'Projeto Importado',
                code: result.html,
                currentVersion: 1,
                iconPath: null,
                lastUpdated: Date.now(),
                consoleLogs: '',
            };

            const id = await db.insertApp(newApp);

            await db.insertVersion({
                appId: id,
                version: 1,
                code: result.html,
                instruction: 'Importado de projeto ZIP',
                selectedContext: null,
                createdAt: Date.now(),
            });

            const createdApp: GeneratedApp = { ...newApp, id };
            set(state => ({
                apps: [createdApp, ...state.apps],
                isImporting: false,
                backupStatus: `Projeto "${result.name}" importado com sucesso!`
            }));

            SharingShortcuts.publishShortcut(id.toString(), createdApp.name, createdApp.iconPath);

            return createdApp;
        } catch (error) {
            console.error('Failed to import project:', error);
            set({
                error: `Erro ao importar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`,
                isImporting: false
            });
            return null;
        }
    },

    clearError: () => set({ error: null }),
    clearBackupStatus: () => set({ backupStatus: null }),
    setSharedContent: (content) => set({ sharedContent: content }),
    clearSharedContent: () => set({ sharedContent: null }),
}));
