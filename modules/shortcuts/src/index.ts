import { requireNativeModule } from 'expo-modules-core';

const ShortcutsModule = requireNativeModule('Shortcuts');

export interface ShortcutItem {
    id: string;
    name: string;
    iconPath?: string | null;
}

export function createShortcut(id: string, name: string, iconPath: string | null): Promise<boolean> {
    return ShortcutsModule.createShortcut(id, name, iconPath);
}

export function setDynamicShortcuts(items: ShortcutItem[]): Promise<void> {
    return ShortcutsModule.setDynamicShortcuts(items);
}

export function launchApp(id: string): Promise<void> {
    return ShortcutsModule.launchApp(id);
}
