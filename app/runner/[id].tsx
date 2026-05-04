import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    TextInput,
    ScrollView,
    Modal,
    Alert,
    Platform,
    KeyboardAvoidingView,
    RefreshControl,
    AppState,
    DeviceEventEmitter,
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import AiLoadingBar from '../../components/AiLoadingBar';
import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import { Audio } from 'expo-av';
import { useBridgeUIStore } from '../../lib/bridgeUIStore';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import { Paths } from 'expo-file-system/next';
import * as Sharing from 'expo-sharing';
import * as Contacts from 'expo-contacts';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AuthSession from 'expo-auth-session';
import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { useAppStore } from '../../lib/store';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript, createSharedContentSetupScript, getScrollDetectionScript, createMediaCallbackScript, createMediaChunkScript, ExpandedStorageItem } from '../../lib/bridges/injectedJS';
import { handleBridgeMessage, cleanupAllMedia, expandStorageBlobMarkers, migrateStorageBlobsToFiles, registerPendingMediaBlob, saveAiMediaToFile, AI_MEDIA_MIME, buildBlobMarker } from '../../lib/bridges/messageHandlers';
import { waitForExistingJob } from '../../lib/firebase';
import * as ai from '../../lib/api/ai';
import * as db from '../../lib/database/db';
import { colors, spacing, borderRadius } from '../../lib/theme';
import { GeneratedApp, AppVersion } from '../../lib/database/types';
import { useSpeechToText } from '../../lib/useSpeech';
import { t, getWebViewTranslations } from '../../lib/i18n';
import QRScannerOverlay from '../../components/QRScannerOverlay';
import { useManaStore } from '../../lib/manaStore';
import { reloadStorageForApp, getStorageFromCache } from '../../lib/storageCache';
import { cleanupWatchersForApp as cleanupSheetsWatchers, cleanupEditModeForApp as cleanupSheetsEditMode } from '../../lib/capabilities/sheets';
import { cleanupWatchersForApp as cleanupDocsWatchers, cleanupEditModeForApp as cleanupDocsEditMode } from '../../lib/capabilities/docs';
import { cleanupWatchersForApp as cleanupFormsWatchers, cleanupEditModeForApp as cleanupFormsEditMode } from '../../lib/capabilities/forms';
import AsyncStorage from '@react-native-async-storage/async-storage';
import EditorOnboarding from '../../components/EditorOnboarding';
import { logEditorTabOpened, logEditorAiEditSubmitted, logEditorVersionRestored, logEditorVersionDeleted } from '../../lib/analytics';
import { ensureViewportMeta } from '../../lib/htmlUtils';

const EDITOR_ONBOARDING_KEY = 'appacadabra_editor_onboarding_seen';

function isLargeAiPayload(type: string, data: any): boolean {
    if (type === 'AI_GENERATE_VIDEO') return true;
    let chars = (data?.prompt?.length || 0);
    if (data?.images) chars += data.images.reduce((s: number, i: string) => s + (i?.length || 0), 0);
    if (data?.videos) chars += data.videos.reduce((s: number, v: string) => s + (v?.length || 0), 0);
    if (data?.audios) chars += data.audios.reduce((s: number, a: string) => s + (a?.length || 0), 0);
    return chars > 2_000_000;
}

// AI_MEDIA_EXT, AI_MEDIA_MIME, saveAiMediaToFile, buildBlobMarker imported from messageHandlers

// Configure notifications
Notifications.setNotificationHandler({
    handleNotification: async () => ({
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
    }),
});

// ============= AI Recovery Helpers =============

/** Escapes a string to be embedded safely as a JSON value inside an injected JS template literal. */
function escapeForJsInject(str: string): string {
    return str
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"')
        .replace(/\n/g, '\\n')
        .replace(/\r/g, '\\r')
        .replace(/\t/g, '\\t')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029')
        .replace(/`/g, '\\`')
        .replace(/\$\{/g, '\\${');
}

/**
 * Delivers a cached AI result to the webview.
 * Text results use an ACK postMessage so we only mark delivered after confirmation.
 * Media results are delivered via the existing chunked mechanism and marked delivered immediately.
 */
async function deliverCachedAiResult(
    entry: db.WebviewAiCacheEntry,
    webView: WebView
): Promise<void> {
    let { id: cacheId, callbackName, result, mediaLocalPath, resultMediaMime, action, success } = entry;

    // Remove any dynamic suffix from previous execution session (used by generateVideo/generateImage)
    if (callbackName.includes('_intercept_')) {
        callbackName = callbackName.split('_intercept_')[0];
    }

    const ackScript = `window.ReactNativeWebView?.postMessage(JSON.stringify({type:'AI_CALLBACK_ACK',cacheId:${cacheId}}));`;

    if (!success) {
        // Failure — fire callback with false and send ACK
        // Give the web app 300ms to fully mount its DOM components before firing the callback
        const script = `(function(){
            setTimeout(function() {
                try { if(typeof window["${callbackName}"]==='function') window["${callbackName}"](false,null); } catch(e){}
                finally { ${ackScript} }
            }, 300);
        })(); true;`;
        webView.injectJavaScript(script);
        return;
    }

    if (mediaLocalPath) {
        const mime = resultMediaMime ?? AI_MEDIA_MIME[action] ?? 'application/octet-stream';
        try {
            if (action === 'AI_GENERATE_VIDEO') {
                // Video delivered as file:// URL — mark delivered immediately (no ACK path for video)
                const fileUrl = `file://${mediaLocalPath}`;
                const script = createCallbackScript(callbackName, true, fileUrl);
                // Delay to ensure the video node exists
                webView.injectJavaScript(`setTimeout(function(){ ${script} }, 300); true;`);
                await db.markWebviewAiCacheDelivered(cacheId);
            } else {
                const rawB64 = (await FileSystem.readAsStringAsync(`file://${mediaLocalPath}`, {
                    encoding: FileSystem.EncodingType.Base64,
                })).replace(/[\r\n]/g, '');
                const marker = buildBlobMarker(mime, callbackName, mediaLocalPath);
                webView.injectJavaScript(`setTimeout(function(){ ${createMediaCallbackScript(callbackName, true, marker)} }, 300); true;`);
                const CHUNK_SIZE = 64 * 1024;
                const totalChunks = Math.ceil(rawB64.length / CHUNK_SIZE);
                for (let i = 0; i < totalChunks; i++) {
                    const chunk = rawB64.substring(i * CHUNK_SIZE, Math.min((i + 1) * CHUNK_SIZE, rawB64.length));
                    webView.injectJavaScript(createMediaChunkScript(marker, chunk, i, totalChunks));
                }
                // Mark delivered immediately — chunk delivery is fire-and-forget
                await db.markWebviewAiCacheDelivered(cacheId);
            }
        } catch (e) {
            console.warn('[Runner] Recovery: media delivery failed, cleaning up entry', cacheId, e);
            await db.markWebviewAiCacheDelivered(cacheId);
        }
        return;
    }

    // Text result — wrap with try/finally ACK, with a short delay for UI initialization
    const escaped = escapeForJsInject(result);
    const script = `(function(){
        console.log('[AppacadabraAI Recovery] Scheduling delivery for callback: ${callbackName}');
        setTimeout(function() {
            console.log('[AppacadabraAI Recovery] Firing callback: ${callbackName}');
            try {
                if(typeof window["${callbackName}"]==='function') {
                    console.log('[AppacadabraAI Recovery] Found on window object');
                    window["${callbackName}"](true,"${escaped}");
                } else { 
                    console.log('[AppacadabraAI Recovery] Not on window, attempting eval fallback');
                    try { 
                        eval('${callbackName}(true,"${escaped}")'); 
                        console.log('[AppacadabraAI Recovery] Eval fallback succeeded');
                    } catch(e) {
                         console.error('[AppacadabraAI Recovery] Eval fallback failed:', e);
                    } 
                }
            } catch(e){ console.error('[AppacadabraAI Recovery] Callback threw:',e); }
            finally { 
                console.log('[AppacadabraAI Recovery] Sending ACK to native bridge');
                ${ackScript} 
            }
        }, 1500); // 1.5s delay to ensure robust framework mounting
    })(); true;`;
    webView.injectJavaScript(script);
}

/**
 * Re-attaches a Firestore listener for a job that was still processing when the webview reloaded.
 * Uses listeningJobIds to prevent duplicate listeners on repeated pull-to-refresh.
 */
function reattachJobListener(
    entry: db.WebviewAiCacheEntry,
    webViewRef: React.RefObject<WebView | null>,
    appId: number,
    listeningJobIds: React.MutableRefObject<Set<string>>
): void {
    if (listeningJobIds.current.has(entry.jobId!)) return;
    listeningJobIds.current.add(entry.jobId!);

    waitForExistingJob(entry.jobId!).then(async (genResult) => {
        listeningJobIds.current.delete(entry.jobId!);
        await db.updateWebviewAiCacheResult(entry.id, genResult.text, null, null, true);
        if (webViewRef.current) {
            await deliverCachedAiResult({ ...entry, result: genResult.text, success: 1 }, webViewRef.current);
        }
    }).catch(async (err) => {
        console.warn('[Runner] reattachJobListener: job failed or timed out', entry.jobId, err);
        listeningJobIds.current.delete(entry.jobId!);
        await db.markWebviewAiCacheDelivered(entry.id);
    });
}

export default function RunnerScreen() {
    const { id, edit, share, payload } = useLocalSearchParams<{ id: string; edit?: string; share?: string; payload?: string }>();
    const isFocused = useIsFocused();
    const router = useRouter();
    const insets = useSafeAreaInsets();

    // Edit mode states (declare early for use in effects)
    const isEditMode = edit === 'true';

    // On Android, spells always run inside RunnerActivity (separate task/window).
    // This expo-router screen is only valid on Android in edit mode.
    // If it ever mounts in run mode on Android (URL leak from expo-router internals), go back immediately.
    useEffect(() => {
        if (Platform.OS === 'android' && !edit) {
            console.log('RunnerScreen: Safety net — Android run mode should use RunnerActivity. Going back.');
            router.back();
        }
    }, []);

    if (Platform.OS === 'android' && !edit) {
        return null;
    }
    const webViewRef = useRef<WebView>(null);
    const viewContainerRef = useRef<View>(null);
    const [localSharedContent, setLocalSharedContent] = useState<any>(null);
    const [lastProcessedPayload, setLastProcessedPayload] = useState<string | null>(null);

    // Set global webViewRef for overlays
    useEffect(() => {
        // We pass the ref object itself, not the current value immediately, 
        // but store expects RefObject so it's fine.
        // Actually, we want to update the store whenever the ref attaches.
        // But since we pass the RefObject, the store holds the RefObject which always has .current
        useBridgeUIStore.getState().setWebViewRef(webViewRef as any);
    }, []); // Run once, the ref object is stable

    // Cancel pending mana confirmation when runner loses focus
    useEffect(() => {
        if (!isFocused) {
            useBridgeUIStore.getState().resolveManaConfirmation(false);
        }
    }, [isFocused]);

    // Track elapsed seconds during AI loading
    useEffect(() => {
        if (!isAiLoading) {
            setAiElapsedSeconds(0);
            setAiIsLargePayload(false);
            return;
        }
        setAiElapsedSeconds(0);
        const interval = setInterval(() => setAiElapsedSeconds(s => s + 1), 1000);
        return () => clearInterval(interval);
    }, [isAiLoading]);

    // Cleanup all media when leaving screen or app goes to background
    useEffect(() => {
        const subscription = AppState.addEventListener('change', (nextState) => {
            if (nextState === 'background' || nextState === 'inactive') {
                cleanupAllMedia();
            }
        });
        return () => {
            subscription.remove();
            cleanupAllMedia();
            if (isEditMode) {
                // Edit mode: only clear edit-mode state, preserve runner watchers
                cleanupSheetsEditMode(Number(id));
                cleanupDocsEditMode(Number(id));
                cleanupFormsEditMode(Number(id));
            } else {
                // Run mode: full cleanup
                cleanupSheetsWatchers(Number(id)); cleanupSheetsEditMode(Number(id));
                cleanupDocsWatchers(Number(id)); cleanupDocsEditMode(Number(id));
                cleanupFormsWatchers(Number(id)); cleanupFormsEditMode(Number(id));
            }
        };
    }, []);

    // Clean up watchers when WebView is recreated (pull-to-refresh or error reload)
    const isFirstWebViewKeyRenderRunner = useRef(true);
    useEffect(() => {
        if (isFirstWebViewKeyRenderRunner.current) { isFirstWebViewKeyRenderRunner.current = false; return; }
        if (isEditMode) {
            // Edit mode: only clear edit-mode state, don't kill the runner's active watchers
            cleanupSheetsEditMode(Number(id));
            cleanupDocsEditMode(Number(id));
            cleanupFormsEditMode(Number(id));
        } else {
            // Run mode: full cleanup of both watchers and edit-mode state
            cleanupSheetsWatchers(Number(id)); cleanupSheetsEditMode(Number(id));
            cleanupDocsWatchers(Number(id)); cleanupDocsEditMode(Number(id));
            cleanupFormsWatchers(Number(id)); cleanupFormsEditMode(Number(id));
        }
    }, [webViewKey, id, isEditMode]);

    const [app, setApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [isLocked, setIsLocked] = useState(false);
    const [consoleLogs, setConsoleLogs] = useState<string[]>([]);
    const [refreshing, setRefreshing] = useState(false);
    const [isAtTop, setIsAtTop] = useState(true);
    const [webViewError, setWebViewError] = useState(false);
    const [webViewKey, setWebViewKey] = useState(0);
    const [pendingVersionApp, setPendingVersionApp] = useState<GeneratedApp | null>(null);
    const [storageClearedPending, setStorageClearedPending] = useState(false);
    const [showFirstAiUseModal, setShowFirstAiUseModal] = useState(false);
    const [isAiLoading, setIsAiLoading] = useState(false);
    const [aiElapsedSeconds, setAiElapsedSeconds] = useState(0);
    const [aiIsLargePayload, setAiIsLargePayload] = useState(false);
    const [lastUrl, setLastUrl] = useState<string | null>(null);
    const isRestoring = useRef(true); // Prevent infinite reload loops from window.location.replace

    // Subscribe to store apps to react to background updates (async jobs)
    const storeApps = useAppStore(state => state.apps);


    // Saved localStorage items
    const [savedStorage, setSavedStorage] = useState<ExpandedStorageItem[]>([]);
    const [storageLoaded, setStorageLoaded] = useState(false);
    // Use ref to ensure storage is available synchronously for script creation
    const savedStorageRef = useRef<ExpandedStorageItem[]>([]);
    // Tracks jobIds already being re-listened to — prevents duplicate listeners on repeated pull-to-refresh
    const listeningJobIds = useRef<Set<string>>(new Set());

    const htmlContent = useMemo(() => {
        if (!app) return '';
        const safeCode = ensureViewportMeta(app.code);
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
      ${safeCode}
    </body>
    </html>
  `;
    }, [app?.id, app?.code]);

    // Stable part — only changes when app/editMode changes, not on runtime storage writes
    const baseInjectedScript = useMemo(() => {
        if (!app) return '';
        return getInjectedJavaScript(app.id, getWebViewTranslations(), isEditMode);
    }, [app?.id, isEditMode]);

    // Computed inline so injectedJavaScriptBeforeContentLoaded always has fresh (expanded) data
    const combinedScript = app ? `
        ${baseInjectedScript}
        ${createStorageRestoreScript(savedStorageRef.current)}
        ${getScrollDetectionScript()}
    ` : '';

    const source = useMemo(() => {
        if (!app) return { html: '' };
        return {
            html: htmlContent,
            baseUrl: `https://app-${app.id}.appacadabra.local/`
        };
    }, [htmlContent, app?.id]);

    // Initial load
    // Initial load - App + Storage + Biometrics
    useEffect(() => {
        const loadAppData = async () => {
            if (!id) return;
            console.log('RunnerScreen: Loading app data for id:', id);

            try {
                const loadedApp = await db.getAppById(Number(id));

                if (loadedApp) {
                    setApp(loadedApp);

                    // Load last saved URL
                    try {
                        const savedUrl = await AsyncStorage.getItem(`appacadabra_last_url_${loadedApp.id}`);
                        if (savedUrl) {
                            console.log(`[Runner] Loaded saved URL for app ${loadedApp.id}: ${savedUrl}`);
                            setLastUrl(savedUrl);
                        }
                    } catch (e) {
                        console.warn('[Runner] Failed to load last URL:', e);
                    }

                    // Load storage immediately - CRITICAL for injection
                    try {
                        console.log('RunnerScreen: Pre-loading storage for app', loadedApp.id);
                        const storageItems = await reloadStorageForApp(loadedApp.id);
                        console.log('RunnerScreen: Storage loaded:', storageItems.length, 'items');

                        // Migrate any legacy base64 blobs stored directly in DB to files
                        await migrateStorageBlobsToFiles(loadedApp.id);
                        // Expand blob markers back to base64 for WebView injection
                        const expandedItems = await expandStorageBlobMarkers(storageItems);

                        // Set both ref (for sync injection) and state (for debug UI)
                        savedStorageRef.current = expandedItems;
                        setSavedStorage(expandedItems);
                        setStorageLoaded(true);
                    } catch (e) {
                        console.error('RunnerScreen: Error loading storage:', e);
                        // Still mark as loaded so we don't block
                        setStorageLoaded(true);
                    }

                    // Check biometric authentication
                    if (loadedApp.requiresBiometric) {
                        // Determine if we should authenticate immediately
                        try {
                            const hasHardware = await LocalAuthentication.hasHardwareAsync();
                            const isEnrolled = await LocalAuthentication.isEnrolledAsync();

                            if (hasHardware && isEnrolled) {
                                const result = await LocalAuthentication.authenticateAsync({
                                    promptMessage: t('biometricRequired'),
                                    fallbackLabel: t('usePassword') || 'Use Password',  // Fallback if key missing
                                    disableDeviceFallback: false,
                                });

                                if (!result.success) {
                                    setIsLocked(true);
                                }
                            } else {
                                // If biometric is required but not available on device, we lock it
                                setIsLocked(true);
                                Alert.alert(t('error'), t('biometricsNotAvailable') || 'Biometrics not available');
                            }
                        } catch (e) {
                            console.error('Biometric init error:', e);
                            setIsLocked(true);
                        }
                    }
                } else {
                    console.error('RunnerScreen: App not found for id:', id);
                }
            } catch (err) {
                console.error('RunnerScreen: Error loading app data:', err);
            } finally {
                setIsLoading(false);
            }
        };

        loadAppData();
    }, [id]);

    // Authentication helper
    const authenticate = async () => {
        try {
            const hasHardware = await LocalAuthentication.hasHardwareAsync();
            const isEnrolled = await LocalAuthentication.isEnrolledAsync();

            if (!hasHardware || !isEnrolled) {
                Alert.alert(t('error'), t('biometricsNotAvailable') || 'Biometrics not available');
                return;
            }

            const result = await LocalAuthentication.authenticateAsync({
                promptMessage: t('biometricRequired'),
                fallbackLabel: t('usePassword') || 'Use Password',
                disableDeviceFallback: false,
            });

            if (result.success) {
                setIsLocked(false);
            }
        } catch (e) {
            console.error('Biometric retry error:', e);
        }
    };

    const applyPendingUpdate = useCallback(() => {
        if (pendingVersionApp) {
            setApp(pendingVersionApp);
            setPendingVersionApp(null);
        }
    }, [pendingVersionApp]);

    const applyStorageReload = useCallback(async () => {
        const appId = Number(id);
        setStorageClearedPending(false);
        const items = await db.getStorageForApp(appId);
        const storageItems = items.map((s: { key: string; value: string }) => ({ key: s.key, value: s.value }));
        const expandedItems = await expandStorageBlobMarkers(storageItems);
        savedStorageRef.current = expandedItems;
        setSavedStorage(expandedItems);

        // Smooth sync: inject update instead of full reload
        if (webViewRef.current) {
            const script = createStorageRestoreScript(expandedItems);
            webViewRef.current.injectJavaScript(script);
        }
    }, [id]);

    const onRefresh = useCallback(async () => {
        if (!app) return;
        setRefreshing(true);
        try {
            const loadedApp = await db.getAppById(app.id);
            if (loadedApp) {
                setApp(loadedApp);
                // Also reload storage and expand markers
                const storageItems = await reloadStorageForApp(loadedApp.id);
                const expandedItems = await expandStorageBlobMarkers(storageItems);
                savedStorageRef.current = expandedItems;
                setSavedStorage(expandedItems);
            }
        } catch (e) {
            console.error('RunnerScreen: Refresh error:', e);
        } finally {
            setRefreshing(false);
        }
    }, [app]);

    // Storage Update/Cleared Listener
    useEffect(() => {
        const appId = Number(id);
        const sub1 = DeviceEventEmitter.addListener('STORAGE_CLEARED', ({ appId: clearedId }: { appId: number }) => {
            if (clearedId === appId) {
                // For clear, we show a banner to be safe as it's a major state change
                setStorageClearedPending(true);
            }
        });
        const sub2 = DeviceEventEmitter.addListener('STORAGE_UPDATED', ({ appId: updId }: { appId: number }) => {
            if (updId === appId && !isEditMode) {
                // For individual updates, we can sync silently and smoothly.
                // Skip in edit mode: injecting JS from a runner's storage write would
                // dismiss the Android keyboard and cause layout flashes across the app.
                applyStorageReload();
            }
        });
        return () => {
            sub1.remove();
            sub2.remove();
        };
    }, [id, applyStorageReload, isEditMode]);

    // React to store updates (e.g. async job finished)
    useEffect(() => {
        if (!app || !id) return;
        const updatedApp = storeApps.find(a => a.id === Number(id));

        if (updatedApp && updatedApp.currentVersion > app.currentVersion) {
            console.log('RunnerScreen: New version detected:', updatedApp.currentVersion, 'focused:', isFocused);
            // User is viewing the runner or it's in background → show banner, never force reload and destroy state
            setPendingVersionApp(updatedApp);
        }
    }, [storeApps, app, id, isFocused]);



    // Listen for edit completion signal to navigate back
    const lastCompletedEditAppId = useAppStore(state => state.lastCompletedEditAppId);
    const clearLastCompletedEdit = useAppStore(state => state.clearLastCompletedEdit);

    // Sync __IS_EDIT_MODE__ into the running WebView without forcing a remount
    useEffect(() => {
        if (webViewRef.current) {
            webViewRef.current.injectJavaScript(`window.__IS_EDIT_MODE__ = ${isEditMode}; true;`);
        }
    }, [isEditMode]);

    // Clear AI loading bar when entering edit mode (dismiss any in-flight play mode calls)
    useEffect(() => {
        if (isEditMode) {
            setIsAiLoading(false);
        }
    }, [isEditMode]);

    useEffect(() => {
        if (lastCompletedEditAppId && lastCompletedEditAppId === Number(id) && isEditMode) {
            console.log('RunnerScreen: Edit completed, navigating back to app list');
            clearLastCompletedEdit();
            router.back();
        }
    }, [lastCompletedEditAppId, id, isEditMode, clearLastCompletedEdit, router]);
    const [showEditSheet, setShowEditSheet] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');
    const [selectedElement, setSelectedElement] = useState<{ html: string; tagName: string; preview: string } | null>(null);
    const [isEditing, setIsEditing] = useState(false);

    // Restore failed EDIT prompt — pre-fill and open edit sheet on mount
    useEffect(() => {
        if (lastFailedPrompt?.type === 'edit' && lastFailedPrompt.appId === Number(id)) {
            setEditPrompt(lastFailedPrompt.text);
            clearLastFailedPrompt();
            setShowEditSheet(true);
        }
    }, []); // only on mount

    // Speech to text for edit prompt
    const { isListening, transcript, startListening, stopListening } = useSpeechToText();
    const [editPromptBeforeSpeech, setEditPromptBeforeSpeech] = useState('');

    // Selection mode state
    const [isSelectionMode, setIsSelectionMode] = useState(false);

    // Advanced mode toggle
    const [showAdvanced, setShowAdvanced] = useState(false);
    const [navCollapsed, setNavCollapsed] = useState(false);

    // Editor onboarding
    const [showEditorOnboarding, setShowEditorOnboarding] = useState(false);
    const [editorOnboardingChecked, setEditorOnboardingChecked] = useState(false);

    // Check if editor onboarding should be shown
    useEffect(() => {
        if (!isEditMode) return;
        const check = async () => {
            try {
                const seen = await AsyncStorage.getItem(EDITOR_ONBOARDING_KEY);
                if (!seen) {
                    setShowEditorOnboarding(true);
                }
            } catch (e) {
                console.error('Error checking editor onboarding:', e);
            } finally {
                setEditorOnboardingChecked(true);
            }
        };
        check();
    }, [isEditMode]);

    const handleEditorOnboardingComplete = async () => {
        try {
            await AsyncStorage.setItem(EDITOR_ONBOARDING_KEY, 'true');
        } catch (e) {
            console.error('Error saving editor onboarding state:', e);
        }
        setShowEditorOnboarding(false);
    };

    // Manual editor
    const [showManualEditor, setShowManualEditor] = useState(false);
    const [manualCode, setManualCode] = useState('');
    const [searchQuery, setSearchQuery] = useState('');
    const [searchResultCount, setSearchResultCount] = useState(0);
    const [currentSearchIndex, setCurrentSearchIndex] = useState(0);
    const [searchMatches, setSearchMatches] = useState<{ start: number; end: number }[]>([]);
    const [searchSelection, setSearchSelection] = useState<{ start: number; end: number } | null>(null);
    const editorScrollRef = useRef<ScrollView>(null);
    const codeInputRef = useRef<TextInput>(null);

    // Scroll to search result and set selection programmatically
    const scrollToSearchResult = useCallback((match: { start: number; end: number }) => {
        if (!editorScrollRef.current || !codeInputRef.current) return;

        const codeBefore = manualCode.substring(0, match.start);
        const lines = codeBefore.split('\n');
        const lineNumber = lines.length - 1;
        const lineHeight = 18;
        const padding = 16;
        const y = padding + (lineNumber * lineHeight);
        // Better scroll target to center the line
        const targetY = Math.max(0, y - (10 * lineHeight));

        if (Number.isFinite(targetY)) {
            editorScrollRef.current.scrollTo({ y: targetY, animated: true });
        }

        // Set text selection after a small delay to ensure scroll completes
        setTimeout(() => {
            codeInputRef.current?.setNativeProps({ selection: match });
        }, 150);
    }, [manualCode]);

    // Render code with search highlights - optimized
    const renderHighlightedCode = useCallback(() => {
        if (!searchQuery || searchMatches.length === 0) {
            return <Text style={styles.codeHighlightText}>{manualCode}</Text>;
        }

        // Limit number of highlights to prevent performance issues
        // If too many matches, only highlight current one + first 50
        const MAX_HIGHLIGHTS = 50;
        const visibleMatches = searchMatches.length > MAX_HIGHLIGHTS
            ? searchMatches.filter((_, idx) => idx === currentSearchIndex || idx < MAX_HIGHLIGHTS)
            : searchMatches;

        const parts: React.ReactNode[] = [];
        let lastIndex = 0;

        visibleMatches.forEach((match, idx) => {
            // Text before match (only if gap)
            if (match.start > lastIndex) {
                // Optimization: don't render massive text chunks if we are skipping matches
                // Just render the text between previous match and this one
                parts.push(
                    <Text key={`pre-${match.start}`} style={styles.codeHighlightText}>
                        {manualCode.substring(lastIndex, match.start)}
                    </Text>
                );
            }
            // Highlighted match
            const isCurrent = (searchMatches[currentSearchIndex] === match);
            parts.push(
                <Text
                    key={`match-${match.start}`}
                    style={[
                        styles.codeHighlightText,
                        styles.searchHighlight,
                        isCurrent && styles.searchHighlightCurrent
                    ]}
                >
                    {manualCode.substring(match.start, match.end)}
                </Text>
            );
            lastIndex = match.end;
        });

        // Text after last visible match
        if (lastIndex < manualCode.length) {
            parts.push(
                <Text key="post" style={styles.codeHighlightText}>
                    {manualCode.substring(lastIndex)}
                </Text>
            );
        }

        return parts;
    }, [manualCode, searchQuery, searchMatches, currentSearchIndex]);

    // Debounced search effect
    useEffect(() => {
        const timer = setTimeout(() => {
            if (searchQuery) {
                const regex = new RegExp(searchQuery.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
                const matches: { start: number; end: number }[] = [];
                let match;
                while ((match = regex.exec(manualCode)) !== null) {
                    matches.push({ start: match.index, end: match.index + match[0].length });
                }
                setSearchMatches(matches);
                setSearchResultCount(matches.length);

                if (matches.length > 0) {
                    // If no current selection or invalid index, reset to 0
                    if (currentSearchIndex >= matches.length) {
                        setCurrentSearchIndex(0);
                        scrollToSearchResult(matches[0]);
                    } else {
                        // Keep current index if valid
                        scrollToSearchResult(matches[currentSearchIndex]);
                    }
                } else {
                    setCurrentSearchIndex(0);
                }
            } else {
                setSearchMatches([]);
                setSearchResultCount(0);
                setCurrentSearchIndex(0);
            }
        }, 500); // 500ms debounce

        return () => clearTimeout(timer);
    }, [searchQuery, manualCode]);

    // Update edit prompt when speech recognition gives results
    useEffect(() => {
        if (transcript && isListening) {
            setEditPrompt(editPromptBeforeSpeech + (editPromptBeforeSpeech ? ' ' : '') + transcript);
        }
    }, [transcript, isListening, editPromptBeforeSpeech]);

    // Toggle speech listening for edit prompt
    const toggleEditListening = () => {
        if (isListening) {
            stopListening();
        } else {
            setEditPromptBeforeSpeech(editPrompt);
            startListening();
        }
    };

    // Version history
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState<AppVersion[]>([]);

    const { updateAppCode, updateAppWithAI, sharedContent, clearSharedContent, lastFailedPrompt, clearLastFailedPrompt } = useAppStore();

    console.log('RunnerScreen: RENDER id:', id, 'isFocused:', isFocused, 'appId:', app?.id || '(loading)');

    // CHECK DROP-BOX FILE on mount and on focus
    const checkDropBox = useCallback(async () => {
        const dropBoxPath = FileSystem.cacheDirectory + 'pending_share.json';
        console.log('Runner: Checking drop-box at:', dropBoxPath);
        try {
            const info = await FileSystem.getInfoAsync(dropBoxPath);
            if (info.exists) {
                const contentStr = await FileSystem.readAsStringAsync(dropBoxPath);
                const content = JSON.parse(contentStr);

                // Only consume if this drop-box is for THIS app
                if (content.targetAppId === parseInt(id)) {
                    console.log('Runner: Drop-box found, loading content for app', id);
                    setLocalSharedContent(content);

                    // Delete immediately to prevent reuse
                    await FileSystem.deleteAsync(dropBoxPath, { idempotent: true });
                } else {
                    console.log('Runner: Drop-box is for different app', content.targetAppId, 'vs', id);
                }
            }
        } catch (e) {
            // File doesn't exist or parse error - this is normal
            console.log('Runner: No drop-box or read error:', e);
        }
    }, [id]);

    // Check on mount
    useEffect(() => {
        checkDropBox();
    }, [checkDropBox]);

    // Check on focus
    useEffect(() => {
        if (isFocused) {
            console.log('Runner: Focused, checking drop-box');
            checkDropBox();
        }
    }, [isFocused, checkDropBox]);

    useEffect(() => {
        useAppStore.subscribe((state) => {
            console.log('RunnerScreen: Direct Store Update Substription:', state.sharedContent?.uri);
        });
    }, []);



    // Debug panel states
    const [showDebugPanel, setShowDebugPanel] = useState(false);
    const [networkLogs, setNetworkLogs] = useState<{ url: string; method: string; status?: number; time: number; duration?: number; responseBody?: string }[]>([]);

    // Load app data
    // REDUNDANT LOAD REMOVED - merged into primary load effect above


    const handleLoadEnd = useCallback(async () => {
        console.log('Runner: handleLoadEnd called');

        if (webViewRef.current && app) {
            // Restore URL/Hash if it's different from base, securely wrapped with isRestoring
            if (isRestoring.current && lastUrl && (lastUrl.includes('#') || lastUrl.includes('?'))) {
                isRestoring.current = false; // consume the restore ticket
                console.log(`[Runner] Restoring last URL: ${lastUrl}`);
                if (lastUrl.includes('#')) {
                    const hash = lastUrl.split('#')[1];
                    webViewRef.current.injectJavaScript(`window.location.hash = "${hash}"; true;`);
                } else {
                    webViewRef.current.injectJavaScript(`window.location.replace("${lastUrl}"); true;`);
                }
            }

            // Use fresh cache to include runtime writes made since mount
            const storageToRestore = getStorageFromCache(app.id);
            // Expand blob markers back to base64 for WebView injection
            const expandedToRestore = await expandStorageBlobMarkers(storageToRestore);
            savedStorageRef.current = expandedToRestore;
            console.log('Runner: Injecting', expandedToRestore.length, 'storage items from cache');
            const script = createStorageRestoreScript(expandedToRestore);
            webViewRef.current.injectJavaScript(script);

            // Recover undelivered AI responses (skip in edit mode — would re-trigger AI callbacks)
            if (!isEditMode) try {
                const pending = await db.getUndeliveredWebviewAiCache(app.id);
                for (const entry of pending) {
                    if (!webViewRef.current) break;
                    const hasResult = entry.result !== '' || entry.mediaLocalPath !== null;
                    if (hasResult) {
                        // Result already cached — deliver directly to webview
                        await deliverCachedAiResult(entry, webViewRef.current);
                    } else if (entry.jobId) {
                        // Job still processing — re-attach Firestore listener
                        reattachJobListener(entry, webViewRef, app.id, listeningJobIds);
                    } else {
                        // No jobId and no result — job died before doc was created; clean up
                        await db.markWebviewAiCacheDelivered(entry.id);
                    }
                }
            } catch (e) {
                console.warn('[Runner] AI cache recovery failed:', e);
            }

            // CHECK BOTH SOURCES: Local File Payload OR Global Store
            const contentToInject = localSharedContent || sharedContent;
            const shouldInject = !!contentToInject && isFocused;

            console.log('Runner: Checking injection. hasContent:', !!contentToInject, 'isFocused:', isFocused);

            if (shouldInject) {
                console.log('Runner: Injecting shared content setup (onLoadEnd)');
                const setupScript = createSharedContentSetupScript(getWebViewTranslations());
                webViewRef.current.injectJavaScript(setupScript);

                setTimeout(() => {
                    if (webViewRef.current) {
                        console.log('Runner: Posting shared content message (onLoadEnd)');
                        webViewRef.current.postMessage(JSON.stringify({
                            type: 'SET_SHARED_CONTENT',
                            payload: contentToInject
                        }));

                        console.log('Runner: Clearing shared content');
                        if (localSharedContent) setLocalSharedContent(null);
                        clearSharedContent();
                    }
                }, 500);
            }
        }
    }, [localSharedContent, sharedContent, clearSharedContent, isFocused, app, isEditMode]);

    // Handle incoming share when already loaded (hot update)
    useEffect(() => {
        const contentToInject = localSharedContent || sharedContent;
        const shouldInject = !!contentToInject && webViewRef.current && isFocused;

        if (shouldInject) {
            console.log('Runner: Shared content updated while running (focused)');

            const setupScript = createSharedContentSetupScript(getWebViewTranslations());
            webViewRef.current?.injectJavaScript(setupScript);

            setTimeout(() => {
                if (webViewRef.current) {
                    console.log('Runner: Posting shared content message (useEffect)');
                    webViewRef.current.postMessage(JSON.stringify({
                        type: 'SET_SHARED_CONTENT',
                        payload: contentToInject
                    }));

                    console.log('Runner: Clearing shared content (useEffect)');
                    if (localSharedContent) setLocalSharedContent(null);
                    clearSharedContent();
                }
            }, 500);
        }
    }, [localSharedContent, sharedContent, clearSharedContent, isFocused]);

    // Load version history
    const loadVersions = useCallback(async () => {
        if (!app) return;
        const vers = await db.getVersionsForApp(app.id);
        setVersions(vers);
    }, [app]);

    // Handle messages from WebView
    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
        let callbackName: string | undefined;
        try {
            const messageStr = event.nativeEvent.data;
            // console.log('RAW WebView Message:', messageStr); // Uncomment for deep debug

            const message = JSON.parse(messageStr);
            const { type, data, appId } = message;
            callbackName = message.callbackName;

            // Log non-frequent messages
            if (type !== 'CONSOLE_LOG' && type !== 'NETWORK_LOG') {
                console.log('WebView Message received:', type);
            } else if (Math.random() > 0.95) {
                // Sample some logs just to prove they are arriving
                console.log('Sample Log/Network message received:', type);
            }

            let success = true;
            let result = '';
            let deferredCallback = false;
            let mediaLocalPath: string | undefined;
            let cacheResult: string | undefined;
            let cacheId: number | null = null;

            switch (type) {
                // ============= Scroll Status for Smart Refresh =============
                case 'SCROLL_STATUS':
                    setIsAtTop(data.isAtTop);
                    return; // No callback needed

                // ============= AI Handlers =============
                case 'ELEMENT_SELECTED':
                    // User selected an element in selection mode
                    setIsSelectionMode(false);
                    // Turn off selection mode in webview
                    if (webViewRef.current) {
                        webViewRef.current.injectJavaScript('window.toggleSelectionMode(false); true;');
                    }

                    const { tagName, html, preview } = data;
                    setSelectedElement({ html, tagName, preview });
                    setEditPrompt('');  // Clear prompt for new instruction
                    setShowEditSheet(true);
                    break;

                // ============= Console Log =============
                case 'CONSOLE_LOG':
                    const logEntry = `[${data.type}] ${data.message}`;
                    setConsoleLogs(prev => [...prev.slice(-99), logEntry]);
                    break;

                case 'NETWORK_LOG':
                    setNetworkLogs(prev => [...prev.slice(-49), {
                        url: data.url,
                        method: data.method,
                        status: data.status,
                        time: Date.now(),
                        duration: data.duration,
                        responseBody: data.responseBody || data.error,
                    }]);
                    break;

                case 'AI_CALLBACK_ACK': {
                    // Webview confirms it received and invoked the recovered AI callback
                    const { cacheId: ackCacheId } = data;
                    if (ackCacheId != null) {
                        await db.markWebviewAiCacheDelivered(ackCacheId);
                        console.log(`[Runner] AI callback ACK received for cacheId=${ackCacheId}`);
                    }
                    return; // No callback to webview needed
                }

                default: {
                    const isAiAction = [
                        'AI_GENERATE', 'AI_GENERATE_IMAGE', 'AI_GENERATE_VIDEO', 'AUDIO_SPEAK_AI', 'AI_SIMILARITY',
                    ].includes(type);

                    const isDeviceMediaAction = [
                        'CAMERA_TAKE_PHOTO', 'CAMERA_RECORD_VIDEO', 'AUDIO_RECORD_STOP',
                    ].includes(type);

                    if (isAiAction && !isEditMode) {
                        const largePayload = isLargeAiPayload(type, data);
                        if (largePayload) {
                            const confirmed = await useBridgeUIStore.getState().requestLargePayloadConfirmation();
                            if (!confirmed) {
                                if (callbackName && webViewRef.current) {
                                    webViewRef.current.injectJavaScript(
                                        `if(window[${JSON.stringify(callbackName)}]){window[${JSON.stringify(callbackName)}](false,${JSON.stringify(t('manaConfirmCancelled'))});} true;`
                                    );
                                }
                                return;
                            }
                            setAiIsLargePayload(true);
                        }
                        setIsAiLoading(true);
                    }

                    // Pre-save pending cache entry BEFORE job starts so recovery works on reload
                    if (isAiAction && !isEditMode && app?.id && callbackName) {
                        try {
                            cacheId = await db.saveWebviewAiCachePending(app.id, callbackName, type);
                        } catch (e) {
                            console.warn('[Runner] Failed to pre-save AI cache:', e);
                        }
                    }

                    // Callback fired once Firestore job doc is created — records jobId for recovery
                    const onJobCreated = cacheId != null ? async (jobId: string) => {
                        try { await db.updateWebviewAiCacheJobId(cacheId!, jobId); } catch { }
                    } : undefined;

                    let handlerResult;
                    try {
                        // Delegate to shared handlers for common message types
                        handlerResult = await handleBridgeMessage(type, data, {
                            webViewRef: webViewRef as React.RefObject<WebView>,
                            viewContainerRef: viewContainerRef,
                            appId: app?.id || null,
                            callbackName,
                            onJobCreated,
                            isEditMode,
                        });
                        if (handlerResult.handled) {
                            success = handlerResult.success;
                            result = handlerResult.result;
                            deferredCallback = !!handlerResult.deferredCallback;
                            if (handlerResult.isFirstAiUse) {
                                setShowFirstAiUseModal(true);
                            }
                        } else {
                            console.log('Unknown message type:', type);
                        }
                    } finally {
                        if (isAiAction && !isEditMode) setIsAiLoading(false);
                    }

                    if (isAiAction && !isEditMode && handlerResult && handlerResult.handled && app?.id && callbackName) {
                        try {
                            if (success) {
                                const isMedia = type !== 'AI_GENERATE' && type !== 'AI_SIMILARITY';
                                cacheResult = result;
                                if (isMedia && result && !result.startsWith('http')) {
                                    const isMarker = result.startsWith('__appblob__:');
                                    // Detect real filesystem paths (not base64 — JPEG base64 starts with /9j/)
                                    const looksLikePath = !isMarker && (result.startsWith('file://') ||
                                        (result.startsWith('/') && result.length < 1000 && /^\/[\w.]/.test(result)));
                                    if (isMarker) {
                                        // Already a blob marker — extract path directly
                                        const parts = result.split('|');
                                        if (parts.length >= 3) mediaLocalPath = parts[2];
                                        cacheResult = result;
                                    } else if (looksLikePath) {
                                        mediaLocalPath = result.startsWith('file://') ? result.slice(7) : result;
                                        cacheResult = `file://${mediaLocalPath}`;
                                    } else {
                                        try {
                                            mediaLocalPath = await saveAiMediaToFile(app.id, callbackName, type, result);
                                            cacheResult = `file://${mediaLocalPath}`;
                                            registerPendingMediaBlob(result, callbackName, AI_MEDIA_MIME[type]);
                                        } catch (fileErr) {
                                            console.warn('[Runner] Failed to save media file:', fileErr);
                                        }
                                    }
                                }
                                if (cacheId != null) {
                                    const mime = mediaLocalPath ? (AI_MEDIA_MIME[type] ?? null) : null;
                                    await db.updateWebviewAiCacheResult(cacheId, cacheResult, mediaLocalPath ?? null, mime, true);
                                }
                            } else if (cacheId != null) {
                                // Error: record the error text and mark delivered immediately — no recovery needed
                                await db.updateWebviewAiCacheResult(cacheId, result, null, null, false);
                                await db.markWebviewAiCacheDelivered(cacheId);
                            }
                        } catch (cacheErr) {
                            console.warn('[Runner] Failed to update AI cache:', cacheErr);
                        }
                    }

                    // For device media actions (AUDIO_RECORD_STOP, CAMERA_TAKE_PHOTO, etc.):
                    // extract mediaLocalPath from the marker result so createMediaCallbackScript
                    // can deliver a proper dataUri instead of the raw marker. This must work in
                    // both play and edit mode (separate concern from AI response caching above).
                    if (isDeviceMediaAction && handlerResult && handlerResult.handled && success && handlerResult.result) {
                        const res = handlerResult.result;
                        const isMarker = res.startsWith('__appblob__:');
                        if (isMarker) {
                            const parts = res.split('|');
                            if (parts.length >= 3) mediaLocalPath = parts[2]; // bare path
                        } else if (res.startsWith('file://')) {
                            mediaLocalPath = res.slice(7);
                        } else if (res.startsWith('/') && res.length < 1000 && /^\/[\w.]/.test(res)) {
                            mediaLocalPath = res;
                        }
                    }

                    break;
                }
            }

            // Send callback if needed (unless deferred, e.g. for scanner which will call back via overlay)
            if (callbackName && webViewRef.current && !deferredCallback) {
                let handledCallback = false;

                // For media types with a local file: use createMediaCallbackScript to inject into blob cache
                if (success && mediaLocalPath && type !== 'AI_GENERATE' && type !== 'AI_SIMILARITY') {
                    try {
                        const mime = AI_MEDIA_MIME[type] ?? 'application/octet-stream';

                        // Video: deliver as file:// URL — data: URIs for video are not supported on iOS WKWebView
                        // and the base64 payload is too large (100MB+) to pass through the JS bridge
                        if (type === 'AI_GENERATE_VIDEO' || type === 'CAMERA_RECORD_VIDEO') {
                            const fileUrl = `file://${mediaLocalPath}`;
                            console.log(`[Runner] Delivering video ${type} as file:// URL to ${callbackName}`);
                            const script = createCallbackScript(callbackName, success, fileUrl);
                            webViewRef.current.injectJavaScript(script);
                            handledCallback = true;
                        } else {
                            const b64 = (await FileSystem.readAsStringAsync(`file://${mediaLocalPath}`, {
                                encoding: FileSystem.EncodingType.Base64,
                            })).replace(/[\r\n]/g, '');
                            const marker = buildBlobMarker(mime, callbackName, mediaLocalPath);

                            // 1. Prepare the callback to wait for media
                            const script = createMediaCallbackScript(callbackName, success, marker);
                            webViewRef.current.injectJavaScript(script);

                            // 2. Deliver the media in chunks
                            const CHUNK_SIZE = 64 * 1024; // 64KB chunks
                            const totalChunks = Math.ceil(b64.length / CHUNK_SIZE);
                            console.log(`[Runner] Delivering ${marker} in ${totalChunks} chunks`);

                            for (let i = 0; i < totalChunks; i++) {
                                const start = i * CHUNK_SIZE;
                                const end = Math.min(start + CHUNK_SIZE, b64.length);
                                const chunk = b64.substring(start, end);
                                const chunkScript = createMediaChunkScript(marker, chunk, i, totalChunks);
                                webViewRef.current.injectJavaScript(chunkScript);
                            }

                            handledCallback = true;
                        }
                    } catch (readErr) {
                        console.warn('[Runner] Failed to build media callback, falling back:', readErr);
                    }
                }

                if (!handledCallback) {
                    const script = createCallbackScript(callbackName, success, result);
                    webViewRef.current.injectJavaScript(script);
                }

                // Mark the cache entry as delivered now that the callback was injected
                if (cacheId != null) {
                    try { await db.markWebviewAiCacheDelivered(cacheId); } catch { }
                }
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

    // Save console logs when leaving
    useEffect(() => {
        return () => {
            if (app && consoleLogs.length > 0) {
                db.updateApp({ ...app, consoleLogs: consoleLogs.join('\n') });
            }
        };
    }, [app, consoleLogs]);

    // Apply AI edit
    const handleApplyEdit = async () => {
        if (!app || !editPrompt.trim()) return;

        const { balance, openShop } = useManaStore.getState();
        if (balance <= 0) {
            openShop();
            return;
        }

        setIsEditing(true);
        try {
            // Get fresh app data from database to ensure we have the current version
            const freshApp = await db.getAppById(app.id);
            if (!freshApp) {
                console.error('App not found in database');
                return;
            }

            // Build the full prompt with context from selected element
            let fullPrompt = editPrompt;
            if (selectedElement) {
                fullPrompt = `Alterar o elemento <${selectedElement.tagName}>:\n${selectedElement.preview}\n\nInstrução: ${editPrompt}`;
            }

            logEditorAiEditSubmitted(selectedElement !== null);
            const success = await updateAppWithAI(freshApp, fullPrompt);
            if (success) {
                // Async job started. 
                // We do NOT update 'app' immediately. It will update via store listener -> DB -> live reload?
                // Wait, RunnerScreen doesn't live reload from DB unless we tell it to.
                // We should close the sheet and show "Job Started" (handled by store).

                // setApp(updatedApp); // CANNOT DO THIS
                setShowEditSheet(false);
                setEditPrompt('');
                setSelectedElement(null);

                // Navigate back to listing immediately after submitting job
                router.back();
            }
        } finally {
            setIsEditing(false);
        }
    };

    // Save manual edit
    const handleSaveManual = async () => {
        if (!app || !manualCode.trim()) return;

        await updateAppCode(app.id, manualCode, t('manualEdit'));
        const updatedApp = await db.getAppById(app.id);
        if (updatedApp) {
            setApp(updatedApp);
        }
        setShowManualEditor(false);
    };

    // Restore version
    const handleRestoreVersion = async (version: AppVersion) => {
        if (!app) return;
        logEditorVersionRestored();
        console.log('Restoring version:', version.version);

        await db.updateApp({
            ...app,
            code: version.code,
            currentVersion: version.version,
            lastUpdated: Date.now(),
        });

        // Sync store to prevent auto-revert
        await useAppStore.getState().loadApps();
        const updatedApp = await db.getAppById(app.id);
        if (updatedApp) {
            setApp(updatedApp);
        }
        setShowHistory(false);
    };

    // Delete version with confirmation
    const handleDeleteVersion = async (version: AppVersion) => {
        if (!app) return;
        // Don't allow deleting current version
        if (version.version === app.currentVersion) return;

        Alert.alert(
            t('deleteVersionTitle'),
            t('deleteVersionMessage', { version: version.version }),
            [
                { text: t('cancel'), style: 'cancel' },
                {
                    text: t('delete'),
                    style: 'destructive',
                    onPress: async () => {
                        logEditorVersionDeleted();
                        await db.deleteVersion(version.id);
                        const updatedVersions = await db.getVersionsForApp(app.id);
                        setVersions(updatedVersions);
                    }
                }
            ]
        );
    };

    // Show locked screen
    if (isLocked) {
        return (
            <SafeAreaView style={styles.lockedContainer}>
                <Text style={styles.lockIcon}>🔒</Text>
                <Text style={styles.lockedText}>{t('biometricRequired')}</Text>
                <TouchableOpacity style={styles.unlockBtn} onPress={authenticate}>
                    <Text style={styles.unlockBtnText}>{t('authenticateBiometrics')}</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.lockedCancelBtn} onPress={() => router.replace('/')}>
                    <Text style={styles.lockedCancelBtnText}>{t('cancel')}</Text>
                </TouchableOpacity>
            </SafeAreaView>
        );
    }

    if (isLoading || !app || !storageLoaded) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            </SafeAreaView>
        );
    }






    return (
        <SafeAreaView style={styles.container} edges={['top', 'bottom']}>
            {/* Configure Header Options */}
            <Stack.Screen
                options={{
                    title: app?.name || 'App',
                    headerShown: !isEditMode,
                    headerStyle: { backgroundColor: colors.surface },
                    headerTintColor: colors.onSurface,
                    headerTitleStyle: { fontSize: 16 },
                }}
            />

            {/* Header - Only in Edit Mode */}
            {isEditMode && (
                <>
                    <View style={styles.header}>
                        <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                            <Text style={styles.backText}>← {t('yourApps')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.title} numberOfLines={1}>{app.name}</Text>
                        <Text style={styles.version}>v{app.currentVersion}</Text>
                    </View>
                    <View style={{ backgroundColor: colors.surfaceVariant, paddingVertical: spacing.xs, alignItems: 'center' }}>
                        <Text style={{ color: colors.onSurfaceVariant, fontSize: 12 }}>
                            ⚠️ {t('editModeNoSave')}
                        </Text>
                    </View>
                </>
            )}

            {pendingVersionApp && (
                <TouchableOpacity
                    style={styles.updateBanner}
                    onPress={applyPendingUpdate}
                    activeOpacity={0.85}
                >
                    <Text style={styles.updateBannerText}>✨ {t('newVersionAvailable')}</Text>
                </TouchableOpacity>
            )}
            {storageClearedPending && (
                <TouchableOpacity
                    style={styles.updateBanner}
                    onPress={applyStorageReload}
                    activeOpacity={0.85}
                >
                    <Text style={styles.updateBannerText}>🗑️ {t('dataCleared')}</Text>
                </TouchableOpacity>
            )}

            {/* WebView wrapped in ScrollView for Pull-to-Refresh */}
            <View ref={viewContainerRef} style={{ flex: 1 }} collapsable={false}>
                <AiLoadingBar visible={isAiLoading} elapsedSeconds={aiElapsedSeconds} isLargePayload={aiIsLargePayload} />
                <ScrollView
                    refreshControl={
                        !isEditMode ? (
                            <RefreshControl
                                refreshing={refreshing}
                                onRefresh={onRefresh}
                                colors={[colors.primary]}
                                tintColor={colors.primary}
                                enabled={isAtTop}
                            />
                        ) : undefined
                    }
                    contentContainerStyle={{ flex: 1 }}
                    scrollEnabled={!isEditMode} // Disable outer scroll in Edit Mode to let WebView handle scrolling exclusively
                >
                    <WebView
                        key={`${app.id}_${webViewKey}`}
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
                        onLoadEnd={handleLoadEnd}
                        onMessage={handleMessage}
                        onNavigationStateChange={(navState) => {
                            if (navState.url && app?.id) {
                                // Save current URL/Hash to AsyncStorage
                                AsyncStorage.setItem(`appacadabra_last_url_${app.id}`, navState.url)
                                    .catch(e => console.warn('[Runner] Failed to save URL:', e));
                            }
                        }}
                        onRenderProcessGone={(e) => {
                            console.log('RunnerScreen: WebView render process crashed. Recreating...', e.nativeEvent);
                            setWebViewKey(k => k + 1);
                        }}
                        onContentProcessDidTerminate={() => {
                            console.log('RunnerScreen: WebView content process terminated (iOS). Recreating...');
                            setWebViewKey(k => k + 1);
                        }}
                        onError={(e) => {
                            console.error('WebView error:', e.nativeEvent);
                            setWebViewError(true);
                        }}
                        renderError={(errorDomain, errorCode, errorDesc) => (
                            <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: colors.background, padding: spacing.xl }}>
                                <Text style={{ fontSize: 48, marginBottom: spacing.md }}>⚠️</Text>
                                <Text style={{ color: colors.onSurface, fontSize: 18, fontWeight: '600', marginBottom: spacing.sm, textAlign: 'center' }}>
                                    {t('errorTitle')}
                                </Text>
                                <Text style={{ color: colors.onSurfaceVariant, fontSize: 14, textAlign: 'center', marginBottom: spacing.lg }}>
                                    {errorDesc}
                                </Text>
                                <TouchableOpacity
                                    style={{ backgroundColor: colors.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.xl, borderRadius: borderRadius.md }}
                                    onPress={() => {
                                        setWebViewError(false);
                                        onRefresh();
                                    }}
                                >
                                    <Text style={{ color: colors.onPrimary, fontSize: 16, fontWeight: '600' }}>{t('retry') || 'Retry'}</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        onShouldStartLoadWithRequest={(request) => {
                            const { url } = request;
                            // Allow data/about/blob schemes
                            if (url.startsWith('data:') || url.startsWith('about:') || url.startsWith('blob:')) {
                                return true;
                            }
                            if (url.startsWith('http://') || url.startsWith('https://')) {
                                // Block navigation to our fake baseUrl domain — it only exists for origin isolation,
                                // actual navigation to it causes ERR_NAME_NOT_RESOLVED.
                                // The initial loadDataWithBaseURL does NOT go through this handler.
                                if (url.includes('.appacadabra.local')) {
                                    console.log('Blocking navigation to fake baseUrl domain:', url);
                                    return false;
                                }
                                // Allow localhost
                                if (url.includes('localhost')) {
                                    return true;
                                }
                                // External URLs - open in system browser
                                Linking.openURL(url);
                                return false;
                            }
                            // Block any other schemes (e.g. "undefined", "null", garbage strings)
                            console.log('Blocking unknown URL scheme:', url);
                            return false;
                        }}
                        // Handle geolocation permission requests from WebView
                        // @ts-ignore - androidOnGeolocationPermissionsShowPrompt is available on Android
                        androidOnGeolocationPermissionsShowPrompt={async (origin: string, callback: (origin: string, allow: boolean, retain: boolean) => void) => {
                            console.log('WebView requesting geolocation permission for origin:', origin);
                            try {
                                const { status } = await Location.requestForegroundPermissionsAsync();
                                console.log('Geolocation permission status:', status);
                                callback(origin, status === 'granted', true);
                            } catch (e) {
                                console.error('Error requesting geolocation permission:', e);
                                callback(origin, false, false);
                            }
                        }}
                    />
                </ScrollView>
            </View>

            {/* Overlays */}
            <QRScannerOverlay webviewRef={webViewRef} />

            {/* Edit Mode Bottom Nav */}
            {isEditMode && (
                <View style={[styles.bottomNav, { paddingBottom: Math.max(insets.bottom, 10) }]}>
                    {/* Collapse toggle */}
                    <TouchableOpacity style={styles.navCollapseBtn} onPress={() => setNavCollapsed(v => !v)}>
                        <Text style={styles.navCollapseBtnText}>{navCollapsed ? '▴ Editor' : '▾'}</Text>
                    </TouchableOpacity>

                    {!navCollapsed && (
                        <>
                            {/* Simple tabs - always visible */}
                            <View style={styles.navSimple}>
                                <TouchableOpacity
                                    style={[styles.navItem, isSelectionMode && styles.navItemActive]}
                                    onPress={() => {
                                        logEditorTabOpened('select_element');
                                        const newMode = !isSelectionMode;
                                        setIsSelectionMode(newMode);
                                        if (webViewRef.current) {
                                            const script = `
                                                (function() {
                                                    if (!window.toggleSelectionMode) {
                                                        window._appacadabraSelectionMode = false;
                                                        window._selectionHandler = function(e) {
                                                            if (!window._appacadabraSelectionMode) return;
                                                            e.preventDefault(); e.stopPropagation();
                                                            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                                                            if (e.type === 'click') {
                                                                var t = e.target;
                                                                var p = t.outerHTML; if (p.length > 500) p = p.substring(0, 500) + '...';
                                                                window.ReactNativeWebView.postMessage(JSON.stringify({
                                                                    type: 'ELEMENT_SELECTED',
                                                                    data: { html: t.outerHTML, tagName: t.tagName, preview: p }
                                                                }));
                                                            }
                                                        };
                                                        var evts = ['click','mousedown','mouseup','pointerdown','pointerup'];
                                                        window.toggleSelectionMode = function(active) {
                                                            window._appacadabraSelectionMode = active;
                                                            evts.forEach(function(evt) {
                                                                if (active) document.addEventListener(evt, window._selectionHandler, true);
                                                                else document.removeEventListener(evt, window._selectionHandler, true);
                                                            });
                                                        };
                                                    }
                                                    window.toggleSelectionMode(${newMode});
                                                })();
                                                true;
                                            `;
                                            webViewRef.current.injectJavaScript(script);
                                        }
                                    }}
                                >
                                    <Text style={styles.navIcon}>👆</Text>
                                    <Text style={[styles.navLabel, isSelectionMode && styles.navLabelActive]}>
                                        {isSelectionMode ? t('cancel') : t('selectElement')}
                                    </Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.navItem}
                                    onPress={() => {
                                        logEditorTabOpened('edit_ai');
                                        setEditPrompt('');
                                        setShowEditSheet(true);
                                    }}
                                >
                                    <Text style={styles.navIcon}>✏️</Text>
                                    <Text style={styles.navLabel}>{t('edit')}</Text>
                                </TouchableOpacity>

                                <TouchableOpacity
                                    style={styles.navItem}
                                    onPress={() => {
                                        logEditorTabOpened('history');
                                        loadVersions();
                                        setShowHistory(true);
                                    }}
                                >
                                    <Text style={styles.navIcon}>📜</Text>
                                    <Text style={styles.navLabel}>{t('history')}</Text>
                                </TouchableOpacity>
                            </View>

                            {/* Advanced toggle */}
                            <View style={styles.advancedToggle}>
                                <TouchableOpacity
                                    style={[styles.advBtn, showAdvanced && styles.advBtnOpen]}
                                    onPress={() => setShowAdvanced(!showAdvanced)}
                                >
                                    <Text style={[styles.advArrow, showAdvanced && styles.advArrowOpen]}>
                                        {showAdvanced ? '▾' : '▸'}
                                    </Text>
                                    <Text style={[styles.advLabel, showAdvanced && styles.advLabelOpen]}>
                                        {showAdvanced ? t('editorCloseAdvanced') : t('editorAdvancedMode')}
                                    </Text>
                                </TouchableOpacity>
                            </View>

                            {/* Advanced tabs */}
                            {showAdvanced && (
                                <View style={styles.navAdvanced}>
                                    <TouchableOpacity
                                        style={styles.navItemAdv}
                                        onPress={() => {
                                            logEditorTabOpened('manual');
                                            setManualCode(app.code);
                                            setShowManualEditor(true);
                                        }}
                                    >
                                        <Text style={styles.advLock}>🔒</Text>
                                        <Text style={styles.navIcon}>💻</Text>
                                        <Text style={styles.navLabelAdv}>{t('code')}</Text>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={styles.navItemAdv}
                                        onPress={() => { logEditorTabOpened('debug'); setShowDebugPanel(true); }}
                                    >
                                        <Text style={styles.advLock}>🔒</Text>
                                        <Text style={styles.navIcon}>🐛</Text>
                                        <Text style={styles.navLabelAdv}>{t('debug')}</Text>
                                    </TouchableOpacity>

                                    <TouchableOpacity
                                        style={styles.navItemAdv}
                                        onPress={() => { logEditorTabOpened('tutorial'); setShowEditorOnboarding(true); }}
                                    >
                                        <Text style={styles.navIcon}>❓</Text>
                                        <Text style={styles.navLabelAdv}>{t('editorReplayTutorial')}</Text>
                                    </TouchableOpacity>
                                </View>
                            )}
                        </>
                    )}
                </View>
            )}

            {/* Editor Onboarding Overlay */}
            {isEditMode && showEditorOnboarding && (
                <View style={StyleSheet.absoluteFill}>
                    <EditorOnboarding onComplete={handleEditorOnboardingComplete} />
                </View>
            )}

            {/* Edit Sheet Modal */}
            <Modal visible={showEditSheet} transparent animationType="slide">
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.sheetOverlay}
                >
                    <View style={[styles.sheet, { paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
                        <Text style={styles.sheetTitle}>{t('editWithAI')}</Text>

                        {isEditing ? (
                            <View style={styles.editingContainer}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.editingText}>{t('applyingChanges')}</Text>
                            </View>
                        ) : (
                            <>
                                {/* Selected element preview (read-only) */}
                                {selectedElement && (
                                    <View style={styles.selectedElementBox}>
                                        <View style={styles.selectedElementHeader}>
                                            <Text style={styles.selectedElementLabel}>
                                                {t('elementSelected')} <Text style={styles.selectedElementTag}>&lt;{selectedElement.tagName}&gt;</Text>
                                            </Text>
                                            <TouchableOpacity onPress={() => setSelectedElement(null)}>
                                                <Text style={styles.clearElementBtn}>✕</Text>
                                            </TouchableOpacity>
                                        </View>
                                        <ScrollView style={styles.selectedElementPreview} nestedScrollEnabled>
                                            <Text style={styles.selectedElementCode}>{selectedElement.preview}</Text>
                                        </ScrollView>
                                    </View>
                                )}

                                {/* Instruction input */}
                                <Text style={styles.instructionLabel}>
                                    {selectedElement ? t('instructionElement') : t('instructionGeneral')}
                                </Text>
                                <View style={styles.editInputContainer}>
                                    <TextInput
                                        style={styles.editInput}
                                        value={editPrompt}
                                        onChangeText={setEditPrompt}
                                        placeholder={selectedElement
                                            ? t('editExample')
                                            : t('describeChanges')
                                        }
                                        placeholderTextColor={colors.onSurfaceVariant}
                                        multiline
                                        numberOfLines={3}
                                    />
                                    <TouchableOpacity
                                        style={[styles.editMicBtn, isListening && styles.editMicBtnActive]}
                                        onPress={toggleEditListening}
                                    >
                                        <Text style={styles.editMicIcon}>{isListening ? '🔴' : '🎤'}</Text>
                                    </TouchableOpacity>
                                </View>
                                <Text style={styles.editHint}>
                                    {isListening
                                        ? t('listeningTap')
                                        : t('describeOrMic')
                                    }
                                </Text>

                                <View style={styles.sheetButtons}>
                                    <TouchableOpacity
                                        style={styles.cancelBtn}
                                        onPress={() => {
                                            setShowEditSheet(false);
                                            setSelectedElement(null);
                                        }}
                                    >
                                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.applyBtn}
                                        onPress={handleApplyEdit}
                                    >
                                        <Text style={styles.applyText}>{t('apply')}</Text>
                                    </TouchableOpacity>
                                </View>
                            </>
                        )}
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            {/* Manual Editor Modal */}
            <Modal visible={showManualEditor} animationType="slide">
                <View style={[styles.editorContainer, { paddingTop: insets.top, paddingBottom: insets.bottom }]}>
                    <View style={styles.editorHeader}>
                        <TouchableOpacity onPress={() => setShowManualEditor(false)}>
                            <Text style={styles.cancelText}>{t('cancel')}</Text>
                        </TouchableOpacity>
                        <Text style={styles.editorTitle}>{t('codeEditorTitle')}</Text>
                        <TouchableOpacity onPress={handleSaveManual}>
                            <Text style={styles.saveText}>{t('save')}</Text>
                        </TouchableOpacity>
                    </View>

                    {/* Search Bar */}
                    <View style={styles.searchBar}>
                        <TextInput
                            style={styles.searchInput}
                            value={searchQuery}
                            onChangeText={setSearchQuery}
                            placeholder={t('searchCode')}
                            placeholderTextColor={colors.onSurfaceVariant}
                        />
                        {searchQuery !== '' && searchResultCount > 0 && (
                            <View style={styles.searchNavigation}>
                                <TouchableOpacity
                                    style={styles.searchNavBtn}
                                    onPress={() => {
                                        const newIndex = currentSearchIndex > 0 ? currentSearchIndex - 1 : searchMatches.length - 1;
                                        setCurrentSearchIndex(newIndex);
                                        setSearchSelection(searchMatches[newIndex]);
                                        scrollToSearchResult(searchMatches[newIndex]);
                                    }}
                                >
                                    <Text style={styles.searchNavText}>▲</Text>
                                </TouchableOpacity>
                                <Text style={styles.searchResultCount}>
                                    {currentSearchIndex + 1}/{searchResultCount}
                                </Text>
                                <TouchableOpacity
                                    style={styles.searchNavBtn}
                                    onPress={() => {
                                        const newIndex = currentSearchIndex < searchMatches.length - 1 ? currentSearchIndex + 1 : 0;
                                        setCurrentSearchIndex(newIndex);
                                        setSearchSelection(searchMatches[newIndex]);
                                        scrollToSearchResult(searchMatches[newIndex]);
                                    }}
                                >
                                    <Text style={styles.searchNavText}>▼</Text>
                                </TouchableOpacity>
                            </View>
                        )}
                        {searchQuery !== '' && searchResultCount === 0 && (
                            <Text style={styles.searchNoResults}>{t('noResults')}</Text>
                        )}
                    </View>

                    {/* Code Editor - Full Width */}
                    <ScrollView
                        ref={editorScrollRef}
                        style={styles.editorBody}
                        contentContainerStyle={{ flexGrow: 1 }}
                        keyboardShouldPersistTaps="handled"
                    >
                        <ScrollView horizontal contentContainerStyle={{ flexGrow: 1 }}>
                            <View style={styles.codeEditorContainer}>
                                {/* Highlight underlay */}
                                <Text style={[styles.codeEditor, styles.codeHighlightUnderlay]} pointerEvents="none">
                                    {renderHighlightedCode()}
                                </Text>
                                {/* Actual editable TextInput */}
                                <TextInput
                                    ref={codeInputRef}
                                    style={[styles.codeEditor, styles.codeEditorInput]}
                                    scrollEnabled={false}
                                    value={manualCode}
                                    onChangeText={setManualCode}
                                    onSelectionChange={() => { }}
                                    selectionColor={colors.tertiary}
                                    multiline
                                    autoCapitalize="none"
                                    autoCorrect={false}
                                    spellCheck={false}
                                    textAlignVertical="top"
                                />
                            </View>
                        </ScrollView>
                    </ScrollView>
                </View>
            </Modal>



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
                                router.push(`/spell/${id}`);
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

            {/* Version History Modal */}
            <Modal visible={showHistory} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '70%', paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
                        <Text style={styles.sheetTitle}>{t('versionHistory')}</Text>

                        <ScrollView style={styles.versionList}>
                            {versions.map((version) => (
                                <View key={version.id} style={[
                                    styles.versionItem,
                                    version.version === app.currentVersion && styles.versionItemActive
                                ]}>
                                    <TouchableOpacity
                                        style={{ flex: 1 }}
                                        onPress={() => handleRestoreVersion(version)}
                                        disabled={version.version === app.currentVersion}
                                    >
                                        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
                                            <Text style={styles.versionNumber}>v{version.version}</Text>
                                            <Text style={styles.versionDate}>
                                                {new Date(version.createdAt).toLocaleDateString('pt-BR')}
                                            </Text>
                                        </View>
                                        {version.instruction && (
                                            <Text style={styles.versionInstruction} numberOfLines={1}>
                                                {version.instruction}
                                            </Text>
                                        )}
                                    </TouchableOpacity>
                                    {version.version !== app.currentVersion && (
                                        <TouchableOpacity
                                            style={{ padding: 8 }}
                                            onPress={() => handleDeleteVersion(version)}
                                        >
                                            <Text style={{ color: colors.error, fontSize: 16 }}>🗑️</Text>
                                        </TouchableOpacity>
                                    )}
                                </View>
                            ))}
                        </ScrollView>

                        <TouchableOpacity
                            style={styles.closeBtn}
                            onPress={() => setShowHistory(false)}
                        >
                            <Text style={styles.closeText}>{t('close')}</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Debug Panel Modal */}
            <Modal visible={showDebugPanel} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '80%', paddingBottom: Math.max(insets.bottom, spacing.lg) }]}>
                        <Text style={styles.sheetTitle}>🐛 {t('debug')}</Text>

                        <Text style={styles.debugSectionTitle}>{t('consoleLogs')} ({consoleLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {consoleLogs.length === 0 ? (
                                <Text style={styles.debugEmpty}>{t('noLogs')}</Text>
                            ) : (
                                consoleLogs.map((log, idx) => (
                                    <Text
                                        key={idx}
                                        style={[
                                            styles.debugLogItem,
                                            log.startsWith('[error]') && styles.debugLogError,
                                            log.startsWith('[warn]') && styles.debugLogWarn,
                                        ]}
                                    >
                                        {log}
                                    </Text>
                                ))
                            )}
                        </ScrollView>

                        <Text style={styles.debugSectionTitle}>{t('network')} ({networkLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {networkLogs.length === 0 ? (
                                <Text style={styles.debugEmpty}>{t('noRequests')}</Text>
                            ) : (
                                networkLogs.map((req, idx) => (
                                    <View key={idx} style={styles.networkLogItem}>
                                        <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: 4 }}>
                                            <Text style={styles.networkMethod}>{req.method}</Text>
                                            <Text style={styles.networkUrl} numberOfLines={1}>{req.url}</Text>
                                            {req.status !== undefined && req.status !== null && (
                                                <Text style={[
                                                    styles.networkStatus,
                                                    req.status >= 400 && styles.networkStatusError
                                                ]}>
                                                    {req.status}
                                                </Text>
                                            )}
                                            {req.duration && (
                                                <Text style={{ color: colors.onSurfaceVariant, fontSize: 10, marginStart: 4 }}>
                                                    {req.duration}ms
                                                </Text>
                                            )}
                                        </View>
                                        {req.responseBody && (
                                            <Text style={{ color: colors.onSurfaceVariant, fontSize: 10, marginTop: 2 }} numberOfLines={3}>
                                                {req.responseBody}
                                            </Text>
                                        )}
                                    </View>
                                ))
                            )}
                        </ScrollView>

                        <View style={styles.debugButtons}>
                            <TouchableOpacity
                                style={styles.debugClearBtn}
                                onPress={() => {
                                    setConsoleLogs([]);
                                    setNetworkLogs([]);
                                }}
                            >
                                <Text style={styles.debugClearText}>{t('clear')}</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.closeBtn}
                                onPress={() => setShowDebugPanel(false)}
                            >
                                <Text style={styles.closeText}>{t('close')}</Text>
                            </TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>
        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: {
        flex: 1,
        backgroundColor: colors.background,
    },
    updateBanner: {
        backgroundColor: colors.primary,
        paddingVertical: 8,
        paddingHorizontal: 16,
        alignItems: 'center',
    },
    updateBannerText: {
        color: '#fff',
        fontSize: 13,
        fontWeight: '600',
    },
    loadingContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
    },
    header: {
        flexDirection: 'row',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    backBtn: {
        marginEnd: spacing.md,
    },
    backText: {
        color: colors.onPrimary,
        fontSize: 16,
    },
    title: {
        flex: 1,
        color: colors.onSurface,
        fontSize: 18,
        fontWeight: '600',
    },
    version: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },
    webview: {
        flex: 1,
        backgroundColor: '#FFFFFF',
    },
    // ─── Bottom Nav ───
    bottomNav: {
        backgroundColor: colors.background,
        borderTopWidth: 1,
        borderTopColor: colors.surfaceVariant,
        paddingTop: 4,
    },
    navCollapseBtn: {
        alignItems: 'center',
        paddingVertical: 4,
    },
    navCollapseBtnText: {
        color: colors.onSurfaceVariant,
        fontSize: 13,
        fontWeight: '700',
        letterSpacing: 0.5,
    },
    navSimple: {
        flexDirection: 'row',
        justifyContent: 'space-around',
    },
    navItem: {
        alignItems: 'center',
        gap: 4,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: borderRadius.md,
    },
    navItemActive: {
        backgroundColor: colors.primary + '22',
    },
    navIcon: {
        fontSize: 24,
    },
    navLabel: {
        fontSize: 11,
        fontWeight: '700',
        color: colors.onSurfaceVariant,
    },
    navLabelActive: {
        color: colors.primary,
    },
    advancedToggle: {
        alignItems: 'center',
        paddingTop: 8,
        paddingBottom: 4,
    },
    advBtn: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        borderWidth: 1,
        borderColor: colors.surfaceVariant,
        paddingVertical: 6,
        paddingHorizontal: 16,
        borderRadius: 99,
    },
    advBtnOpen: {
        borderColor: '#D97706',
    },
    advArrow: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        fontWeight: '700',
    },
    advArrowOpen: {
        color: '#D97706',
    },
    advLabel: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        fontWeight: '700',
    },
    advLabelOpen: {
        color: '#D97706',
    },
    navAdvanced: {
        flexDirection: 'row',
        justifyContent: 'space-around',
        paddingTop: 8,
    },
    navItemAdv: {
        alignItems: 'center',
        gap: 4,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        borderRadius: borderRadius.md,
        position: 'relative' as const,
    },
    navLabelAdv: {
        fontSize: 11,
        fontWeight: '700',
        color: colors.onSurfaceVariant,
        opacity: 0.7,
    },
    advLock: {
        position: 'absolute' as const,
        top: 4,
        right: 8,
        fontSize: 10,
    },
    sheetOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'flex-end',
    },
    sheet: {
        backgroundColor: colors.surface,
        borderTopLeftRadius: borderRadius.xl,
        borderTopRightRadius: borderRadius.xl,
        padding: spacing.lg,
    },
    sheetTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    editInputContainer: {
        position: 'relative',
    },
    editInput: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        paddingEnd: 56, // Space for mic button
        color: colors.onSurface,
        fontSize: 16,
        minHeight: 100,
        textAlignVertical: 'top',
    },
    editMicBtn: {
        position: 'absolute',
        right: spacing.sm,
        bottom: spacing.sm,
        width: 40,
        height: 40,
        borderRadius: 20,
        backgroundColor: colors.primaryContainer,
        justifyContent: 'center',
        alignItems: 'center',
    },
    editMicBtnActive: {
        backgroundColor: colors.error,
    },
    editMicIcon: {
        fontSize: 20,
    },
    editHint: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: spacing.sm,
    },
    sheetButtons: {
        flexDirection: 'row',
        justifyContent: 'flex-end',
        alignItems: 'center',
        gap: spacing.md,
        marginTop: spacing.lg,
    },
    cancelBtn: {
        padding: spacing.md,
    },
    cancelText: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
    },
    applyBtn: {
        backgroundColor: colors.primary,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.lg,
        borderRadius: borderRadius.md,
    },
    applyText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: '600',
    },
    editingContainer: {
        alignItems: 'center',
        paddingVertical: spacing.xl,
    },
    editingText: {
        color: colors.onSurface,
        marginTop: spacing.md,
    },
    editorContainer: {
        flex: 1,
        backgroundColor: colors.background,
    },
    editorHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: spacing.md,
        backgroundColor: colors.surface,
        borderBottomWidth: 1,
        borderBottomColor: colors.surfaceVariant,
    },
    editorTitle: {
        color: colors.onSurface,
        fontSize: 18,
        fontWeight: '600',
    },
    saveText: {
        color: colors.primary,
        fontSize: 16,
        fontWeight: '600',
    },
    versionList: {
        maxHeight: 300,
    },
    versionItem: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        marginBottom: spacing.sm,
    },
    versionItemActive: {
        backgroundColor: colors.primaryContainer,
        borderWidth: 1,
        borderColor: colors.primary,
    },
    versionNumber: {
        color: colors.onSurface,
        fontWeight: '600',
    },
    versionDate: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
    versionInstruction: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
        marginTop: 4,
    },
    closeBtn: {
        alignItems: 'center',
        padding: spacing.md,
        marginTop: spacing.md,
    },
    closeText: {
        color: colors.primary,
        fontSize: 16,
    },
    // Debug panel styles
    debugSectionTitle: {
        color: colors.onSurface,
        fontSize: 16,
        fontWeight: '600',
        marginTop: spacing.md,
        marginBottom: spacing.sm,
    },
    debugLogsContainer: {
        maxHeight: 150,
        backgroundColor: colors.background,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
    },
    debugEmpty: {
        color: colors.onSurfaceVariant,
        fontStyle: 'italic',
        textAlign: 'center',
        padding: spacing.md,
    },
    debugLogItem: {
        color: colors.onSurface,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 12,
        marginBottom: 4,
    },
    debugLogError: {
        color: colors.error,
    },
    debugLogWarn: {
        color: '#FFA500',
    },
    networkLogItem: {
        flexDirection: 'column',
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.sm,
        padding: spacing.sm,
        marginBottom: 4,
    },
    networkMethod: {
        color: colors.primary,
        fontWeight: '600',
        fontSize: 12,
        width: 50,
    },
    networkUrl: {
        flex: 1,
        color: colors.onSurface,
        fontSize: 12,
    },
    networkStatus: {
        color: colors.onSurface,
        fontWeight: '600',
        fontSize: 12,
    },
    networkStatusError: {
        color: colors.error,
    },
    debugButtons: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        marginTop: spacing.md,
    },
    debugClearBtn: {
        padding: spacing.md,
    },
    debugClearText: {
        color: colors.error,
        fontSize: 16,
    },
    // Selected element styles
    selectedElementBox: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.sm,
        marginBottom: spacing.md,
        maxHeight: 120,
    },
    selectedElementHeader: {
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: spacing.xs,
    },
    selectedElementLabel: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
    selectedElementTag: {
        color: colors.primary,
        fontWeight: '600',
    },
    clearElementBtn: {
        color: colors.onSurfaceVariant,
        fontSize: 16,
        padding: spacing.xs,
    },
    selectedElementPreview: {
        maxHeight: 70,
    },
    selectedElementCode: {
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 11,
        color: colors.onSurface,
    },
    instructionLabel: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
        marginBottom: spacing.xs,
    },
    // Editor search and line numbers styles
    searchBar: {
        flexDirection: 'row',
        alignItems: 'center',
        backgroundColor: colors.surfaceVariant,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.sm,
        gap: spacing.sm,
    },
    searchInput: {
        flex: 1,
        color: colors.onSurface,
        fontSize: 14,
        padding: 0,
    },
    searchResultCount: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
    editorBody: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
    },
    codeEditor: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        color: colors.onSurface,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 13,
        lineHeight: 18,
        padding: spacing.md,
        textAlignVertical: 'top',
        minHeight: 500,
    },
    // Search navigation styles
    searchNavigation: {
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.xs,
    },
    searchNavBtn: {
        padding: spacing.xs,
    },
    searchNavText: {
        color: colors.primary,
        fontSize: 14,
        fontWeight: '600',
    },
    searchNoResults: {
        color: colors.onSurfaceVariant,
        fontSize: 12,
    },
    // Code editor with highlight
    codeEditorContainer: {
        position: 'relative',
        flexGrow: 1,
        minWidth: '100%',
    },
    codeHighlightUnderlay: {
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
    },
    codeEditorInput: {
        backgroundColor: 'transparent',
        color: colors.onSurface,
    },
    codeHighlightText: {
        color: colors.onSurface,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 13,
        lineHeight: 18,
    },
    searchHighlight: {
        backgroundColor: colors.tertiary + '40',
        borderRadius: 2,
    },
    searchHighlightCurrent: {
        backgroundColor: colors.tertiary + '90',
    },
    // Locked screen styles
    lockedContainer: {
        flex: 1,
        justifyContent: 'center',
        alignItems: 'center',
        backgroundColor: colors.background,
        padding: spacing.xl,
    },
    lockIcon: {
        fontSize: 64,
        marginBottom: spacing.lg,
    },
    lockedText: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onSurface,
        marginBottom: spacing.md,
    },
    unlockBtn: {
        backgroundColor: colors.primary,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.md,
        marginBottom: spacing.md,
    },
    unlockBtnText: {
        color: colors.onPrimary,
        fontSize: 16,
        fontWeight: '600',
    },
    lockedCancelBtn: {
        backgroundColor: colors.surfaceVariant,
        paddingHorizontal: spacing.xl,
        paddingVertical: spacing.md,
        borderRadius: borderRadius.md,
    },
    lockedCancelBtnText: {
        color: colors.onSurface,
        fontSize: 16,
    },
    successModal: {
        width: '85%',
        backgroundColor: colors.surface,
        borderRadius: borderRadius.xl,
        padding: spacing.xl,
        alignItems: 'center',
        borderWidth: 1,
        borderColor: 'rgba(255,255,255,0.1)',
    },
    modalOverlay: {
        flex: 1,
        backgroundColor: 'rgba(0,0,0,0.7)',
        justifyContent: 'center',
        alignItems: 'center',
    },
    successEmoji: {
        fontSize: 48,
        marginBottom: spacing.md,
    },
    successTitle: {
        fontSize: 20,
        fontWeight: 'bold',
        color: colors.onBackground,
        textAlign: 'center',
        marginBottom: spacing.sm,
    },
    successMessage: {
        fontSize: 16,
        color: colors.onSurfaceVariant,
        textAlign: 'center',
        marginBottom: spacing.xl,
        lineHeight: 22,
    },
    successLinkBtn: {
        backgroundColor: colors.primary,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.xl,
        borderRadius: borderRadius.full,
        width: '100%',
        alignItems: 'center',
        marginBottom: spacing.md,
    },
    successLinkText: {
        color: '#FFFFFF',
        fontWeight: 'bold',
        fontSize: 16,
    },
    successCloseBtn: {
        paddingVertical: spacing.sm,
    },
    successCloseText: {
        color: colors.onSurfaceVariant,
        fontSize: 14,
    },
});
