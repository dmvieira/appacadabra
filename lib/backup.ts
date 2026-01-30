import { Paths, File, Directory } from 'expo-file-system/next';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { GeneratedApp, AppVersion } from './database/types';
import * as db from './database/db';
import { t } from './i18n';
import { useManaStore } from './manaStore';
import { signData, verifyData } from './security';

export interface BackupData {
    version: number;
    exportedAt?: number;
    createdAt?: number;
    apps: BackupApp[];
    // New format (React Native)
    versions?: Record<number, AppVersion[]>;
    storage?: Record<number, { key: string; value: string }[]>;
    // Mana System
    mana?: {
        amount: number;
        signature: string;
    };
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
    // Android nested format
    versions?: { version: number; code: string; instruction: string; selectedContext: string; createdAt: number }[];
    localStorage?: Record<string, string>;
}

export async function createBackup(includeStorage: boolean = true): Promise<BackupData> {
    const apps = await db.getAllApps();
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
            totalManaCost: app.totalManaCost || 0,
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

    // Add Mana with signature for integrity
    let manaData: { amount: number; signature: string } | undefined;
    try {
        const balance = useManaStore.getState().balance;
        const signature = await signData(balance.toString());
        if (signature) {
            manaData = { amount: balance, signature };
        }
    } catch (e) {
        console.warn('Failed to sign mana for backup:', e);
    }

    return {
        version: 2,
        createdAt: Date.now(),
        apps: backupApps,
        mana: manaData,
    };
}
export async function exportBackup(includeStorage: boolean = true): Promise<boolean> {
    try {
        const backup = await createBackup(includeStorage);
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

        const file = new File(fileUri);
        const json = await file.text();
        const backup: BackupData = JSON.parse(json);

        if (!backup.apps || !Array.isArray(backup.apps)) {
            return { success: false, count: 0, message: t('invalidBackupFile') };
        }

        let importedCount = 0;

        for (const app of backup.apps) {
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
            const newApp = {
                name: app.name,
                code: app.code,
                currentVersion: app.currentVersion,
                iconPath,
                lastUpdated: app.lastUpdated,
                consoleLogs: app.consoleLogs || '',
                totalManaCost: app.totalManaCost || 0,
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

        // Restore Mana if valid
        if (backup.mana && typeof backup.mana.amount === 'number' && backup.mana.signature) {
            const isValid = await verifyData(backup.mana.amount.toString(), backup.mana.signature);
            if (isValid) {
                console.log('Restoring verified mana:', backup.mana.amount);
                // We trust the backup as it is signed by us
                // We replace the current balance or add to it? 
                // Usually Restore replaces state. Let's replace.
                useManaStore.getState().setBalance(backup.mana.amount);
            } else {
                console.warn('Mana signature invalid! Ignoring mana from backup.');
                // We could alert the user here, but we are inside an async function returning a simple status object.
                // We'll proceed with app import but skip mana.
            }
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
