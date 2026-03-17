import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    AppState,
    AppStateStatus,
    ScrollView,
    RefreshControl,
    DeviceEventEmitter,
    TouchableOpacity,
    Modal,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import { Video, ResizeMode } from 'expo-av';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript, createSharedContentSetupScript, getScrollDetectionScript, createMediaCallbackScript, createMediaChunkScript, ExpandedStorageItem } from './lib/bridges/injectedJS';
import { handleBridgeMessage, cleanupAllMedia, expandStorageBlobMarkers, migrateStorageBlobsToFiles, registerPendingMediaBlob, AI_MEDIA_MIME, buildBlobMarker } from './lib/bridges/messageHandlers';
import * as db from './lib/database/db';
import { colors } from './lib/theme';
import { GeneratedApp } from './lib/database/types';
import { t, getWebViewTranslations } from './lib/i18n';
import { getStorageFromCache, isCacheLoaded, reloadStorageForApp, StorageItem } from './lib/storageCache';
import AiLoadingBar from './components/AiLoadingBar';
import QRScannerOverlay from './components/QRScannerOverlay';
import { useBridgeUIStore } from './lib/bridgeUIStore';
import { ManaConfirmModal } from './components/ManaConfirmModal';

// Configure notifications
Notifications.setNotificationHandler({
    handleNotification: async () => ({
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
    const [pendingVersionApp, setPendingVersionApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [savedStorage, setSavedStorage] = useState<ExpandedStorageItem[]>([]);
    const [storageLoaded, setStorageLoaded] = useState(false);
    // Use ref to ensure storage is available synchronously for script creation
    const savedStorageRef = useRef<ExpandedStorageItem[]>([]);
    const [sharedContent, setSharedContent] = useState<any>(null);
    const [webViewReady, setWebViewReady] = useState(false);
    const [webViewKey, setWebViewKey] = useState(0); // Key to force WebView recreation
    const lastCodeRef = useRef<string | null>(null); // Track code changes
    const [refreshing, setRefreshing] = useState(false);
    const [initialReloadDone, setInitialReloadDone] = useState(false);
    const [isAtTop, setIsAtTop] = useState(true); // Helper to prevent conflicting scrolls
    const [showFirstAiUseModal, setShowFirstAiUseModal] = useState(false);
    const [isAiLoading, setIsAiLoading] = useState(false);
    
    // Video Playback — use selector so store changes in other RunnerContent instances don't cause re-renders here
    const closeVideoPlayer = useBridgeUIStore(state => state.closeVideoPlayer);

    // Check drop-box file for pending shared content
    const checkDropBox = useCallback(async () => {
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
    }, [appId]);

    // Check on mount
    useEffect(() => {
        checkDropBox();
    }, [checkDropBox]);

    // Set global webViewRef for overlays
    useEffect(() => {
        if (webViewRef) {
            useBridgeUIStore.getState().setWebViewRef(webViewRef as any);
        }
        // Enable WebView debugging (Chrome DevTools)
        try {
            // @ts-ignore
            if (WebView.setWebContentsDebuggingEnabled) {
                // @ts-ignore
                WebView.setWebContentsDebuggingEnabled(true);
                console.log('WebView Debugging Enabled');
            }
        } catch (e) {
            console.warn('Failed to enable WebView debugging', e);
        }
        return () => {
            // On unmount: clean up shared store state so sibling RunnerContent instances are not affected
            const store = useBridgeUIStore.getState();
            store.closeScanner();
            store.closeVideoPlayer();
            store.resolveManaConfirmation(false);
            if ((store.webViewRef as any) === webViewRef) {
                store.setWebViewRef(null as any);
            }
        };
    }, [webViewRef]);

    // Load app data
    const loadApp = useCallback(async () => {
        if (!appId) return;
        console.log(`RunnerApp[${appId}]: Loading app and storage...`);
        const appData = await db.getAppById(appId);
        if (appData) {
            // Force reload storage from DB to get latest
            const storage = await db.getStorageForApp(appData.id);
            const storageItems = storage.map(s => ({ key: s.key, value: s.value }));
            console.log(`RunnerApp[${appId}]: Got ${storageItems.length} items from DB`);

            // Migrate any legacy base64 blobs stored directly in DB to files
            await migrateStorageBlobsToFiles(appData.id);
            // Expand blob markers back to base64 for WebView injection
            const expandedItems = await expandStorageBlobMarkers(storageItems);

            // Update ref and state
            savedStorageRef.current = expandedItems;

            // Check for code updates
            if (lastCodeRef.current !== null && appData.code !== lastCodeRef.current) {
                console.log('RunnerApp: Code updated during load, setting pending banner instead of forcing reload');
                setPendingVersionApp(appData);
                // We do NOT update the app state or storage yet, wait for user
                setStorageLoaded(true);
                setIsLoading(false);
                return;
            }

            lastCodeRef.current = appData.code;

            setApp(appData);
            setSavedStorage(expandedItems);
            setStorageLoaded(true);
            setIsLoading(false);
        } else {
            // App deleted?
            setStorageLoaded(true);
            setIsLoading(false);
        }
    }, [appId]);

    const applyPendingUpdate = useCallback(async () => {
        if (pendingVersionApp) {
            setApp(pendingVersionApp);
            lastCodeRef.current = pendingVersionApp.code;

            // Reload storage for new version
            const storage = await db.getStorageForApp(pendingVersionApp.id);
            const storageItems = storage.map(s => ({ key: s.key, value: s.value }));
            await migrateStorageBlobsToFiles(pendingVersionApp.id);
            const expandedItems = await expandStorageBlobMarkers(storageItems);
            savedStorageRef.current = expandedItems;
            setSavedStorage(expandedItems);

            setPendingVersionApp(null);
            setWebViewKey(k => k + 1);
        }
    }, [pendingVersionApp]);

    // Initial Load
    useEffect(() => {
        setIsLoading(true);
        loadApp();
    }, [loadApp]);

    // Live Reload Listener (from Editor)
    useEffect(() => {
        const subscription = DeviceEventEmitter.addListener('APP_UPDATED', (event) => {
            if (event.appId === appId) {
                console.log('RunnerApp: Received APP_UPDATED event, refreshing...');
                loadApp();
            }
        });
        return () => subscription.remove();
    }, [appId, loadApp]);

    // Force Initial Reload to guarantee LocalStorage injection (Safety Fix)
    // Sometimes imported apps miss the first injection, this ensures it works.
    useEffect(() => {
        if (storageLoaded && !initialReloadDone) {
            const timer = setTimeout(() => {
                console.log('RunnerApp: Force reloading WebView to ensure storage consistency');
                setWebViewKey(k => k + 1);
                setInitialReloadDone(true);
            }, 100);
            return () => clearTimeout(timer);
        }
    }, [storageLoaded, initialReloadDone]);

    // Pull-to-Refresh Handler
    const onRefresh = useCallback(async () => {
        setRefreshing(true);
        await loadApp();
        setRefreshing(false);
        // We typically want to reload the WebView content too if data changed
        // But since 'app' state updates, React will re-render. 
        // If we want a hard reset of JS state, we can increment key:
        setWebViewKey(k => k + 1);
    }, [loadApp]);


    // Detect when app comes to foreground and check if WebView is still alive
    const heartbeatReceivedRef = useRef(false);

    useEffect(() => {
        let wasInBackground = false;

        const handleAppStateChange = async (nextAppState: AppStateStatus) => {
            if (nextAppState === 'background' || nextAppState === 'inactive') {
                wasInBackground = true;
                console.log('RunnerApp: App went to background/inactive');
                // Guard: don't stop media if we're just opening a native picker (camera, image gallery)
                if (!useBridgeUIStore.getState().isNativeActivityActive) {
                    cleanupAllMedia();
                } else {
                    console.log('RunnerApp: Native activity active, skipping media cleanup');
                }
            }

            if (nextAppState === 'active' && wasInBackground && app) {
                console.log('RunnerApp: App came to foreground after being in background');
                wasInBackground = false;

                // Check for shared content delivered while in background
                checkDropBox();

                // Re-fetch app data
                loadApp();
            }
        };

        const subscription = AppState.addEventListener('change', handleAppStateChange);
        return () => subscription?.remove();
    }, [app, appId, loadApp, checkDropBox]);

    // Back button is handled natively in RunnerActivity.kt using moveTaskToBack

    // Handle messages from WebView
    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
        let callbackName: string | undefined;
        try {
            const message = JSON.parse(event.nativeEvent.data);
            const { type, data, callbackName: cbName } = message;
            callbackName = cbName;

            // Skip logging for frequent message types
            if (type !== 'CONSOLE_LOG' && type !== 'NETWORK_LOG') {
                console.log('WebView Message received:', type);
            }

            // Handle heartbeat response for white screen detection
            if (type === 'HEARTBEAT_RESPONSE') {
                heartbeatReceivedRef.current = true;
                return;
            }

            // Handle Scroll Status for Smart Refresh
            if (type === 'SCROLL_STATUS') {
                setIsAtTop(data.isAtTop);
                return;
            }

            const isAiCall = [
                'AI_GENERATE', 'AI_SIMILARITY', 'AI_GENERATE_IMAGE',
                'AI_GENERATE_VIDEO', 'AUDIO_SPEAK_AI'
            ].includes(type);

            if (isAiCall) setIsAiLoading(true);

            let handlerResult;
            try {
                // Delegate to shared handlers
                handlerResult = await handleBridgeMessage(type, data, {
                    webViewRef: webViewRef as React.RefObject<WebView>,
                    viewContainerRef: viewContainerRef,
                    appId: app?.id || null,
                    callbackName, // Pass callbackName for scanner/handlers
                });

                if (handlerResult.isFirstAiUse) {
                    setShowFirstAiUseModal(true);
                }
            } finally {
                if (isAiCall) setIsAiLoading(false);
            }

            // Cache media results and save to DB
            const RUNNER_MEDIA_TYPES = new Set([
                'AI_GENERATE_IMAGE', 'AI_GENERATE_VIDEO', 'AUDIO_SPEAK_AI',
                'CAMERA_TAKE_PHOTO', 'CAMERA_RECORD_VIDEO', 'AUDIO_RECORD_STOP',
            ]);
            let mediaLocalPath: string | undefined;
            if (callbackName) {
                console.log(`[RunnerApp] Handling response for: ${callbackName} | type: ${type} | success: ${handlerResult.success}`);
                if (handlerResult.result && typeof handlerResult.result === 'string') {
                    console.log(`[RunnerApp] Result preview: ${handlerResult.result.substring(0, 50)}${handlerResult.result.length > 50 ? '...' : ''}`);
                } else {
                    console.log(`[RunnerApp] Result type: ${typeof handlerResult.result}`);
                }
            }

            if (RUNNER_MEDIA_TYPES.has(type) && handlerResult.success && handlerResult.result) {
                let cacheResult = handlerResult.result;
                const isMarker = handlerResult.result.startsWith('__appblob__:');
                // Detect if result is a filesystem path (not base64 — JPEG base64 starts with /9j/ which is NOT a path)
                const isPath = !isMarker && (handlerResult.result.startsWith('file://') ||
                    (handlerResult.result.startsWith('/') && handlerResult.result.length < 1000 && /^\/[\w.]/.test(handlerResult.result)));

                if (isMarker) {
                    // Result is already a marker (e.g. from speakAI)
                    const parts = handlerResult.result.split('|');
                    if (parts.length >= 3) mediaLocalPath = parts[2];
                    cacheResult = handlerResult.result;
                } else if (isPath) {
                    mediaLocalPath = handlerResult.result.startsWith('file://') ? handlerResult.result.slice(7) : handlerResult.result;
                    cacheResult = `file://${mediaLocalPath}`;
                } else if (handlerResult.result.length > 20) {
                    try {
                        const mime = AI_MEDIA_MIME[type] ?? 'application/octet-stream';
                        const ext = mime.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
                        const dir = `${FileSystem.documentDirectory}appacadabra_media/${app?.id}`;
                        await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });
                        const fileUri = `${dir}/${callbackName}.${ext}`; // dir starts with file://
                        
                        // Robust base64 cleaning
                        const cleanB64 = handlerResult.result.replace(/^data:.*?;base64,/i, '').replace(/\s/g, '');
                        await FileSystem.writeAsStringAsync(fileUri, cleanB64, { encoding: FileSystem.EncodingType.Base64 });
                        mediaLocalPath = fileUri.slice(7); // bare path without file://
                        cacheResult = `file://${mediaLocalPath}`;
                        if (callbackName) {
                            registerPendingMediaBlob(cleanB64, callbackName, mime);
                        }
                    } catch (fileErr) {
                        console.warn('[RunnerApp] Failed to save media file:', fileErr);
                    }
                }
                if (app?.id && callbackName) {
                    try {
                        await db.saveWebviewAiCache({
                            appId: app.id, callbackName, action: type,
                            requestData: JSON.stringify(data),
                            result: cacheResult, mediaLocalPath,
                            creditsUsed: handlerResult.creditsUsed ?? 0,
                            success: handlerResult.success ? 1 : 0,
                        });
                    } catch (cacheErr) {
                        console.warn('[RunnerApp] Failed to cache AI response:', cacheErr);
                    }
                }
            }

            if (type === 'AI_GENERATE' && handlerResult.success && handlerResult.result && app?.id && callbackName) {
                try {
                    await db.saveWebviewAiCache({
                        appId: app.id, callbackName, action: type,
                        requestData: JSON.stringify(data),
                        result: handlerResult.result,
                        mediaLocalPath: undefined,
                        creditsUsed: handlerResult.creditsUsed ?? 0,
                        success: 1,
                    });
                } catch (cacheErr) {
                    console.warn('[RunnerApp] Failed to cache AI_GENERATE response:', cacheErr);
                }
            }

            // Send callback if needed, unless deferred (e.g. scanner)
            if (callbackName && webViewRef.current && !handlerResult.deferredCallback) {
                let handledCallback = false;

                // For media types with a local file: use createMediaCallbackScript to inject into blob cache
                if (handlerResult.success && mediaLocalPath && callbackName && RUNNER_MEDIA_TYPES.has(type)) {
                    try {
                        const mime = AI_MEDIA_MIME[type] ?? 'application/octet-stream';
                        const b64Raw = await FileSystem.readAsStringAsync(`file://${mediaLocalPath}`, {
                            encoding: FileSystem.EncodingType.Base64,
                        });
                        const b64 = b64Raw.replace(/\s/g, '');
                        // Guardrail: Ensure we don't double-prefix dataURIs. Strip any existing prefix first.
                        const cleanB64 = b64.replace(/^data:.*?;base64,/i, '');
                        const dataUri = `data:${mime};base64,${cleanB64}`;

                        // If result is already a marker, use it. Otherwise build one.
                        const isResMarker = handlerResult.result?.startsWith('__appblob__:');
                        const marker = isResMarker ? handlerResult.result : buildBlobMarker(mime, callbackName, mediaLocalPath);

                        console.log(`[RunnerApp] Delivering media ${type} to ${callbackName} | marker: ${marker.substring(0, 40)}...`);
                        
                        // 1. Prepare the callback to wait for media
                        const script = createMediaCallbackScript(callbackName, handlerResult.success, marker);
                        webViewRef.current.injectJavaScript(script);

                        // 2. Deliver the media in chunks
                        const CHUNK_SIZE = 64 * 1024; // 64KB chunks
                        const totalChunks = Math.ceil(cleanB64.length / CHUNK_SIZE);
                        console.log(`[RunnerApp] Delivering ${marker} in ${totalChunks} chunks`);

                        for (let i = 0; i < totalChunks; i++) {
                            const start = i * CHUNK_SIZE;
                            const end = Math.min(start + CHUNK_SIZE, cleanB64.length);
                            const chunk = cleanB64.substring(start, end);
                            const chunkScript = createMediaChunkScript(marker, chunk, i, totalChunks);
                            webViewRef.current.injectJavaScript(chunkScript);
                        }
                        
                        handledCallback = true;
                    } catch (readErr) {
                        console.warn('[RunnerApp] Failed to build media callback, falling back:', readErr);
                    }
                }

                if (!handledCallback) {
                    console.log(`[RunnerApp] Sending callback: ${callbackName} | type: ${type} | success: ${handlerResult.success}`);
                    const script = createCallbackScript(callbackName, handlerResult.success, handlerResult.result);
                    webViewRef.current.injectJavaScript(script);
                }
            }

            if (!handlerResult.handled) {
                console.log('Unknown message type:', type);
            }
        } catch (e) {
            console.error('Error handling WebView message:', e);
            // IMPORTANT: Always send callback on error to prevent JS from hanging
            if (callbackName && webViewRef.current) {
                const errorMsg = e instanceof Error ? e.message : 'Unknown error';
                const script = createCallbackScript(callbackName, false, errorMsg);
                webViewRef.current.injectJavaScript(script);
            }
        }
    }, [app]);

    // Memoize HTML and scripts so store changes in sibling RunnerContent instances don't reload this WebView
    const htmlContent = useMemo(() => {
        if (!app) return '';
        return `
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
    }, [app?.code]);

    const source = useMemo(() => ({
        html: htmlContent,
        baseUrl: `https://app-${appId}.appacadabra.local/`,
    }), [htmlContent, appId]);

    const combinedScript = useMemo(() => {
        if (!app) return '';
        console.log(`RunnerApp[${appId}]: Creating combinedScript with ${savedStorage.length} storage items`);
        return `
        ${getInjectedJavaScript(app.id, getWebViewTranslations(), false)}
        ${createStorageRestoreScript(savedStorage)}
        ${getScrollDetectionScript()}
    `;
    }, [app?.id, savedStorage]);

    if (isLoading || !app || !storageLoaded) {
        return (
            <View style={styles.loadingContainer}>
                <ActivityIndicator size="large" color={colors.primary} />
            </View>
        );
    }

    return (
        <>
            <View ref={viewContainerRef} style={{ flex: 1 }} collapsable={false}>
                {pendingVersionApp && (
                    <TouchableOpacity
                        style={styles.updateBanner}
                        onPress={applyPendingUpdate}
                        activeOpacity={0.85}
                    >
                        <Text style={styles.updateBannerText}>✨ {t('newVersionAvailable')}</Text>
                    </TouchableOpacity>
                )}
                <AiLoadingBar visible={isAiLoading} />
                <ScrollView
                    contentContainerStyle={{ flex: 1 }}
                    refreshControl={
                        <RefreshControl
                            refreshing={refreshing}
                            onRefresh={onRefresh}
                            enabled={isAtTop} // Only enable if WebView says we are at top
                        />
                    }
                >
                    <WebView
                        key={webViewKey}
                        ref={webViewRef}
                        source={source}
                        style={styles.webview}
                        scalesPageToFit={true}
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
                        onRenderProcessGone={(e) => {
                            console.log('RunnerApp: WebView render process crashed. Recreating...', e.nativeEvent);
                            setWebViewKey(k => k + 1);
                        }}
                        onContentProcessDidTerminate={() => {
                            console.log('RunnerApp: WebView content process terminated (iOS). Recreating...');
                            setWebViewKey(k => k + 1);
                        }}
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
                </ScrollView>
            </View>



            <QRScannerOverlay webviewRef={webViewRef} />

            {/* First AI Use Modal */}
            <Modal
                visible={showFirstAiUseModal}
                transparent
                animationType="fade"
                onRequestClose={() => setShowFirstAiUseModal(false)}
            >
                <View style={styles.modalOverlay}>
                    <View style={styles.successModal}>
                        <Text style={styles.successEmoji}>✨</Text>
                        <Text style={styles.successTitle}>{t('firstAiUseTitle')}</Text>
                        <Text style={styles.successMessage}>
                            {t('firstAiUseMessage')}
                        </Text>
                        <TouchableOpacity
                            style={styles.successLinkBtn}
                            onPress={() => {
                                setShowFirstAiUseModal(false);
                                Linking.openURL(`appacadabra://spell/${appId}`);
                            }}
                        >
                            <Text style={styles.successLinkText}>{t('firstAiUseLink')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                            style={styles.successCloseBtn}
                            onPress={() => setShowFirstAiUseModal(false)}
                        >
                            <Text style={styles.successCloseText}>{t('close')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>
        </>
    );
}

// Main component that receives appId from native props (no expo-linking)
interface RunnerAppProps {
    appId?: number;
}

export default function RunnerApp(props: RunnerAppProps) {
    const appId = props.appId ?? null;

    // Hide splash screen as soon as RunnerApp mounts (cold-start via shortcut)
    useEffect(() => {
        SplashScreen.hideAsync().catch(() => { });
    }, []);

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
            <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
                <RunnerContent key={appId} appId={appId} />
            </SafeAreaView>
            <ManaConfirmModal />
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
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    successModal: {
        width: '85%',
        backgroundColor: '#1E1E1E',
        borderRadius: 20,
        padding: 24,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    successEmoji: {
        fontSize: 48,
        marginBottom: 16,
    },
    successTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: '#FFFFFF',
        textAlign: 'center',
        marginBottom: 8,
    },
    successMessage: {
        fontSize: 16,
        color: 'rgba(255,255,255,0.7)',
        textAlign: 'center',
        marginBottom: 24,
        lineHeight: 22,
    },
    successLinkBtn: {
        backgroundColor: colors.primary,
        paddingVertical: 14,
        paddingHorizontal: 24,
        borderRadius: 30,
        width: '100%',
        alignItems: 'center',
        marginBottom: 12,
    },
    successLinkText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 16,
    },
    successCloseBtn: {
        paddingVertical: 8,
    },
    successCloseText: {
        color: 'rgba(255,255,255,0.5)',
        fontSize: 14,
    },
    updateBanner: {
        backgroundColor: colors.success,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: 'center',
    },
    updateBannerText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 14,
    },
    videoModalContainer: {
        flex: 1,
        backgroundColor: '#000000',
        justifyContent: 'center',
        alignItems: 'center',
    },
    fullVideo: {
        width: '100%',
        height: '100%',
    },
    closeVideoButton: {
        position: 'absolute',
        top: 40,
        right: 20,
        width: 44,
        height: 44,
        borderRadius: 22,
        backgroundColor: 'rgba(0,0,0,0.5)',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 10,
    },
    closeVideoText: {
        color: '#FFFFFF',
        fontSize: 24,
        fontWeight: 'bold',
    },
});
