import { create } from 'zustand';
import { WebView } from 'react-native-webview';

interface BridgeUIState {
    isScannerOpen: boolean;
    scannerCallback: string | null;
    webViewRef: React.RefObject<WebView> | null;
    openScanner: (callback: string) => void;
    closeScanner: (scannedData?: string) => void;
    setWebViewRef: (ref: React.RefObject<WebView>) => void;

    // Future: Audio UI?
}

export const useBridgeUIStore = create<BridgeUIState>((set) => ({
    isScannerOpen: false,
    scannerCallback: null,
    webViewRef: null,
    openScanner: (callback) => set({ isScannerOpen: true, scannerCallback: callback }),
    closeScanner: () => set({ isScannerOpen: false, scannerCallback: null }),
    setWebViewRef: (ref) => set({ webViewRef: ref }),
}));
