import { create } from 'zustand';
import { WebView } from 'react-native-webview';

interface BridgeUIState {
    isScannerOpen: boolean;
    scannerCallback: string | null;
    webViewRef: React.RefObject<WebView> | null;
    isNativeActivityActive: boolean;
    openScanner: (callback: string) => void;
    closeScanner: (scannedData?: string) => void;
    setWebViewRef: (ref: React.RefObject<WebView>) => void;
    setNativeActivityActive: (active: boolean) => void;
}

export const useBridgeUIStore = create<BridgeUIState>((set) => ({
    isScannerOpen: false,
    scannerCallback: null,
    webViewRef: null,
    isNativeActivityActive: false,
    openScanner: (callback) => set({ isScannerOpen: true, scannerCallback: callback, isNativeActivityActive: true }),
    closeScanner: () => set({ isScannerOpen: false, scannerCallback: null, isNativeActivityActive: false }),
    setWebViewRef: (ref) => set({ webViewRef: ref }),
    setNativeActivityActive: (active: boolean) => set({ isNativeActivityActive: active }),
}));
