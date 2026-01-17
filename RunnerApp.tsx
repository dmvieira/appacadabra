import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    BackHandler,
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
    const [app, setApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [savedStorage, setSavedStorage] = useState<{ key: string; value: string }[]>([]);
    const [sharedContent, setSharedContent] = useState<any>(null);
    const [webViewReady, setWebViewReady] = useState(false);

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

    // Load app data
    useEffect(() => {
        async function loadApp() {
            if (!appId) return;
            const appData = await db.getAppById(appId);
            if (appData) {
                setApp(appData);
                const storage = await db.getStorageForApp(appData.id);
                setSavedStorage(storage.map(s => ({ key: s.key, value: s.value })));
            }
            setIsLoading(false);
        }
        loadApp();
    }, [appId]);

    // Handle Android back button
    useEffect(() => {
        const backHandler = BackHandler.addEventListener('hardwareBackPress', () => {
            // Close the activity when back is pressed
            BackHandler.exitApp();
            return true;
        });
        return () => backHandler.remove();
    }, []);

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

            // Delegate to shared handlers
            const handlerResult = await handleBridgeMessage(type, data, {
                webViewRef: webViewRef as React.RefObject<WebView>,
                appId: app?.id || null,
            });

            // Send callback if needed
            if (callbackName && webViewRef.current) {
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

    if (isLoading || !app) {
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

    const storageScript = createStorageRestoreScript(savedStorage);
    const combinedScript = `
        ${getInjectedJavaScript(app.id, getWebViewTranslations())}
        ${storageScript}
    `;

    return (
        <WebView
            ref={webViewRef}
            source={{ html: htmlContent, baseUrl: 'https://appacadabra.local/' }}
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
                    if (url.includes('localhost') || url.includes('appacadabra.local')) {
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
