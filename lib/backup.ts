import { Paths, File, Directory } from 'expo-file-system/next';
import { readAsStringAsync, copyAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import * as Notifications from 'expo-notifications';
import { GeneratedApp, AppVersion, NewGeneratedApp } from './database/types';
import * as db from './database/db';
import { reloadStorageForApp } from './storageCache';
import { t } from './i18n';


export interface BackupData {
    version: number;
    exportedAt?: number;
    createdAt?: number;
    apps: BackupApp[];
    // New format (React Native)
    versions?: Record<number, AppVersion[]>;
    storage?: Record<number, { key: string; value: string }[]>;

}

// Android format has versions and localStorage inside each app
export interface BackupApp {
    id: number;
    name: string;
    code: string;
    currentVersion: number;
    iconPath?: string;
    iconBase64?: string; // Base64 encoded icon for backup portability
    lastUpdated: number;
    createdAt?: number;
    consoleLogs?: string;
    totalManaCost?: number;
    jobId?: string;
    shortDescription?: string;
    sortOrder?: number;
    requiresBiometric?: boolean;
    // Individual mana charge events with original timestamps
    manaEvents?: { amount: number; timestamp: number }[];
    // Scheduled notifications (absolute fire timestamps)
    notifications?: { identifier: string; title: string; body: string; fireDate: number }[];
    // Android nested format
    versions?: { version: number; code: string; instruction: string; selectedContext: string; createdAt: number; jobId?: string }[];
    localStorage?: Record<string, string>;
}

export async function createBackup(includeStorage: boolean = true, targetAppId?: number): Promise<BackupData> {
    let apps: GeneratedApp[];
    if (targetAppId) {
        const app = await db.getAppById(targetAppId);
        apps = app ? [app] : [];
    } else {
        apps = await db.getAllApps();
    }

    const backupApps: BackupApp[] = [];

    for (const app of apps) {
        // Only fetch last 5 versions to keep backup size manageable and avoid OOM
        const versions = includeStorage ? (await db.getVersionsForApp(app.id)).slice(0, 5) : [];

        // Only get storage if includeStorage is true
        let localStorage: Record<string, string> = {};
        if (includeStorage) {
            const storageItems = await db.getStorageForApp(app.id);
            storageItems.forEach(s => {
                localStorage[s.key] = s.value;
            });
        }

        // Collect scheduled notifications for this app
        let notifications: { identifier: string; title: string; body: string; fireDate: number }[] = [];
        // Collect mana events for this app
        let manaEvents: { amount: number; timestamp: number }[] = [];
        if (includeStorage) {
            try {
                const allNotifs = await Notifications.getAllScheduledNotificationsAsync();
                const now = Date.now();
                allNotifs.forEach(n => {
                    const content = n.content as any;
                    const isThisApp =
                        content.channelId === `spell-${app.id}` ||
                        String(content.data?.appId) === String(app.id) ||
                        content.badge === Number(app.id);
                    if (!isThisApp) return;
                    // Compute absolute fire date from timeInterval trigger
                    let fireDate = 0;
                    const trigger = n.trigger as any;
                    if (trigger?.seconds) fireDate = now + trigger.seconds * 1000;
                    else if (trigger?.timestamp) fireDate = trigger.timestamp;
                    else if (trigger?.value) fireDate = trigger.value;
                    if (fireDate > now) {
                        notifications.push({
                            identifier: n.identifier,
                            title: content.title || '',
                            body: content.body || '',
                            fireDate,
                        });
                    }
                });
            } catch (e) {
                console.warn('Failed to read notifications for backup:', e);
            }

            try {
                const dbInst = await db.getDatabase();
                const rows = await dbInst.getAllAsync<{ amount: number; timestamp: number }>(
                    'SELECT amount, timestamp FROM mana_events WHERE appId = ? ORDER BY timestamp ASC',
                    [app.id]
                );
                manaEvents = rows;
            } catch (e) {
                console.warn('Failed to read mana events for backup:', e);
            }
        }

        // Convert icon to base64 if exists
        let iconBase64: string | undefined;
        if (app.iconPath) {
            try {
                const iconFile = new File(app.iconPath);
                if (iconFile.exists) {
                    iconBase64 = await iconFile.base64();
                }
            } catch (e) {
                console.warn('Failed to read icon for backup:', e);
            }
        }

        backupApps.push({
            id: app.id,
            name: app.name,
            code: app.code,
            currentVersion: app.currentVersion,
            iconBase64,
            lastUpdated: app.lastUpdated,
            createdAt: includeStorage ? app.createdAt : undefined,
            consoleLogs: includeStorage ? (app.consoleLogs || '') : undefined,
            totalManaCost: includeStorage ? (app.totalManaCost || 0) : undefined,
            shortDescription: app.shortDescription,
            sortOrder: app.sortOrder || 0,
            requiresBiometric: app.requiresBiometric || false,
            manaEvents: manaEvents.length > 0 ? manaEvents : undefined,
            notifications: notifications.length > 0 ? notifications : undefined,
            versions: versions.length > 0 ? versions.map(v => ({
                version: v.version,
                code: v.code,
                instruction: v.instruction || '',
                selectedContext: v.selectedContext || '',
                createdAt: v.createdAt,
            })) : undefined,
            localStorage: includeStorage ? localStorage : undefined,
        });
    }

    return {
        version: 2,
        exportedAt: Date.now(),
        createdAt: Date.now(),
        apps: backupApps,
    };
}

/**
 * Global Backup - Always includes data (localStorage)
 */
export async function exportBackup(): Promise<boolean> {
    try {
        const backup = await createBackup(true); // Always include storage
        const json = JSON.stringify(backup, null, 2);

        const filename = `appacadabra_backup_${Date.now()}.json`;
        const file = new File(Paths.cache, filename);

        await file.write(json);

        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(file.uri, {
                mimeType: 'application/json',
                dialogTitle: t('exportBackupDialog'),
                UTI: 'public.json',
            });
            return true;
        } else {
            console.error('Sharing not available');
            return false;
        }
    } catch (error) {
        console.error('Export backup error:', error);
        return false;
    }
}

/**
 * Share Single App - Never includes data (Clean export)
 */
export async function exportSingleApp(appId: number): Promise<boolean> {
    try {
        const backup = await createBackup(false, appId); // Never include storage
        if (backup.apps.length === 0) return false;

        const appName = backup.apps[0].name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const json = JSON.stringify(backup, null, 2);

        const filename = `${appName}.spell`;
        const file = new File(Paths.cache, filename);

        await file.write(json);

        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(file.uri, {
                mimeType: 'application/json', // application/json for better compatibility
                dialogTitle: `Share ${backup.apps[0].name}`,
                UTI: 'public.json', // iOS Uniform Type Identifier
            });
            return true;
        } else {
            return false;
        }
    } catch (error) {
        console.error('Export single app error:', error);
        return false;
    }
}

/**
 * Helper to read a backup file from a URI (handles content:// and file://)
 */
export async function readBackupFile(fileUri: string): Promise<string> {
    // Use FileSystem logic to handle content:// URIs safely
    try {
        // Try reading as string directly (works for content:// on Android often)
        return await readAsStringAsync(fileUri);
    } catch (readError) {
        console.log('FileSystem read failed, trying URI conversion or cache copy...', readError);
        // Fallback 1: try to copy to cache if it's a content URI that failed reading
        try {
            if (fileUri.startsWith('content://')) {
                const cachePath = (cacheDirectory || Paths.cache) + 'temp_import.json';
                await copyAsync({ from: fileUri, to: cachePath });
                return await readAsStringAsync(cachePath);
            } else {
                throw readError;
            }
        } catch (copyError) {
            console.log('FileSystem copy failed, trying fetch workaround...', copyError);
            // Fallback 2: Use fetch API (works for some content:// providers via Blob)
            if (fileUri.startsWith('content://') || fileUri.startsWith('file://')) {
                const response = await fetch(fileUri);
                if (response.ok) {
                    return await response.text();
                } else {
                    throw new Error(`Fetch failed with status ${response.status}`);
                }
            } else {
                throw copyError; // Throw original copy error if fetch not applicable
            }
        }
    }
}

/**
 * Peek at a backup file to get its metadata (name, count) without importing
 */
export async function peekBackupMetadata(uri: string): Promise<{ name: string; shortDescription?: string; iconBase64?: string; count: number; version: number } | null> {
    try {
        const json = await readBackupFile(uri);
        const backup: BackupData = JSON.parse(json);

        if (!backup || !backup.apps || !Array.isArray(backup.apps) || backup.apps.length === 0) {
            return null;
        }

        const firstApp = backup.apps[0];
        const count = backup.apps.length;
        // Use the first app's name, or a generic name if multiple?
        // Usually .spell files are single apps.
        const name = count > 1 ? `${firstApp.name} (+${count - 1})` : firstApp.name;

        return {
            name,
            shortDescription: firstApp.shortDescription || undefined,
            iconBase64: firstApp.iconBase64 || undefined,
            count,
            version: backup.version
        };
    } catch (error) {
        console.warn('Failed to peek backup metadata:', error);
        return null;
    }
}

export async function importBackup(existingUri?: string): Promise<{ success: boolean; count: number; message: string }> {
    try {
        let fileUri = existingUri;

        if (!fileUri) {
            const result = await DocumentPicker.getDocumentAsync({
                type: ['application/json', 'text/plain'],
                copyToCacheDirectory: true,
            });

            if (result.canceled || !result.assets?.[0]) {
                return { success: false, count: 0, message: t('importCancelled') };
            }
            fileUri = result.assets[0].uri;
        }

        const json = await readBackupFile(fileUri);
        const backup: BackupData = JSON.parse(json);
        return await processBackupData(backup);
    } catch (error) {
        console.error('Import backup error:', error);
        return {
            success: false,
            count: 0,
            message: `${t('importError')} ${error instanceof Error ? error.message : t('unknownError')}`
        };
    }
}

/**
 * Process raw backup data and insert into DB
 */
export async function processBackupData(backup: BackupData): Promise<{ success: boolean; count: number; message: string }> {
    try {
        console.log('Parsed backup apps count:', backup?.apps?.length);

        if (!backup || !backup.apps || !Array.isArray(backup.apps)) {
            return { success: false, count: 0, message: t('invalidBackupFile') };
        }

        // Pre-validate critical fields to avoid partial imports or crashes
        const validApps = backup.apps.filter(app => {
            const isValid = app && typeof app.name === 'string' && typeof app.code === 'string';
            if (!isValid) console.warn('Skipping invalid app in backup:', app);
            return isValid;
        });

        if (validApps.length === 0 && backup.apps.length > 0) {
            return { success: false, count: 0, message: t('invalidBackupFile') };
        }

        // Deduplication: skip apps whose name already exists locally
        const existingApps = await db.getAllApps();
        const existingNames = new Set(existingApps.map(a => a.name));
        console.log('[Backup] Existing apps count:', existingApps.length, 'Existing names:', Array.from(existingNames));

        let importedCount = 0;
        let skippedCount = 0;

        for (const app of validApps) {
            if (existingNames.has(app.name)) {
                console.log('[Backup] App already exists, updating sortOrder only:', app.name);
                const existing = existingApps.find(a => a.name === app.name);
                if (existing && app.sortOrder !== undefined) {
                    await db.updateApp({ ...existing, sortOrder: app.sortOrder });
                }
                skippedCount++;
                continue;
            }
            const originalId = app.id;

            // Restore icon from base64 if present
            let iconPath: string | null = null;
            if (app.iconBase64) {
                try {
                    const iconFilename = `icon_${Date.now()}_${originalId}.png`;
                    const iconsDir = new Directory(Paths.document, 'icons');
                    const iconsFileCheck = new File(Paths.document, 'icons');

                    // Check if 'icons' exists as a file and delete it if so
                    if (iconsFileCheck.exists) {
                        try {
                            // Try to read it to see if it's a file? 
                            // Or just force delete and recreate as directory to be safe
                            // If it's a directory, this might throw, so we catch
                            await iconsFileCheck.delete();
                        } catch (e) {
                            // If delete fails, it might be a non-empty directory or system issue
                            console.log('Could not delete icons path, assuming it is a directory', e);
                        }
                    }

                    // Create directory if it doesn't exist
                    if (!iconsDir.exists) {
                        iconsDir.create();
                    }

                    // Write icon file from base64
                    const iconFile = new File(iconsDir, iconFilename);
                    await iconFile.write(app.iconBase64, { encoding: 'base64' });
                    iconPath = iconFile.uri;
                } catch (e) {
                    console.warn('Failed to restore icon from base64:', e);
                }
            }

            // If it's a full backup, it will have createdAt. Otherwise (like a .spell single export), we treat it as new.
            const isFullBackup = app.createdAt !== undefined;
            const now = Date.now();

            // Insert app with new ID
            const newApp: NewGeneratedApp = {
                name: app.name,
                code: app.code,
                currentVersion: app.currentVersion,
                iconPath,
                lastUpdated: isFullBackup ? app.lastUpdated : now,
                createdAt: isFullBackup ? app.createdAt! : now,
                consoleLogs: app.consoleLogs || '',
                totalManaCost: app.totalManaCost || 0,
                jobId: app.jobId || undefined,
                requiresBiometric: app.requiresBiometric || false,
                shortDescription: app.shortDescription || undefined,
                sortOrder: app.sortOrder || 0,
            };

            const newId = await db.insertApp(newApp);

            // Import versions - check BOTH formats
            // 1. Android format: versions inside app object
            // 2. New format: versions at top level keyed by originalId
            const versions = app.versions || backup.versions?.[originalId] || [];
            if (versions.length > 0) {
                for (const version of versions) {
                    await db.insertVersion({
                        appId: newId,
                        version: version.version,
                        code: version.code,
                        instruction: version.instruction || null,
                        selectedContext: version.selectedContext || null,
                        createdAt: version.createdAt,
                    });
                }
            } else {
                // Shared spell without history — create import snapshot so user has a restore point
                await db.insertVersion({
                    appId: newId,
                    version: newApp.currentVersion,
                    code: app.code,
                    instruction: '📥 ' + t('shareImportSpell'),
                    selectedContext: null,
                    createdAt: Date.now(),
                });
            }

            // Import storage - check BOTH formats
            // 1. Android format: localStorage object inside app
            // 2. New format: storage at top level keyed by originalId
            if (app.localStorage && typeof app.localStorage === 'object') {
                // Android format: { key: value, ... }
                for (const [key, value] of Object.entries(app.localStorage)) {
                    if (typeof value === 'string') {
                        await db.setStorageItem(newId, key, value);
                    }
                }
            } else if (backup.storage?.[originalId]) {
                // New format: [{ key, value }, ...]
                for (const item of backup.storage[originalId]) {
                    await db.setStorageItem(newId, item.key, item.value);
                }
            }

            // Sync cache so RunnerApp sees the data immediately
            try {
                await reloadStorageForApp(newId);
            } catch (e) {
                console.warn('Failed to reload storage cache after import:', e);
            }

            // Restore mana events preserving original timestamps so recentManaCost
            // is computed correctly based on the original spell creation date.
            const eventsToRestore: { appId: number; amount: number; timestamp: number }[] = [];
            if (app.manaEvents && app.manaEvents.length > 0) {
                // Use real per-event history from the backup
                for (const ev of app.manaEvents) {
                    eventsToRestore.push({ appId: newId, amount: ev.amount, timestamp: ev.timestamp });
                }
            } else if ((app.totalManaCost ?? 0) > 0) {
                // Legacy backup without per-event data — create one synthetic event
                // at the original createdAt so the windowed query can still find it
                eventsToRestore.push({
                    appId: newId,
                    amount: app.totalManaCost!,
                    timestamp: app.createdAt || app.lastUpdated,
                });
            }
            if (eventsToRestore.length > 0) {
                try { await db.insertManaEvents(eventsToRestore); } catch (e) {
                    console.warn('Failed to restore mana events:', e);
                }
            }

            // Restore scheduled notifications with recalculated delays
            if (app.notifications && app.notifications.length > 0) {
                const now = Date.now();
                // Ensure the notification channel exists for the new app ID
                try {
                    await Notifications.setNotificationChannelAsync(`spell-${newId}`, {
                        name: app.name,
                        importance: Notifications.AndroidImportance.HIGH,
                        vibrationPattern: [0, 250, 250, 250],
                        lightColor: '#FF9500',
                    });
                } catch { /* channel creation is best-effort */ }

                for (const notif of app.notifications) {
                    const secondsUntilFire = Math.round((notif.fireDate - now) / 1000);
                    if (secondsUntilFire < 10) continue; // skip already-past or imminent
                    try {
                        await Notifications.scheduleNotificationAsync({
                            content: {
                                title: notif.title,
                                body: notif.body,
                                channelId: `spell-${newId}`,
                                badge: newId,
                            } as any,
                            trigger: {
                                type: 'timeInterval',
                                seconds: secondsUntilFire,
                                repeats: false,
                            } as any,
                        });
                    } catch (e) {
                        console.warn('Failed to restore notification:', e);
                    }
                }
            }

            importedCount++;
        }

        console.log('[Backup] Process finished. Imported:', importedCount, 'Skipped:', skippedCount);
        return {
            success: true,
            count: importedCount,
            message: `${importedCount} ${t('appsImportedSuccess')}`
        };
    } catch (error) {
        console.error('Process backup error:', error);
        return {
            success: false,
            count: 0,
            message: `${t('importError')} ${error instanceof Error ? error.message : t('unknownError')}`
        };
    }
}

/**
 * Import the built-in demo spell
 */
export async function importDemoSpell(): Promise<{ success: boolean; count: number; message: string }> {
    try {
        // Require the JSON file directly (metro bundler handles this)
        const demoData = require('../assets/demo_universe.json');
        return await processBackupData(demoData as BackupData);
    } catch (error) {
        console.error('Demo import error:', error);
        return {
            success: false,
            count: 0,
            message: t('importError') + ' (Demo)'
        };
    }
}
