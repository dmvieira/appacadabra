import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createBackup, processBackupData, BackupData } from './backup';
import { getGoogleAccessToken } from './firebase';
import { useBackupStore } from './backupStore';
import { useAppStore } from './store';

// ─── Constants ──────────────────────────────────────────────────────
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';
const BACKUP_FILENAME = 'appacadabra_backup.spell';
const DEBOUNCE_MS = 5_000;        // 5s debounce after change
const PERIODIC_MS = 60 * 60_000;  // 1 hour periodic check

// ─── Dirty-flag & scheduling ────────────────────────────────────────
let _dirty = false;
let _debounceTimer: ReturnType<typeof setTimeout> | null = null;
let _periodicTimer: ReturnType<typeof setInterval> | null = null;
let _writeLock = false; // prevents concurrent writes / corruption

/** Mark data as changed — schedules a debounced backup */
export function markBackupDirty() {
    const { backupMode } = useBackupStore.getState();
    if (!backupMode || backupMode === 'none') return;

    _dirty = true;

    // Reset debounce timer
    if (_debounceTimer) clearTimeout(_debounceTimer);
    _debounceTimer = setTimeout(async () => {
        _debounceTimer = null;
        await flushBackupIfDirty();
    }, DEBOUNCE_MS);
}

/** Flush pending backup right now (if dirty) */
async function flushBackupIfDirty(): Promise<boolean> {
    if (!_dirty) return false;
    return performBackup();
}

/** Start hourly periodic backup check */
export function startPeriodicBackup() {
    stopPeriodicBackup();
    _periodicTimer = setInterval(async () => {
        await flushBackupIfDirty();
    }, PERIODIC_MS);
}

/** Stop periodic backup timer */
export function stopPeriodicBackup() {
    if (_periodicTimer) {
        clearInterval(_periodicTimer);
        _periodicTimer = null;
    }
}

// ─── Google Drive backend ───────────────────────────────────────────

/** List files in the app's hidden appDataFolder */
async function listDriveFiles(accessToken: string): Promise<{ id: string; name: string }[]> {
    const url = `${DRIVE_API}/files?spaces=appDataFolder&fields=files(id,name)&q=name='${BACKUP_FILENAME}'`;
    const res = await fetch(url, {
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) {
        console.error('[BackupSync] Drive list failed:', res.status, await res.text());
        return [];
    }
    const data = await res.json();
    return data.files || [];
}

/** Upload (create or update) backup to Google Drive appDataFolder */
async function uploadToDrive(accessToken: string, backupJson: string): Promise<boolean> {
    try {
        const existing = await listDriveFiles(accessToken);
        const metadata = { name: BACKUP_FILENAME, ...(existing.length === 0 ? { parents: ['appDataFolder'] } : {}) };

        let url: string;
        let method: string;

        if (existing.length > 0) {
            url = `${DRIVE_UPLOAD_API}/files/${existing[0].id}?uploadType=multipart`;
            method = 'PATCH';
        } else {
            url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart`;
            method = 'POST';
        }

        const boundary = '===appacadabra_boundary===';
        const body =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            `${backupJson}\r\n` +
            `--${boundary}--`;

        const res = await fetch(url, {
            method,
            headers: {
                Authorization: `Bearer ${accessToken}`,
                'Content-Type': `multipart/related; boundary=${boundary}`,
            },
            body,
        });

        if (!res.ok) {
            console.error('[BackupSync] Drive upload failed:', res.status, await res.text());
            return false;
        }

        console.log('[BackupSync] Drive upload success');
        return true;
    } catch (e) {
        console.error('[BackupSync] Drive upload error:', e);
        return false;
    }
}

/** Download backup from Google Drive appDataFolder */
async function downloadFromDrive(accessToken: string): Promise<BackupData | null> {
    try {
        const files = await listDriveFiles(accessToken);
        if (files.length === 0) {
            console.log('[BackupSync] No backup found on Drive');
            return null;
        }

        const url = `${DRIVE_API}/files/${files[0].id}?alt=media`;
        const res = await fetch(url, {
            headers: { Authorization: `Bearer ${accessToken}` },
        });

        if (!res.ok) {
            console.error('[BackupSync] Drive download failed:', res.status);
            return null;
        }

        const text = await res.text();
        return JSON.parse(text) as BackupData;
    } catch (e) {
        console.error('[BackupSync] Drive download error:', e);
        return null;
    }
}

/** Check if a backup exists on Google Drive */
export async function checkDriveBackupExists(): Promise<boolean> {
    const token = await getGoogleAccessToken();
    if (!token) return false;
    const files = await listDriveFiles(token);
    return files.length > 0;
}

// ─── Local folder backend (Android SAF) ─────────────────────────────

/** Write backup to a SAF directory */
async function writeToLocalFolder(folderUri: string, backupJson: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const SAF = FileSystem.StorageAccessFramework;
        const files = await SAF.readDirectoryAsync(folderUri);
        const existingFile = files.find(f => f.endsWith(BACKUP_FILENAME));

        if (existingFile) {
            await FileSystem.writeAsStringAsync(existingFile, backupJson, {
                encoding: FileSystem.EncodingType.UTF8,
            });
        } else {
            const fileUri = await SAF.createFileAsync(folderUri, BACKUP_FILENAME, 'application/json');
            await FileSystem.writeAsStringAsync(fileUri, backupJson, {
                encoding: FileSystem.EncodingType.UTF8,
            });
        }

        console.log('[BackupSync] Local folder write success');
        return true;
    } catch (e) {
        console.error('[BackupSync] Local folder write error:', e);
        return false;
    }
}

/** Read backup from a SAF directory */
async function readFromLocalFolder(folderUri: string): Promise<BackupData | null> {
    if (Platform.OS !== 'android') return null;
    try {
        const SAF = FileSystem.StorageAccessFramework;
        const files = await SAF.readDirectoryAsync(folderUri);
        const backupFile = files.find(f => f.endsWith(BACKUP_FILENAME));

        if (!backupFile) {
            console.log('[BackupSync] No backup file found in local folder');
            return null;
        }

        const text = await FileSystem.readAsStringAsync(backupFile, {
            encoding: FileSystem.EncodingType.UTF8,
        });
        return JSON.parse(text) as BackupData;
    } catch (e) {
        console.error('[BackupSync] Local folder read error:', e);
        return null;
    }
}

/** Check if the local folder is accessible and contains a backup */
export async function checkLocalBackupExists(folderUri: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const SAF = FileSystem.StorageAccessFramework;
        const files = await SAF.readDirectoryAsync(folderUri);
        return files.some(f => f.endsWith(BACKUP_FILENAME));
    } catch {
        return false;
    }
}

/** Pick a local folder using SAF (Android only) */
export async function pickLocalFolder(): Promise<string | null> {
    if (Platform.OS !== 'android') return null;
    try {
        const permissions = await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
        if (permissions.granted) {
            return permissions.directoryUri;
        }
        return null;
    } catch (e) {
        console.error('[BackupSync] Folder picker error:', e);
        return null;
    }
}

// ─── Orchestration (with write-lock) ────────────────────────────────

/** Perform a backup to the configured destination.
 *  Uses a write lock to prevent concurrent writes / corruption. */
export async function performBackup(): Promise<boolean> {
    const { backupMode, localFolderUri, markBackupDone } = useBackupStore.getState();

    if (!backupMode || backupMode === 'none') return false;
    if (_writeLock) {
        console.log('[BackupSync] Write locked, skipping backup (will retry on next dirty flush)');
        return false; // Don't clear dirty — it will retry
    }

    _writeLock = true;
    try {
        // Snapshot the data while locked
        const backupData = await createBackup(true);
        const backupJson = JSON.stringify(backupData);

        let success = false;

        if (backupMode === 'google_drive') {
            const token = await getGoogleAccessToken();
            if (!token) {
                console.warn('[BackupSync] No access token for Drive backup');
                return false;
            }
            success = await uploadToDrive(token, backupJson);
        } else if (backupMode === 'local_folder' && localFolderUri) {
            success = await writeToLocalFolder(localFolderUri, backupJson);
        }

        if (success) {
            _dirty = false;
            markBackupDone();
        }
        return success;
    } catch (e) {
        console.error('[BackupSync] Backup failed:', e);
        return false;
    } finally {
        _writeLock = false;
    }
}

/** Attempt to restore from the configured backup source */
export async function performRestore(): Promise<{ success: boolean; count: number }> {
    const { backupMode, localFolderUri, markRestoreDone } = useBackupStore.getState();

    if (_writeLock) {
        console.warn('[BackupSync] Write locked, cannot restore now');
        return { success: false, count: 0 };
    }

    _writeLock = true;
    try {
        let backupData: BackupData | null = null;

        if (backupMode === 'google_drive') {
            const token = await getGoogleAccessToken();
            if (!token) return { success: false, count: 0 };
            backupData = await downloadFromDrive(token);
        } else if (backupMode === 'local_folder' && localFolderUri) {
            backupData = await readFromLocalFolder(localFolderUri);
        }

        if (!backupData || !backupData.apps || backupData.apps.length === 0) {
            return { success: true, count: 0 };
        }

        const result = await processBackupData(backupData);
        if (result.success) {
            markRestoreDone(result.count);
            useAppStore.getState().loadApps();
        }
        return result;
    } catch (e) {
        console.error('[BackupSync] Restore failed:', e);
        return { success: false, count: 0 };
    } finally {
        _writeLock = false;
    }
}

/** Try to restore on login (called after Google auth transition) */
export async function tryRestoreOnLogin(): Promise<'restored' | 'no_backup' | 'local_missing' | 'error'> {
    const { backupMode, localFolderUri } = useBackupStore.getState();

    if (!backupMode || backupMode === 'none') return 'no_backup';

    if (backupMode === 'google_drive') {
        const exists = await checkDriveBackupExists();
        if (!exists) return 'no_backup';
        const result = await performRestore();
        return result.success ? 'restored' : 'error';
    }

    if (backupMode === 'local_folder') {
        if (!localFolderUri) return 'local_missing';
        const exists = await checkLocalBackupExists(localFolderUri);
        if (!exists) return 'local_missing';
        const result = await performRestore();
        return result.success ? 'restored' : 'error';
    }

    return 'no_backup';
}

// ─── Legacy alias (backward compat) ────────────────────────────────
/** @deprecated Use `markBackupDirty()` instead */
export const autoBackupAfterChange = markBackupDirty;
