import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    AppState,
    AppStateStatus,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript, createSharedContentSetupScript } from './lib/bridges/injectedJS';
import { handleBridgeMessage } from './lib/bridges/messageHandlers';
import * as db from './lib/database/db';
import { colors } from './lib/theme';
import { GeneratedApp } from './lib/database/types';
import { getWebViewTranslations } from './lib/i18n';
import { getStorageFromCache, isCacheLoaded, reloadStorageForApp, StorageItem } from './lib/storageCache';
import QRScannerOverlay from './components/QRScannerOverlay';
import { useBridgeUIStore } from './lib/bridgeUIStore';

// Configure notifications
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

interface Props {
    appId: number;
}

function RunnerContent({ appId }: Props) {
    const webViewRef = useRef<WebView>(null);
    const viewContainerRef = useRef<View>(null);
    const [app, setApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [savedStorage, setSavedStorage] = useState<{ key: string; value: string }[]>([]);
    const [storageLoaded, setStorageLoaded] = useState(false);
    // Use ref to ensure storage is available synchronously for script creation
    const savedStorageRef = useRef<{ key: string; value: string }[]>([]);
    const [sharedContent, setSharedContent] = useState<any>(null);
    const [webViewReady, setWebViewReady] = useState(false);
    const [webViewKey, setWebViewKey] = useState(0); // Key to force WebView recreation
    const lastCodeRef = useRef<string | null>(null); // Track code changes

    // Check drop-box file for pending shared content
    useEffect(() => {
        async function checkDropBox() {
            const dropBoxPath = FileSystem.cacheDirectory + 'pending_share.json';
            console.log('RunnerApp: Checking drop-box at:', dropBoxPath);
            try {
                const info = await FileSystem.getInfoAsync(dropBoxPath);
                if (info.exists) {
                    const contentStr = await FileSystem.readAsStringAsync(dropBoxPath);
                    const content = JSON.parse(contentStr);

                    // Only consume if this drop-box is for THIS app
                    if (content.targetAppId === appId) {
                        console.log('RunnerApp: Drop-box found for app', appId, 'fileName:', content.fileName);
                        setSharedContent(content);

                        // Delete immediately to prevent reuse
                        await FileSystem.deleteAsync(dropBoxPath, { idempotent: true });
                    } else {
                        console.log('RunnerApp: Drop-box is for different app', content.targetAppId, 'vs', appId);
                    }
                } else {
                    console.log('RunnerApp: No drop-box file found');
                }
            } catch (e) {
                console.log('RunnerApp: Drop-box read error:', e);
            }
        }
        checkDropBox();
    }, [appId]);

    // Set global webViewRef for overlays - critical for scanner to work
    useEffect(() => {
        if (webViewRef) {
            useBridgeUIStore.getState().setWebViewRef(webViewRef as any);
        }
    }, []);

    // Load app data and storage - also reload when webViewKey changes (WebView recreation)
    useEffect(() => {
        // Reset state for this specific appId
        setIsLoading(true);
        setStorageLoaded(false);
        savedStorageRef.current = [];

        async function loadApp() {
            if (!appId) return;
            console.log(`RunnerApp[${appId}]: Loading app and storage...`);
            const appData = await db.getAppById(appId);
            if (appData) {
                // Try to get storage from cache first (fast path when opened via main app)
                // Fallback to DB if cache not loaded (e.g., when opened via shortcut)
                let storageItems: StorageItem[];
                if (isCacheLoaded()) {
                    storageItems = getStorageFromCache(appData.id);
                    console.log(`RunnerApp[${appId}]: Got ${storageItems.length} items from cache`);
                } else {
                    console.log(`RunnerApp[${appId}]: Cache not loaded, loading from DB...`);
                    const storage = await db.getStorageForApp(appData.id);
                    storageItems = storage.map(s => ({ key: s.key, value: s.value }));
                    console.log(`RunnerApp[${appId}]: Got ${storageItems.length} items from DB`);
                }

                // Update ref FIRST (synchronously)
                savedStorageRef.current = storageItems;

                // Then update state atomically
                setApp(appData);
                setSavedStorage(storageItems);
                setStorageLoaded(true);
                setIsLoading(false);
            } else {
                setStorageLoaded(true);
                setIsLoading(false);
            }
        }
        loadApp();
    }, [appId, webViewKey]); // webViewKey added to reload storage on WebView recreation


    // Detect when app comes to foreground and check if WebView is still alive
    const heartbeatReceivedRef = useRef(false);

    useEffect(() => {
        let wasInBackground = false;

        const handleAppStateChange = async (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                wasInBackground = true;
                console.log('RunnerApp: App went to background');
            }

            if (nextAppState === 'active' && wasInBackground && app) {
                console.log('RunnerApp: App came to foreground after being in background');
                wasInBackground = false;

                // Re-fetch app data to get latest code
                const freshApp = await db.getAppById(appId);
                if (freshApp) {
                    // Check if code changed while we were in background
                    if (freshApp.code !== lastCodeRef.current) {
                        console.log('RunnerApp: Code was updated, reloading with new code...');
                        lastCodeRef.current = freshApp.code;
                        setApp(freshApp);
                        setWebViewKey(k => k + 1); // Force reload for code change
                        return;
                    }
                }

                // Smart detection: Send heartbeat and wait for response
                if (webViewRef.current) {
                    heartbeatReceivedRef.current = false;

                    try {
                        console.log('RunnerApp: Sending heartbeat to WebView...');
                        webViewRef.current.injectJavaScript(`
                            if (typeof window !== 'undefined' && window.ReactNativeWebView) {
                                window.ReactNativeWebView.postMessage(JSON.stringify({ type: 'HEARTBEAT_RESPONSE' }));
                            }
                            true;
                        `);

                        // Wait for response - if no response in 300ms, WebView is dead
                        setTimeout(() => {
                            if (!heartbeatReceivedRef.current) {
                                console.log('RunnerApp: No heartbeat response, WebView is dead - forcing reload');
                                setWebViewKey(k => k + 1);
                            } else {
                                // WebView is healthy - no reload needed since localStorage is now isolated per-app
                                console.log('RunnerApp: Heartbeat received, WebView is healthy');
                            }
                        }, 300);
                    } catch (e) {
                        console.log('RunnerApp: Error sending heartbeat, forcing reload');
                        setWebViewKey(k => k + 1);
                    }
                }
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => subscription?.remove();
    }, [app, appId]);

    // Track the current code version
    useEffect(() => {
        if (app) {
            lastCodeRef.current = app.code;
        }
    }, [app]);

    // Back button is handled natively in RunnerActivity.kt using moveTaskToBack

    // Handle messages from WebView
    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
        try {
            const message = JSON.parse(event.nativeEvent.data);
            const { type, data, callbackName } = message;

            // Skip logging for frequent message types
            if (type !== 'CONSOLE_LOG' && type !== 'NETWORK_LOG') {
                console.log('WebView Message received:', type);
            }

            // Handle local-only messages first
            if (type === 'CONSOLE_LOG' || type === 'NETWORK_LOG') {
                // Silently ignore in run-only mode
                return;
            }

            // Handle heartbeat response for white screen detection
            if (type === 'HEARTBEAT_RESPONSE') {
                heartbeatReceivedRef.current = true;
                return;
            }

            // Delegate to shared handlers
            const handlerResult = await handleBridgeMessage(type, data, {
                webViewRef: webViewRef as React.RefObject<WebView>,
                viewContainerRef: viewContainerRef,
                appId: app?.id || null,
                callbackName, // Pass callbackName for scanner/handlers
            });

            // Send callback if needed, unless deferred (e.g. scanner)
            if (callbackName && webViewRef.current && !handlerResult.deferredCallback) {
                const script = createCallbackScript(callbackName, handlerResult.success, handlerResult.result);
                webViewRef.current.injectJavaScript(script);
            }

            if (!handlerResult.handled) {
                console.log('Unknown message type:', type);
            }
        } catch (e) {
            console.error('Error handling WebView message:', e);
        }
    }, [app]);

    if (isLoading || !app || !storageLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>
        * { box-sizing: border-box; }
        body { margin: 0; padding: 0; }
      </style>
    </head>
    <body>
      ${app.code}
    </body>
    </html>
  `;

    // Use ref for storage to ensure data is available synchronously
    console.log(`RunnerApp[${appId}]: Creating combinedScript with ${savedStorageRef.current.length} storage items`);
    const storageScript = createStorageRestoreScript(savedStorageRef.current);
    const combinedScript = `
        ${getInjectedJavaScript(app.id, getWebViewTranslations(), false)}
        ${storageScript}
    `;

    return (
        <>
            <View ref={viewContainerRef} style={{ flex: 1 }} collapsable={false}>
                <WebView
                    key={webViewKey}
                    ref={webViewRef}
                    source={{ html: htmlContent, baseUrl: `https://app-${appId}.appacadabra.local/` }}
                    style={styles.webview}
                    originWhitelist={['*']}
                    javaScriptEnabled
                    domStorageEnabled
                    mediaPlaybackRequiresUserAction={false}
                    allowsInlineMediaPlayback
                    allowFileAccess
                    allowFileAccessFromFileURLs
                    allowUniversalAccessFromFileURLs
                    mixedContentMode="always"
                    geolocationEnabled
                    injectedJavaScriptBeforeContentLoaded={combinedScript}
                    onMessage={handleMessage}
                    onError={(e) => console.error('WebView error:', e.nativeEvent)}
                    onLoadEnd={() => {
                        console.log('RunnerApp: WebView loaded, checking for shared content');
                        setWebViewReady(true);

                        // Inject shared content if available
                        if (sharedContent && webViewRef.current) {
                            console.log('RunnerApp: Injecting shared content, fileName:', sharedContent.fileName);

                            // Setup the shared content handler in WebView
                            const setupScript = createSharedContentSetupScript(getWebViewTranslations());
                            webViewRef.current.injectJavaScript(setupScript);

                            // Post the content after a short delay to ensure handler is ready
                            setTimeout(() => {
                                if (webViewRef.current && sharedContent) {
                                    console.log('RunnerApp: Posting shared content message');
                                    webViewRef.current.postMessage(JSON.stringify({
                                        type: 'SET_SHARED_CONTENT',
                                        payload: sharedContent
                                    }));

                                    // Clear after injection to prevent re-injection
                                    setSharedContent(null);
                                }
                            }, 500);
                        }
                    }}
                    onShouldStartLoadWithRequest={(request) => {
                        const { url } = request;
                        // Allow internal URLs (localhost, appacadabra.local, data:, about:)
                        if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
                            return true;
                        }
                        if (url.startsWith('http://') || url.startsWith('https://')) {
                            // Keep navigation internal for our local baseUrl and localhost
                            if (url.includes('localhost') || url.includes('.appacadabra.local')) {
                                return true;
                            }
                            // External URLs - open in system browser
                            Linking.openURL(url);
                            return false;
                        }
                        return true;
                    }}
                    // @ts-ignore
                    androidOnGeolocationPermissionsShowPrompt={async (origin: string, callback: (origin: string, allow: boolean, retain: boolean) => void) => {
                        console.log('RunnerApp: Geolocation permission requested for origin:', origin);
                        try {
                            const { status } = await Location.requestForegroundPermissionsAsync();
                            console.log('RunnerApp: Permission status:', status);
                            callback(origin, status === 'granted', true);
                        } catch (e) {
                            console.error('RunnerApp: Geolocation permission error:', e);
                            callback(origin, false, false);
                        }
                    }}
                />
            </View>
            <QRScannerOverlay webviewRef={webViewRef} />
        </>
    );
}

// Main component that receives appId from native props (no expo-linking)
interface RunnerAppProps {
    appId?: number;
}

export default function RunnerApp(props: RunnerAppProps) {
    const appId = props.appId ?? null;

    if (appId === null || appId < 0) {
        return (
            <SafeAreaProvider>
                <SafeAreaView style={styles.container}>
                    <View style={styles.loadingContainer}>
                        <Text style={{ color: colors.primary, textAlign: 'center' }}>
                            Não foi possível carregar o app
                        </Text>
                    </View>
                </SafeAreaView>
            </SafeAreaProvider>
        );
    }

    return (
        <SafeAreaProvider>
            <SafeAreaView style={styles.container} edges={['top']}>
                <RunnerContent appId={appId} />
            </SafeAreaView>
        </SafeAreaProvider>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.background,
    },
    webview: {
        flex: 1,
        backgroundColor: '#FFFFFF',
    },
});
