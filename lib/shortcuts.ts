import { createShortcut as createNativeShortcut, setDynamicShortcuts as setNativeDynamicShortcuts, ShortcutItem } from 'shortcuts';
import { Platform, Alert } from 'react-native';

export const createShortcut = async (id: number | string, name: string, iconPath: string | null): Promise<boolean> => {
    try {
        const result = await createNativeShortcut(id.toString(), name, iconPath);
        return result;
    } catch (e) {
        console.error('Failed to create shortcut:', e);
        Alert.alert('Erro', 'Não foi possível criar o atalho: ' + (e instanceof Error ? e.message : 'Erro desconhecido'));
        return false;
    }
};

export const launchApp = async (id: number | string): Promise<void> => {
    if (Platform.OS === 'web') return;
    try {
        await import('shortcuts').then(m => m.launchApp(id.toString()));
    } catch (e) {
        console.error('Failed to launch app natively:', e);
    }
};

export const updateDynamicShortcuts = async (apps: { id: number | string; name: string; iconPath?: string | null }[]) => {
    if (Platform.OS === 'web') return;

    try {
        const items: ShortcutItem[] = apps.slice(0, 4).map(app => ({
            id: app.id.toString(),
            name: app.name,
            iconPath: app.iconPath || null
        }));

        await setNativeDynamicShortcuts(items);
    } catch (e) {
        console.error('Failed to update dynamic shortcuts:', e);
    }
};
