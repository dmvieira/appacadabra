import { create } from 'zustand';
import AsyncStorage from '@react-native-async-storage/async-storage';

const BACKUP_PREFS_KEY = 'appacadabra_backup_prefs';

export type BackupMode = 'google_drive' | 'local_folder' | 'none' | null;

interface BackupState {
    /** null = not yet chosen, 'none' = explicitly skipped */
    backupMode: BackupMode;
    /** SAF content URI for the chosen local folder (Android only) */
    localFolderUri: string | null;
    /** Timestamp of last successful backup */
    lastBackupAt: number | null;
    /** Timestamp of last successful restore */
    lastRestoreAt: number | null;
    /** Number of spells restored in the most recent restore (for UI banner) */
    restoredCount: number;
    /** Whether the store has been hydrated from AsyncStorage */
    hydrated: boolean;
    /** Whether a restore operation is currently in progress */
    isRestoring: boolean;

    // Actions
    hydrate: () => Promise<void>;
    setBackupMode: (mode: BackupMode) => void;
    setLocalFolderUri: (uri: string | null) => void;
    setIsRestoring: (isRestoring: boolean) => void;
    markBackupDone: () => void;
    markRestoreDone: (count: number) => void;
    clearRestoredCount: () => void;
    resetBackup: () => void;
}

function persist(state: Partial<BackupState>) {
    const toSave = {
        backupMode: state.backupMode ?? null,
        localFolderUri: state.localFolderUri ?? null,
        lastBackupAt: state.lastBackupAt ?? null,
        lastRestoreAt: state.lastRestoreAt ?? null,
    };
    AsyncStorage.setItem(BACKUP_PREFS_KEY, JSON.stringify(toSave)).catch(e =>
        console.warn('[BackupStore] Failed to persist:', e)
    );
}

export const useBackupStore = create<BackupState>((set, get) => ({
    backupMode: null,
    localFolderUri: null,
    lastBackupAt: null,
    lastRestoreAt: null,
    restoredCount: 0,
    hydrated: false,
    isRestoring: false,

    hydrate: async () => {
        try {
            const raw = await AsyncStorage.getItem(BACKUP_PREFS_KEY);
            if (raw) {
                const data = JSON.parse(raw);
                set({
                    backupMode: data.backupMode ?? null,
                    localFolderUri: data.localFolderUri ?? null,
                    lastBackupAt: data.lastBackupAt ?? null,
                    lastRestoreAt: data.lastRestoreAt ?? null,
                    hydrated: true,
                });
            } else {
                set({ hydrated: true });
            }
        } catch (e) {
            console.warn('[BackupStore] Failed to hydrate:', e);
            set({ hydrated: true });
        }
    },

    setBackupMode: (mode: BackupMode) => {
        set({ backupMode: mode });
        persist({ ...get(), backupMode: mode });
    },

    setLocalFolderUri: (uri: string | null) => {
        set({ localFolderUri: uri });
        persist({ ...get(), localFolderUri: uri });
    },

    setIsRestoring: (isRestoring: boolean) => {
        set({ isRestoring });
    },

    markBackupDone: () => {
        const now = Date.now();
        set({ lastBackupAt: now });
        persist({ ...get(), lastBackupAt: now });
    },

    markRestoreDone: (count: number) => {
        const now = Date.now();
        set({ lastRestoreAt: now, restoredCount: count });
        persist({ ...get(), lastRestoreAt: now });
    },

    clearRestoredCount: () => {
        set({ restoredCount: 0 });
    },

    resetBackup: () => {
        set({
            backupMode: null,
            localFolderUri: null,
            lastBackupAt: null,
            lastRestoreAt: null,
            restoredCount: 0,
        });
        AsyncStorage.removeItem(BACKUP_PREFS_KEY).catch(() => { });
    },
}));
