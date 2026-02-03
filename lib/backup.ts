import { Paths, File, Directory } from 'expo-file-system/next';
import { readAsStringAsync, copyAsync, cacheDirectory } from 'expo-file-system/legacy';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { GeneratedApp, AppVersion, NewGeneratedApp } from './database/types';
import * as db from './database/db';
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
interface BackupApp {
    id: number;
    name: string;
    code: string;
    currentVersion: number;
    iconPath?: string;
    iconBase64?: string; // Base64 encoded icon for backup portability
    lastUpdated: number;
    consoleLogs?: string;
    totalManaCost?: number;
    jobId?: string; // Add this
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
        const versions = await db.getVersionsForApp(app.id);

        // Only get storage if includeStorage is true
        let localStorage: Record<string, string> = {};
        if (includeStorage) {
            const storageItems = await db.getStorageForApp(app.id);
            storageItems.forEach(s => {
                localStorage[s.key] = s.value;
            });
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
            consoleLogs: app.consoleLogs || '',
            totalManaCost: includeStorage ? (app.totalManaCost || 0) : undefined,
            versions: versions.map(v => ({
                version: v.version,
                code: v.code,
                instruction: v.instruction || '',
                selectedContext: v.selectedContext || '',
                createdAt: v.createdAt,
            })),
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
                mimeType: 'application/vnd.appacadabra.spell', // Custom MIME type for better intent handling
                dialogTitle: `Share ${backup.apps[0].name}`,
                UTI: 'com.appacadabra.spell', // iOS Uniform Type Identifier (would need config in Info.plist too)
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

        // Use FileSystem logic to handle content:// URIs safely
        let json: string;
        try {
            // Try reading as string directly (works for content:// on Android often)
            json = await readAsStringAsync(fileUri);
        } catch (readError) {
            console.log('FileSystem read failed, trying URI conversion or cache copy...', readError);
            // Fallback 1: try to copy to cache if it's a content URI that failed reading
            try {
                if (fileUri.startsWith('content://')) {
                    const cachePath = (cacheDirectory || Paths.cache) + 'temp_import.json';
                    await copyAsync({ from: fileUri, to: cachePath });
                    json = await readAsStringAsync(cachePath);
                } else {
                    throw readError;
                }
            } catch (copyError) {
                console.log('FileSystem copy failed, trying fetch workaround...', copyError);
                // Fallback 2: Use fetch API (works for some content:// providers via Blob)
                if (fileUri.startsWith('content://') || fileUri.startsWith('file://')) {
                    const response = await fetch(fileUri);
                    if (response.ok) {
                        json = await response.text();
                    } else {
                        throw new Error(`Fetch failed with status ${response.status}`);
                    }
                } else {
                    throw copyError; // Throw original copy error if fetch not applicable
                }
            }
        }

        const backup: BackupData = JSON.parse(json);
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

        let importedCount = 0;

        for (const app of validApps) {
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

            // Insert app with new ID
            const newApp: NewGeneratedApp = {
                name: app.name,
                code: app.code,
                currentVersion: app.currentVersion,
                iconPath,
                lastUpdated: app.lastUpdated,
                consoleLogs: app.consoleLogs || '',
                totalManaCost: app.totalManaCost || 0,
                jobId: app.jobId || undefined,
                requiresBiometric: false, // Imported apps start unlocked
            };

            const newId = await db.insertApp(newApp);

            // Import versions - check BOTH formats
            // 1. Android format: versions inside app object
            // 2. New format: versions at top level keyed by originalId
            const versions = app.versions || backup.versions?.[originalId] || [];
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

            importedCount++;
        }



        return {
            success: true,
            count: importedCount,
            message: `${importedCount} ${t('appsImportedSuccess')}`
        };
    } catch (error) {
        console.error('Import backup error:', error);
        return {
            success: false,
            count: 0,
            message: `${t('importError')} ${error instanceof Error ? error.message : t('unknownError')}`
        };
    }
}
