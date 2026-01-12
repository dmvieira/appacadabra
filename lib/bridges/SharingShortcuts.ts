import { NativeModules, Platform } from 'react-native';

const { SharingShortcuts } = NativeModules;

export interface SharingShortcutsInterface {
    publishShortcut(id: string, name: string, iconUri?: string | null): Promise<boolean>;
    removeShortcut(id: string): Promise<boolean>;
    removeAllShortcuts(): Promise<boolean>;
    getMaxShortcutCount(): Promise<number>;
}

// Create a wrapper that handles platform differences
const SharingShortcutsWrapper: SharingShortcutsInterface = {
    async publishShortcut(id: string, name: string, iconUri?: string | null): Promise<boolean> {
        if (!SharingShortcuts) {
            console.log('SharingShortcuts: Not available');
            return false;
        }
        try {
            return await SharingShortcuts.publishShortcut(id, name, iconUri || null);
        } catch (error) {
            console.error('SharingShortcuts.publishShortcut error:', error);
            return false;
        }
    },

    async removeShortcut(id: string): Promise<boolean> {
        if (!SharingShortcuts) {
            return false;
        }
        try {
            return await SharingShortcuts.removeShortcut(id);
        } catch (error) {
            console.error('SharingShortcuts.removeShortcut error:', error);
            return false;
        }
    },

    async removeAllShortcuts(): Promise<boolean> {
        if (!SharingShortcuts) {
            return false;
        }
        try {
            return await SharingShortcuts.removeAllShortcuts();
        } catch (error) {
            console.error('SharingShortcuts.removeAllShortcuts error:', error);
            return false;
        }
    },

    async getMaxShortcutCount(): Promise<number> {
        if (!SharingShortcuts) {
            return 0;
        }
        try {
            return await SharingShortcuts.getMaxShortcutCount();
        } catch (error) {
            console.error('SharingShortcuts.getMaxShortcutCount error:', error);
            return 0;
        }
    },
};

export default SharingShortcutsWrapper;
