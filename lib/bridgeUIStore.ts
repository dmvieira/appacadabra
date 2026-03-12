import { create } from 'zustand';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ManaOperationType = 'generate' | 'image' | 'video' | 'audio' | 'similarity';

interface ManaConfirmRequest {
    appId: number | null;
    operationType: ManaOperationType;
    costEstimate: string;
    resolve: (confirmed: boolean) => void;
}

interface BridgeUIState {
    isScannerOpen: boolean;
    scannerCallback: string | null;
    webViewRef: React.RefObject<WebView> | null;
    isNativeActivityActive: boolean;
    manaConfirmRequest: ManaConfirmRequest | null;
    openScanner: (callback: string) => void;
    closeScanner: (scannedData?: string) => void;
    setWebViewRef: (ref: React.RefObject<WebView>) => void;
    setNativeActivityActive: (active: boolean) => void;
    requestManaConfirmation: (appId: number | null, operationType: ManaOperationType, costEstimate: string) => Promise<boolean>;
    resolveManaConfirmation: (confirmed: boolean) => void;
}

export const useBridgeUIStore = create<BridgeUIState>((set, get) => ({
    isScannerOpen: false,
    scannerCallback: null,
    webViewRef: null,
    isNativeActivityActive: false,
    manaConfirmRequest: null,
    openScanner: (callback) => set({ isScannerOpen: true, scannerCallback: callback, isNativeActivityActive: true }),
    closeScanner: () => set({ isScannerOpen: false, scannerCallback: null, isNativeActivityActive: false }),
    setWebViewRef: (ref) => set({ webViewRef: ref }),
    setNativeActivityActive: (active: boolean) => set({ isNativeActivityActive: active }),
    requestManaConfirmation: async (appId, operationType, costEstimate) => {
        if (appId !== null) {
            const key = `mana_confirm_skip_${appId}_${operationType}`;
            try {
                const skip = await AsyncStorage.getItem(key);
                if (skip === 'true') return true;
            } catch (_) {}
        }
        return new Promise<boolean>((resolve) => {
            set({ manaConfirmRequest: { appId, operationType, costEstimate, resolve } });
        });
    },
    resolveManaConfirmation: (confirmed) => {
        const req = get().manaConfirmRequest;
        if (req) {
            req.resolve(confirmed);
            set({ manaConfirmRequest: null });
        }
    },
}));
