import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import { createBackup, processBackupData, BackupData, BackupApp, readBackupFile } from './backup';
import { requestGoogleScopes, isGoogleUser } from './firebase';

const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
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

/** List files in the app's hidden appDataFolder, sorted by modifiedTime DESC */
async function listDriveFiles(accessToken: string): Promise<{ id: string; name: string; modifiedTime: string }[]> {
    const url = `${DRIVE_API}/files?spaces=appDataFolder&fields=files(id,name,modifiedTime)&q=name='${BACKUP_FILENAME}'&orderBy=modifiedTime desc`;
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

/** Delete a file from Google Drive by ID */
async function deleteDriveFile(accessToken: string, fileId: string): Promise<void> {
    const res = await fetch(`${DRIVE_API}/files/${fileId}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok && res.status !== 404) {
        console.warn('[BackupSync] Drive delete failed:', res.status, fileId);
    }
}

/** Merge two BackupData objects, keeping the more recently updated version of each app */
function mergeBackups(local: BackupData, remote: BackupData): BackupData {
    // Merge tombstones: per name, keep the most recent deletedAt
    const tombstoneMap = new Map<string, number>();
    for (const d of [...(local.deletedApps ?? []), ...(remote.deletedApps ?? [])]) {
        const existing = tombstoneMap.get(d.name);
        if (existing === undefined || d.deletedAt > existing) {
            tombstoneMap.set(d.name, d.deletedAt);
        }
    }

    const map = new Map<string, BackupApp>();
    // Remote first, then local overwrites if local is newer (or equal)
    for (const app of [...remote.apps, ...local.apps]) {
        const existing = map.get(app.name);
        if (!existing) {
            map.set(app.name, app);
        } else if (app.lastUpdated >= existing.lastUpdated) {
            // Winner takes code/version; preserve description & icon from whichever has them
            map.set(app.name, {
                ...app,
                shortDescription: app.shortDescription ?? existing.shortDescription,
                iconBase64: app.iconBase64 ?? existing.iconBase64,
            });
        } else {
            // Existing keeps code/version; still inherit description & icon from incoming if missing
            map.set(app.name, {
                ...existing,
                shortDescription: existing.shortDescription ?? app.shortDescription,
                iconBase64: existing.iconBase64 ?? app.iconBase64,
            });
        }
    }

    // Filter out tombstoned apps
    const mergedApps = Array.from(map.values()).filter(app => {
        const deletedAt = tombstoneMap.get(app.name);
        return deletedAt === undefined || app.lastUpdated > deletedAt;
    });

    const deletedApps = tombstoneMap.size > 0
        ? Array.from(tombstoneMap.entries()).map(([name, deletedAt]) => ({ name, deletedAt }))
        : undefined;

    return { ...local, apps: mergedApps, deletedApps };
}

/** Upload (create or update) backup to Google Drive appDataFolder.
 *  Merges with existing Drive data before uploading so no device loses its apps.
 *  Cleans up duplicate files, keeping only the most recently modified one. */
async function uploadToDrive(accessToken: string, backupJson: string): Promise<boolean> {
    try {
        // Files are sorted modifiedTime DESC — [0] is the most recent (canonical)
        const existing = await listDriveFiles(accessToken);

        // Merge local data with remote Drive data before uploading
        let dataToUpload = backupJson;
        if (existing.length > 0) {
            const remoteData = await downloadFromDrive(accessToken);
            if (remoteData && remoteData.apps && remoteData.apps.length > 0) {
                const localData = JSON.parse(backupJson) as BackupData;
                const merged = mergeBackups(localData, remoteData);
                dataToUpload = JSON.stringify(merged);
                console.log(`[BackupSync] Merged local ${localData.apps.length} + remote ${remoteData.apps.length} apps → ${merged.apps.length} unique`);
            }
        }

        // Delete all duplicates (keep [0], delete the rest)
        if (existing.length > 1) {
            console.log(`[BackupSync] Cleaning up ${existing.length - 1} duplicate Drive file(s)`);
            await Promise.all(existing.slice(1).map(f => deleteDriveFile(accessToken, f.id)));
        }

        let url: string;
        let method: string;
        let metadata: object;

        if (existing.length > 0) {
            url = `${DRIVE_UPLOAD_API}/files/${existing[0].id}?uploadType=multipart`;
            method = 'PATCH';
            metadata = { name: BACKUP_FILENAME };
        } else {
            url = `${DRIVE_UPLOAD_API}/files?uploadType=multipart`;
            method = 'POST';
            metadata = { name: BACKUP_FILENAME, parents: ['appDataFolder'] };
        }

        const boundary = '===appacadabra_boundary===';
        const body =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            `${JSON.stringify(metadata)}\r\n` +
            `--${boundary}\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            `${dataToUpload}\r\n` +
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
    if (!isGoogleUser()) return false;
    const token = await requestGoogleScopes([DRIVE_SCOPE]);
    if (!token) return false;
    const files = await listDriveFiles(token);
    return files.length > 0;
}

// ─── Local folder backend (Android SAF) ─────────────────────────────

// Matches appacadabra_backup.spell, .spell.json (Android appends mime ext), and suffixed variants
const BACKUP_FILE_REGEX = /appacadabra_backup(\s\(\d+\))?\.spell(\.json)?$/i;

/** Write backup to a SAF directory, cleaning up duplicate/suffixed files first */
async function writeToLocalFolder(folderUri: string, backupJson: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        const SAF = FileSystem.StorageAccessFramework;
        const files = await SAF.readDirectoryAsync(folderUri);
        const backupFiles = files.filter(f => BACKUP_FILE_REGEX.test(f));

        // Delete all duplicates/suffixed variants, keeping only the exact-name file
        if (backupFiles.length > 1) {
            const exact = backupFiles.find(f => f.endsWith(BACKUP_FILENAME));
            const toDelete = exact ? backupFiles.filter(f => f !== exact) : backupFiles.slice(1);
            console.log(`[BackupSync] Cleaning up ${toDelete.length} duplicate local backup file(s)`);
            await Promise.all(toDelete.map(f => SAF.deleteAsync(f).catch(() => { })));
        }

        const remainingFiles = await SAF.readDirectoryAsync(folderUri);
        const existingFile = remainingFiles.find(f => f.endsWith(BACKUP_FILENAME));

        if (existingFile) {
            await FileSystem.writeAsStringAsync(existingFile, backupJson, {
                encoding: FileSystem.EncodingType.UTF8,
            });
        } else {
            const fileUri = await SAF.createFileAsync(folderUri, BACKUP_FILENAME, 'application/octet-stream');
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

        const backupFile = files.find(f => BACKUP_FILE_REGEX.test(decodeURIComponent(f)));
        if (!backupFile) {
            console.log('[BackupSync] No backup file found in local folder (checked URI regex)');
            return null;
        }
        console.log('[BackupSync] Reading local backup file:', backupFile);

        const text = await readBackupFile(backupFile);

        const trimmed = text.trim();
        console.log('[BackupSync] Local file read success, length:', text.length, 'Trimmed length:', trimmed.length);
        console.log('[BackupSync] Content prefix (100 chars):', trimmed.substring(0, 100));
        console.log('[BackupSync] Content suffix (100 chars):', trimmed.substring(trimmed.length - 100));

        try {
            return JSON.parse(trimmed) as BackupData;
        } catch (e) {
            console.error('[BackupSync] JSON Parse Error:', (e as any).message);
            // Don't auto-delete yet, we need to debug why it's failing
            return null;
        }
    } catch (e) {
        console.error('[BackupSync] Local folder read error:', e);
        return null;
    }
}

/** Check if the local folder is accessible and contains a backup */
export async function checkLocalBackupExists(folderUri: string): Promise<boolean> {
    if (Platform.OS !== 'android') return false;
    try {
        console.log('[BackupSync] checkLocalBackupExists: reading dir', folderUri);
        const SAF = FileSystem.StorageAccessFramework;
        const files = await SAF.readDirectoryAsync(folderUri);
        const exists = files.some(f => BACKUP_FILE_REGEX.test(decodeURIComponent(f)));
        console.log('[BackupSync] checkLocalBackupExists result:', exists, 'files count:', files.length);
        return exists;
    } catch (e) {
        console.warn('[BackupSync] checkLocalBackupExists failed:', e);
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
            if (!isGoogleUser()) {
                console.log('[BackupSync] Skipping Drive backup: user is not logged in with Google');
                return false;
            }
            const token = await requestGoogleScopes([DRIVE_SCOPE]);
            if (!token) {
                console.warn('[BackupSync] No access token for Drive backup');
                return false;
            }
            success = await uploadToDrive(token, backupJson);
        } else if (backupMode === 'local_folder' && localFolderUri) {
            let dataToWrite = backupJson;
            const existingData = await readFromLocalFolder(localFolderUri);
            if (existingData && existingData.apps && existingData.apps.length > 0) {
                const merged = mergeBackups(backupData, existingData);
                dataToWrite = JSON.stringify(merged);
                console.log(`[BackupSync] Merged local ${backupData.apps.length} + folder ${existingData.apps.length} apps → ${merged.apps.length} unique`);
            }
            success = await writeToLocalFolder(localFolderUri, dataToWrite);
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
    const { backupMode, localFolderUri, markRestoreDone, setIsRestoring } = useBackupStore.getState();

    if (_writeLock) {
        console.warn('[BackupSync] Write locked, cannot restore now');
        return { success: false, count: 0 };
    }

    _writeLock = true;
    setIsRestoring(true);
    console.log('[BackupSync] performRestore: starting (mode:', backupMode, ')');
    try {
        let backupData: BackupData | null = null;

        if (backupMode === 'google_drive') {
            if (!isGoogleUser()) {
                console.log('[BackupSync] Skipping Drive restore: user is not logged in with Google');
                return { success: false, count: 0 };
            }
            const token = await requestGoogleScopes([DRIVE_SCOPE]);
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
        setIsRestoring(false);
    }
}

/** Try to restore on login (called after Google auth transition) */
export async function tryRestoreOnLogin(): Promise<'restored' | 'no_backup' | 'local_missing' | 'error'> {
    const { backupMode, localFolderUri } = useBackupStore.getState();

    if (!backupMode || backupMode === 'none') return 'no_backup';

    if (backupMode === 'google_drive') {
        // First attempt
        let exists = await checkDriveBackupExists();
        if (!exists) {
            // Token might not be ready yet — retry once after delay
            console.log('[BackupSync] Drive backup not found, retrying in 2s...');
            await new Promise(r => setTimeout(r, 2000));
            exists = await checkDriveBackupExists();
        }
        if (!exists) return 'no_backup';
        const result = await performRestore();
        return result.success ? 'restored' : 'error';
    }

    if (backupMode === 'local_folder') {
        if (!localFolderUri) {
            console.log('[BackupSync] tryRestoreOnLogin: local_folder but no URI');
            return 'local_missing';
        }
        const exists = await checkLocalBackupExists(localFolderUri);
        if (!exists) {
            console.log('[BackupSync] tryRestoreOnLogin: local backup file not found at', localFolderUri);
            return 'local_missing';
        }
        const result = await performRestore();
        console.log('[BackupSync] tryRestoreOnLogin: local restore result:', result);
        return result.success ? 'restored' : 'error';
    }

    return 'no_backup';
}

// ─── Legacy alias (backward compat) ────────────────────────────────
/** @deprecated Use `markBackupDirty()` instead */
export const autoBackupAfterChange = markBackupDirty;
