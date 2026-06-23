import { create } from 'zustand';
import { WebView } from 'react-native-webview';
import AsyncStorage from '@react-native-async-storage/async-storage';

export type ManaOperationType = 'generate' | 'image' | 'video' | 'audio' | 'similarity';

interface LargePayloadConfirmRequest {
    resolve: (confirmed: boolean) => void;
}

/**
 * BYOK-aware confirmation modal. Shows USD ($0.0023) and the routed model
 * name.
 */
interface CostEstimateRequest {
    appId: number | null;
    operationType: ManaOperationType;
    /** Pre-formatted USD string, e.g. "$0.0023" or "< $0.01". */
    costUsd: string;
    /** Model id that will handle the call, e.g. "deepseek/deepseek-v4-flash". */
    modelId: string;
    resolve: (confirmed: boolean) => void;
}

/** Surfaced when a spell needs AI but no OpenRouter key is configured. */
interface KeyMissingRequest {
    /** Which operation tried to fire (informational for the modal copy). */
    operationType: ManaOperationType | 'create' | 'edit';
    resolve: (action: 'openSettings' | 'cancel') => void;
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
    costEstimateRequest: CostEstimateRequest | null;
    keyMissingRequest: KeyMissingRequest | null;
    largePayloadConfirmRequest: LargePayloadConfirmRequest | null;
    videoPlayback: VideoPlayback | null;
    openScanner: (callback: string) => void;
    closeScanner: (scannedData?: string) => void;
    setWebViewRef: (ref: React.RefObject<WebView>) => void;
    setNativeActivityActive: (active: boolean) => void;
    requestCostEstimate: (appId: number | null, operationType: ManaOperationType, costUsd: string, modelId: string) => Promise<boolean>;
    resolveCostEstimate: (confirmed: boolean) => void;
    requestKeyMissing: (operationType: ManaOperationType | 'create' | 'edit') => Promise<'openSettings' | 'cancel'>;
    resolveKeyMissing: (action: 'openSettings' | 'cancel') => void;
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
    costEstimateRequest: null,
    keyMissingRequest: null,
    largePayloadConfirmRequest: null,
    videoPlayback: null,
    openScanner: (callback) => set({ isScannerOpen: true, scannerCallback: callback, isNativeActivityActive: true }),
    closeScanner: () => set({ isScannerOpen: false, scannerCallback: null, isNativeActivityActive: false }),
    setWebViewRef: (ref) => set({ webViewRef: ref }),
    setNativeActivityActive: (active: boolean) => set({ isNativeActivityActive: active }),
    openVideoPlayer: (uri, callback) => set({ videoPlayback: { uri, callback }, isNativeActivityActive: true }),
    closeVideoPlayer: () => set({ videoPlayback: null, isNativeActivityActive: false }),
    requestCostEstimate: async (appId, operationType, costUsd, modelId) => {
        if (appId !== null) {
            const key = `cost_estimate_skip_${appId}_${operationType}`;
            try {
                const skip = await AsyncStorage.getItem(key);
                if (skip === 'true') return true;
            } catch (_) {}
        }
        return new Promise<boolean>((resolve) => {
            set({ costEstimateRequest: { appId, operationType, costUsd, modelId, resolve } });
        });
    },
    resolveCostEstimate: (confirmed) => {
        const req = get().costEstimateRequest;
        if (req) {
            req.resolve(confirmed);
            set({ costEstimateRequest: null });
        }
    },
    requestKeyMissing: (operationType) => new Promise<'openSettings' | 'cancel'>((resolve) => {
        set({ keyMissingRequest: { operationType, resolve } });
    }),
    resolveKeyMissing: (action) => {
        const req = get().keyMissingRequest;
        if (req) {
            req.resolve(action);
            set({ keyMissingRequest: null });
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
