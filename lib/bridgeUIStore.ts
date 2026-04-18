import { create } from 'zustand';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ManaOperationType = 'generate' | 'image' | 'video' | 'audio' | 'similarity';

interface LargePayloadConfirmRequest {
    resolve: (confirmed: boolean) => void;
}

interface ManaConfirmRequest {
    appId: number | null;
    operationType: ManaOperationType;
    costEstimate: string;
    resolve: (confirmed: boolean) => void;
}

interface VideoPlayback {
    uri: string;
    callback?: string;
}

interface BridgeUIState {
    isScannerOpen: boolean;
    scannerCallback: string | null;
    webViewRef: React.RefObject<WebView> | null;
    isNativeActivityActive: boolean;
    manaConfirmRequest: ManaConfirmRequest | null;
    largePayloadConfirmRequest: LargePayloadConfirmRequest | null;
    videoPlayback: VideoPlayback | null;
    openScanner: (callback: string) => void;
    closeScanner: (scannedData?: string) => void;
    setWebViewRef: (ref: React.RefObject<WebView>) => void;
    setNativeActivityActive: (active: boolean) => void;
    requestManaConfirmation: (appId: number | null, operationType: ManaOperationType, costEstimate: string) => Promise<boolean>;
    resolveManaConfirmation: (confirmed: boolean) => void;
    requestLargePayloadConfirmation: () => Promise<boolean>;
    resolveLargePayloadConfirmation: (confirmed: boolean) => void;
    openVideoPlayer: (uri: string, callback?: string) => void;
    closeVideoPlayer: () => void;
}

export const useBridgeUIStore = create<BridgeUIState>((set, get) => ({
    isScannerOpen: false,
    scannerCallback: null,
    webViewRef: null,
    isNativeActivityActive: false,
    manaConfirmRequest: null,
    largePayloadConfirmRequest: null,
    videoPlayback: null,
    openScanner: (callback) => set({ isScannerOpen: true, scannerCallback: callback, isNativeActivityActive: true }),
    closeScanner: () => set({ isScannerOpen: false, scannerCallback: null, isNativeActivityActive: false }),
    setWebViewRef: (ref) => set({ webViewRef: ref }),
    setNativeActivityActive: (active: boolean) => set({ isNativeActivityActive: active }),
    openVideoPlayer: (uri, callback) => set({ videoPlayback: { uri, callback }, isNativeActivityActive: true }),
    closeVideoPlayer: () => set({ videoPlayback: null, isNativeActivityActive: false }),
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
    requestLargePayloadConfirmation: () => new Promise<boolean>((resolve) => {
        set({ largePayloadConfirmRequest: { resolve } });
    }),
    resolveLargePayloadConfirmation: (confirmed) => {
        const req = get().largePayloadConfirmRequest;
        if (req) {
            req.resolve(confirmed);
            set({ largePayloadConfirmRequest: null });
        }
    },
}));
