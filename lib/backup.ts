import { Paths, File, Directory } from 'expo-file-system/next';
import * as DocumentPicker from 'expo-document-picker';
import * as Sharing from 'expo-sharing';
import { GeneratedApp, AppVersion } from './database/types';
import * as db from './database/db';

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
    // Android nested format
    versions?: { version: number; code: string; instruction: string; selectedContext: string; createdAt: number }[];
    localStorage?: Record<string, string>;
}

export async function createBackup(): Promise<BackupData> {
    const apps = await db.getAllApps();
    const backupApps: BackupApp[] = [];

    for (const app of apps) {
        const versions = await db.getVersionsForApp(app.id);
        const storageItems = await db.getStorageForApp(app.id);

        // Create localStorage object
        const localStorage: Record<string, string> = {};
        storageItems.forEach(s => {
            localStorage[s.key] = s.value;
        });

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
            versions: versions.map(v => ({
                version: v.version,
                code: v.code,
                instruction: v.instruction || '',
                selectedContext: v.selectedContext || '',
                createdAt: v.createdAt,
            })),
            localStorage,
        });
    }

    return {
        version: 2,
        createdAt: Date.now(),
        apps: backupApps,
    };
}

export async function exportBackup(): Promise<boolean> {
    try {
        const backup = await createBackup();
        const json = JSON.stringify(backup, null, 2);

        const filename = `appacadabra_backup_${Date.now()}.json`;
        const file = new File(Paths.cache, filename);

        await file.write(json);

        if (await Sharing.isAvailableAsync()) {
            await Sharing.shareAsync(file.uri, {
                mimeType: 'application/json',
                dialogTitle: 'Exportar Backup',
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

export async function importBackup(): Promise<{ success: boolean; count: number; message: string }> {
    try {
        const result = await DocumentPicker.getDocumentAsync({
            type: 'application/json',
            copyToCacheDirectory: true,
        });

        if (result.canceled || !result.assets?.[0]) {
            return { success: false, count: 0, message: 'Importação cancelada' };
        }

        const fileUri = result.assets[0].uri;
        const file = new File(fileUri);
        const json = await file.text();
        const backup: BackupData = JSON.parse(json);

        if (!backup.apps || !Array.isArray(backup.apps)) {
            return { success: false, count: 0, message: 'Arquivo de backup inválido' };
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
            message: `${importedCount} apps importados com sucesso!`
        };
    } catch (error) {
        console.error('Import backup error:', error);
        return {
            success: false,
            count: 0,
            message: `Erro ao importar: ${error instanceof Error ? error.message : 'Erro desconhecido'}`
        };
    }
}
