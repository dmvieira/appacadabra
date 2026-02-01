import React, { useEffect, useState, useRef, useCallback } from 'react';
import { t } from '../lib/i18n';
import {
    View,
    Text,
    TouchableOpacity,
    StyleSheet,
    ActivityIndicator,
    TextInput,
    ScrollView,
    Modal,
    Platform,
    KeyboardAvoidingView,
    BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';

import { useAppStore } from '../lib/store';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript } from '../lib/bridges/injectedJS';
import { handleBridgeMessage } from '../lib/bridges/messageHandlers';
import * as db from '../lib/database/db';
import { colors, spacing, borderRadius } from '../lib/theme';
import { GeneratedApp, AppVersion } from '../lib/database/types';
import * as ShareIntent from 'share-intent';
import { getWebViewTranslations } from '../lib/i18n';

interface AppRunnerProps {
    appId: number;
    isVisible: boolean;
    mode?: 'run' | 'edit';
}

export default function AppRunner({ appId, isVisible, mode = 'edit' }: AppRunnerProps) {
    const webViewRef = useRef<WebView>(null);
    const { minimizeApp, updateAppCode, updateAppWithAI, closeApp } = useAppStore();

    // ... (rest of imports and hooks)

    // (Note: I need to ensure I don't delete the component body. Since I cannot replace non-contiguous blocks easily without risking context loss or very large edits, I will edit the Interface/Props and the Toolbar render separately if possible. Or replace the whole start/end.)

    // Strategy: Replace the top part first to add 'mode'.
    // Then replace the bottom part to wrap toolbar.

    // Wait, let's use multi_replace.



    // Navigation state for BackHandler
    const canGoBackRef = useRef(false);

    // Handle Android Back Button
    useEffect(() => {
        if (!isVisible) return;

        const onBackPress = () => {
            if (mode === 'run' && webViewRef.current && canGoBackRef.current) {
                webViewRef.current.goBack();
                return true;
            }
            // If in edit mode, or cannot go back, or in run mode at root: minimize
            // You might want slightly different behavior in edit mode (e.g. prompt?), but minimize is safe
            minimizeApp();
            return true;
        };

        const subscription = BackHandler.addEventListener('hardwareBackPress', onBackPress);
        return () => subscription.remove();
    }, [isVisible, mode, minimizeApp]);

    const [app, setApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [consoleLogs, setConsoleLogs] = useState<string[]>([]);

    // Edit mode states
    const [showEditSheet, setShowEditSheet] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');
    const [isEditing, setIsEditing] = useState(false);
    const [selectionContext, setSelectionContext] = useState('');
    const [isSelectingElement, setIsSelectingElement] = useState(false);
    const editSheetTimeout = useRef<NodeJS.Timeout | null>(null);

    // Manual editor
    const [showManualEditor, setShowManualEditor] = useState(false);
    const [manualCode, setManualCode] = useState('');

    // Version history
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState<AppVersion[]>([]);

    // Saved localStorage items
    const [savedStorage, setSavedStorage] = useState<{ key: string; value: string }[]>([]);
    const [storageLoaded, setStorageLoaded] = useState(false);

    // Debug panel states
    const [showDebugPanel, setShowDebugPanel] = useState(false);
    const [networkLogs, setNetworkLogs] = useState<{ url: string; method: string; status?: number; time: number }[]>([]);
    const [webViewKey, setWebViewKey] = useState(0); // Key to force WebView recreation

    // Load app data
    useEffect(() => {
        async function loadApp() {
            const appData = await db.getAppById(appId);
            if (appData) {
                setApp(appData);
                // Load stored localStorage data
                const storage = await db.getStorageForApp(appData.id);
                setSavedStorage(storage.map(s => ({ key: s.key, value: s.value })));
                setStorageLoaded(true);
            } else {
                setStorageLoaded(true); // Mark as loaded even if no app found
            }
            setIsLoading(false);
        }
        loadApp();
    }, [appId]);

    // Force reload WebView when app code changes (e.g. from version restore)
    useEffect(() => {
        if (app?.code) {
            setWebViewKey(prev => prev + 1);
        }
    }, [app?.code]);

    // Inject saved localStorage when WebView loads
    const handleLoadEnd = useCallback(() => {
        if (webViewRef.current && savedStorage.length > 0) {
            const script = createStorageRestoreScript(savedStorage);
            webViewRef.current.injectJavaScript(script);
        }
    }, [savedStorage]);

    // Load version history
    const loadVersions = useCallback(async () => {
        if (!app) return;
        const vers = await db.getVersionsForApp(app.id);
        setVersions(vers);
    }, [app]);

    // Handle Edit Press with Selection Context (DOM Mode)
    const handleEditPress = () => {
        if (!webViewRef.current) return;

        if (isSelectingElement) {
            // Cancel mode
            webViewRef.current.injectJavaScript('if(window.toggleSelectionMode) window.toggleSelectionMode(false); true;');
            setIsSelectingElement(false);
        } else {
            // Enable mode - Force inject script if missing (Lazy Loading to fix cache issues)
            console.log('Activating Selection Mode (Lazy Inject)');
            const script = `
                (function() {
                    if (!window.toggleSelectionMode) {
                        window._appacadabraSelectionMode = false;
                        
                        window._selectionHandler = function(e) {
                            if (!window._appacadabraSelectionMode) return;
                            
                            // Always stop propagation to prevent interaction
                            e.preventDefault();
                            e.stopPropagation();
                            if (e.stopImmediatePropagation) e.stopImmediatePropagation();
                            
                            // Only perform selection on click
                            if (e.type === 'click') {
                                var target = e.target;
                                
                                // Visual feedback
                                if (window._lastHighlighted) window._lastHighlighted.style.outline = '';
                                target.style.outline = '4px solid #FF0055'; 
                                window._lastHighlighted = target;
                                
                                // Get preview
                                var preview = target.outerHTML;
                                if (preview.length > 500) preview = preview.substring(0, 500) + '...';

                                // Send to native
                                window.ReactNativeWebView.postMessage(JSON.stringify({
                                   type: 'ELEMENT_SELECTED',
                                   data: { html: target.outerHTML, tagName: target.tagName, preview: preview }
                                }));
                            }
                        };
                        
                        var _eventsToBlock = ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'submit'];
                        
                        window.toggleSelectionMode = function(active) {
                            window._appacadabraSelectionMode = active;
                            if (active) {
                                // Add listeners for all blocking events
                                _eventsToBlock.forEach(function(evt) {
                                    document.addEventListener(evt, window._selectionHandler, true); // Capture phase
                                });
                                
                                // Visual styles
                                document.body.style.cursor = 'crosshair';
                                
                                // Try to stop existing interactions
                                if (document.activeElement) document.activeElement.blur();
                                window.getSelection().removeAllRanges();
                            } else {
                                // Remove listeners
                                _eventsToBlock.forEach(function(evt) {
                                    document.removeEventListener(evt, window._selectionHandler, true);
                                });
                                
                                document.body.style.cursor = '';
                                if (window._lastHighlighted) {
                                   window._lastHighlighted.style.outline = '';
                                   window._lastHighlighted = null;
                                }
                            }
                        };
                    }
                    // Activate now
                    window.toggleSelectionMode(true);
                })();
                true;
            `;
            webViewRef.current.injectJavaScript(script);
            setIsSelectingElement(true);
        }
    };

    // Message chunking buffer
    const messageBuffers = useRef<Record<string, string[]>>({});

    // Handle messages from WebView
    const handleMessage = useCallback(async (event: WebViewMessageEvent) => {
        let callbackName: string | undefined;
        try {
            const messageStr = event.nativeEvent.data;
            const message = JSON.parse(messageStr);
            const { type, data, appId: msgAppId } = message;
            callbackName = message.callbackName;

            // Handle Chunked Messages
            if (type === 'BRIDGE_CHUNK') {
                const { id, index, total, chunk } = data;
                if (!messageBuffers.current[id]) {
                    messageBuffers.current[id] = new Array(total).fill('');
                }
                messageBuffers.current[id][index] = chunk;

                // Check completion
                let isComplete = true;
                for (let i = 0; i < total; i++) {
                    if (!messageBuffers.current[id][i]) {
                        isComplete = false;
                        break;
                    }
                }

                if (isComplete) {
                    const fullMessageStr = messageBuffers.current[id].join('');
                    console.log(`[AppRunner] Reassembled message ${id}, length: ${fullMessageStr.length}`);
                    delete messageBuffers.current[id];

                    // Recursive call with the full message
                    const fullEvent = {
                        ...event,
                        nativeEvent: {
                            ...event.nativeEvent,
                            data: fullMessageStr
                        }
                    };
                    handleMessage(fullEvent);
                }
                return;
            }

            // Log non-frequent messages
            if (type !== 'CONSOLE_LOG' && type !== 'NETWORK_LOG') {
                console.log(`[App ${appId}] WebView Message received: `, type);
            }

            let success = true;
            let result = '';

            // Delegate to centralized message handler
            const bridgeResult = await handleBridgeMessage(type, data, {
                webViewRef: webViewRef as React.RefObject<WebView>,
                appId: appId || null // Use prop appId which is reliable
            });

            if (bridgeResult.handled) {
                success = bridgeResult.success;
                result = bridgeResult.result;
            } else {
                // Handle local messages not in shared bridge
                switch (type) {
                    case 'CONSOLE_LOG':
                        setConsoleLogs(prev => [...prev.slice(-99), `[${data.type}] ${data.message}`]);
                        return; // No callback needed usually, or verified later
                    case 'NETWORK_LOG':
                        setNetworkLogs(prev => [...prev.slice(-49), {
                            url: data.url,
                            method: data.method,
                            status: data.status,
                            time: Date.now(),
                        }]);
                        return;
                    case 'ELEMENT_SELECTED':
                        console.log('Element selected:', data.tagName);
                        // Disable mode
                        if (webViewRef.current) webViewRef.current.injectJavaScript('if(window.toggleSelectionMode) window.toggleSelectionMode(false); true;');
                        setIsSelectingElement(false);
                        setSelectionContext(data.html || '');
                        setShowEditSheet(true);
                        return;
                    default:
                        console.log('Unknown message type:', type);
                        success = false;
                        result = `Unknown message type: ${type}`;
                }
            }


            if (callbackName && webViewRef.current) {
                const script = createCallbackScript(callbackName, success, result);
                webViewRef.current.injectJavaScript(script);
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
    }, [app, appId]);

    // Save logs on unmount/cleanup
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
        setIsEditing(true);
        try {
            const success = await updateAppWithAI(app, editPrompt, selectionContext);
            if (success) {
                // Reload app from database to get updated version
                const updatedApp = await db.getAppById(app.id);
                if (updatedApp) setApp(updatedApp);
                setShowEditSheet(false);
                setEditPrompt('');
            }
        } finally {
            setIsEditing(false);
        }
    };

    // Save manual edit
    const handleSaveManual = async () => {
        if (!app || !manualCode.trim()) return;
        await updateAppCode(app.id, manualCode, 'Edição manual');
        const updatedApp = await db.getAppById(app.id);
        if (updatedApp) setApp(updatedApp);
        setShowManualEditor(false);
    };

    // Inject shared content if available
    useEffect(() => {
        if (!webViewRef.current) return;

        const handleShare = (content: ShareIntent.SharedContent) => {
            console.log('[AppRunner] Injecting shared content', content);
            webViewRef.current?.injectJavaScript(`
                window.postMessage(JSON.stringify({
                    type: 'SHARED_CONTENT_RECEIVED',
                    data: ${JSON.stringify(content)}
                }), '*');
                // Also dispatch a custom event for easier listening
                var event = new CustomEvent('appacadabra_share', { detail: ${JSON.stringify(content)} });
                window.dispatchEvent(event);
            `);
        };

        // Check for pending content mostly relevant when the runner is mounted *because* of a share action
        // But ShareReceiver handles the UI part. Here we just listen if we are active.
        // Actually, if we just opened this runner from ShareReceiver, the content is still "pending" if we didn't clear it.
        // But ShareReceiver might have cleared it or passed it? 
        // Let's assume ShareReceiver *closed* the modal but didn't clear the content? 
        // Or ShareReceiver should pass it as a param? 
        // For simplicity, let's listen for the event.

        const sub = ShareIntent.addShareListener(handleShare);

        // Also check immediately if there is pending content that matches our "intent"?
        // Since ShareReceiver is a global modal, when it routes to us, the file is ready.
        const pending = ShareIntent.getSharedContent();
        if (pending) {
            // Give WebView a moment to load? or rely on the fact that injectedJS runs early?
            // We'll try to inject it now, but if the page isn't loaded it might be lost.
            // Better: Retain it until the page asks for it? or inject on load.
            setTimeout(() => handleShare(pending), 1000);
        }

        return () => sub.remove();
    }, [appId]);

    // Restore version
    const handleRestoreVersion = async (version: AppVersion) => {
        if (!app) return;
        await db.updateApp({
            ...app,
            code: version.code,
            currentVersion: version.version,
            lastUpdated: Date.now(),
        });
        const updatedApp = await db.getAppById(app.id);
        if (updatedApp) setApp(updatedApp);
        setShowHistory(false);
    };

    if (!app || !storageLoaded) {
        // If app failed to load, still loading, or storage not ready
        if (isLoading || !storageLoaded) {
            return (
                <View style={[styles.container, styles.loadingContainer]}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            );
        }
        return null;
    }

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
      <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
      <style>* { box-sizing: border-box; } body { margin: 0; padding: 0; }</style>
    </head>
    <body>${app.code}</body>
    </html>
    `;

    const storageScript = createStorageRestoreScript(savedStorage);
    const combinedScript = `${getInjectedJavaScript(app.id, getWebViewTranslations(), mode === 'edit')} ${storageScript}`;

    return (
        <SafeAreaView
            style={[styles.container, !isVisible && styles.hidden]}
            edges={['top']}
            pointerEvents={isVisible ? 'auto' : 'none'}
        >
            {/* Header - Only in Edit Mode */}
            {mode === 'edit' && (
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => minimizeApp()} style={styles.backBtn}>
                        <Text style={styles.backText}>← {t('yourApps')}</Text>
                    </TouchableOpacity>
                    <Text style={styles.title} numberOfLines={1}>{app.name}</Text>
                    <Text style={styles.version}>v{app.currentVersion}</Text>
                </View>
            )}

            {/* Edit Mode Warning Banner */}
            {mode === 'edit' && (
                <View style={[styles.header, { backgroundColor: colors.surfaceVariant, paddingVertical: spacing.xs, minHeight: 0 }]}>
                    <Text style={{ color: colors.onSurfaceVariant, fontSize: 12, textAlign: 'center', width: '100%' }}>
                        ⚠️ {t('editModeNoSave')}
                    </Text>
                </View>
            )}

            {/* WebView */}
            <WebView
                key={webViewKey} // Force recreation on code change
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
                onNavigationStateChange={(navState) => {
                    canGoBackRef.current = navState.canGoBack;
                }}
                onError={(e) => console.error('WebView error:', e.nativeEvent)}
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
                androidOnGeolocationPermissionsShowPrompt={async (origin, callback) => {
                    console.log('WebView requesting geolocation permission');
                    try {
                        const { status } = await Location.requestForegroundPermissionsAsync();
                        callback(origin, status === 'granted', true);
                    } catch (e) {
                        callback(origin, false, false);
                    }
                }}
            />

            {/* Toolbar */}
            {
                mode === 'edit' && (
                    <View style={styles.toolbar}>
                        <TouchableOpacity
                            style={[styles.toolbarBtn, isSelectingElement && { backgroundColor: colors.primaryContainer }]}
                            onPress={handleEditPress}
                        >
                            <Text style={styles.toolbarIcon}>{isSelectingElement ? '❌' : '✏️'}</Text>
                            <Text style={styles.toolbarText}>{isSelectingElement ? t('cancel') : t('edit')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toolbarBtn} onPress={() => { setManualCode(app.code); setShowManualEditor(true); }}>
                            <Text style={styles.toolbarIcon}>💻</Text>
                            <Text style={styles.toolbarText}>{t('code')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toolbarBtn} onPress={() => { loadVersions(); setShowHistory(true); }}>
                            <Text style={styles.toolbarIcon}>📜</Text>
                            <Text style={styles.toolbarText}>{t('history')}</Text>
                        </TouchableOpacity>
                        <TouchableOpacity style={styles.toolbarBtn} onPress={() => setShowDebugPanel(true)}>
                            <Text style={styles.toolbarIcon}>🐛</Text>
                            <Text style={styles.toolbarText}>{t('debug')}</Text>
                        </TouchableOpacity>
                    </View>
                )
            }

            {/* Edit Sheet */}
            <Modal visible={showEditSheet} transparent animationType="slide">
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheetOverlay}>
                    <View style={styles.sheet}>
                        <Text style={styles.sheetTitle}>{t('editWithAI')}</Text>
                        {isEditing ? (
                            <View style={styles.editingContainer}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.editingText}>{t('applyingChanges')}</Text>
                            </View>
                        ) : (
                            <>
                                {selectionContext ? (
                                    <View style={styles.contextContainer}>
                                        <Text style={styles.contextLabel}>{t('focusSelection')}</Text>
                                        <Text style={styles.contextValue} numberOfLines={2}>"{selectionContext}"</Text>
                                        <TouchableOpacity onPress={() => setSelectionContext('')} style={styles.contextClearBtn}>
                                            <Text style={styles.contextClearText}>{t('removeSelection')}</Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : null}
                                <TextInput
                                    style={styles.editInput}
                                    value={editPrompt}
                                    onChangeText={setEditPrompt}
                                    placeholder={t('describeChanges')}
                                    placeholderTextColor={colors.onSurfaceVariant}
                                    multiline
                                    numberOfLines={4}
                                />
                                <View style={styles.sheetButtons}>
                                    <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowEditSheet(false)}>
                                        <Text style={styles.cancelText}>{t('cancel')}</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.applyBtn} onPress={handleApplyEdit}>
                                        <Text style={styles.applyText}>{t('apply')}</Text>
                                    </TouchableOpacity>
                                </View>
                            </>
                        )}
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            <Modal visible={showManualEditor} animationType="slide">
                <SafeAreaView style={styles.editorContainer}>
                    <View style={styles.editorHeader}>
                        <TouchableOpacity onPress={() => setShowManualEditor(false)}><Text style={styles.cancelText}>{t('cancel')}</Text></TouchableOpacity>
                        <Text style={styles.editorTitle}>{t('codeEditorTitle')}</Text>
                        <TouchableOpacity onPress={handleSaveManual}><Text style={styles.saveText}>{t('save')}</Text></TouchableOpacity>
                    </View>
                    <TextInput style={styles.codeEditor} value={manualCode} onChangeText={setManualCode} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} />
                </SafeAreaView>
            </Modal>

            <Modal visible={showHistory} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '70%' }]}>
                        <Text style={styles.sheetTitle}>{t('versionHistoryTitle')}</Text>
                        <ScrollView style={styles.versionList}>
                            {versions.map((version) => (
                                <TouchableOpacity key={version.id} style={[styles.versionItem, version.version === app.currentVersion && styles.versionItemActive]} onPress={() => handleRestoreVersion(version)} disabled={version.version === app.currentVersion}>
                                    <Text style={styles.versionNumber}>v{version.version}</Text>
                                    <Text style={styles.versionDate}>{new Date(version.createdAt).toLocaleDateString()}</Text>
                                    {version.instruction && <Text style={styles.versionInstruction} numberOfLines={1}>{version.instruction}</Text>}
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                        <TouchableOpacity style={styles.closeBtn} onPress={() => setShowHistory(false)}><Text style={styles.closeText}>{t('close')}</Text></TouchableOpacity>
                    </View>
                </View>
            </Modal>

            <Modal visible={showDebugPanel} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '80%' }]}>
                        <Text style={styles.sheetTitle}>🐛 Debug</Text>
                        <Text style={styles.debugSectionTitle}>Console Logs ({consoleLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {consoleLogs.length === 0 ? <Text style={styles.debugEmpty}>Nenhum log ainda</Text> : consoleLogs.map((log, idx) => (
                                <Text key={idx} style={[styles.debugLogItem, log.startsWith('[error]') && styles.debugLogError, log.startsWith('[warn]') && styles.debugLogWarn]}>{log}</Text>
                            ))}
                        </ScrollView>
                        <Text style={styles.debugSectionTitle}>Network ({networkLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {networkLogs.length === 0 ? <Text style={styles.debugEmpty}>Nenhuma requisição ainda</Text> : networkLogs.map((req, idx) => (
                                <View key={idx} style={styles.networkLogItem}>
                                    <Text style={styles.networkMethod}>{req.method}</Text>
                                    <Text style={styles.networkUrl} numberOfLines={1}>{req.url}</Text>
                                    {req.status !== null && <Text style={[styles.networkStatus, (req.status || 0) >= 400 && styles.networkStatusError]}>{req.status}</Text>}
                                </View>
                            ))}
                        </ScrollView>
                        <View style={styles.debugButtons}>
                            <TouchableOpacity style={styles.debugClearBtn} onPress={() => { setConsoleLogs([]); setNetworkLogs([]); }}><Text style={styles.debugClearText}>Limpar</Text></TouchableOpacity>
                            <TouchableOpacity style={styles.closeBtn} onPress={() => setShowDebugPanel(false)}><Text style={styles.closeText}>Fechar</Text></TouchableOpacity>
                        </View>
                    </View>
                </View>
            </Modal>

        </SafeAreaView >
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    hidden: { position: 'absolute', opacity: 0, zIndex: -1, width: 0, height: 0, overflow: 'hidden' },
    loadingContainer: { justifyContent: 'center', alignItems: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.surfaceVariant },
    backBtn: { marginRight: spacing.md },
    backText: { color: colors.onPrimary, fontSize: 16 },
    title: { flex: 1, color: colors.onSurface, fontSize: 18, fontWeight: '600' },
    version: { color: colors.onSurfaceVariant, fontSize: 14 },
    webview: { flex: 1, backgroundColor: '#FFFFFF' },
    toolbar: { flexDirection: 'row', backgroundColor: colors.surface, borderTopWidth: 1, borderTopColor: colors.surfaceVariant, paddingVertical: spacing.sm, paddingHorizontal: spacing.md, justifyContent: 'space-around' },
    toolbarBtn: { alignItems: 'center', padding: spacing.sm },
    toolbarIcon: { fontSize: 24 },
    toolbarText: { color: colors.onSurface, fontSize: 12, marginTop: 4 },
    sheetOverlay: { flex: 1, backgroundColor: 'rgba(0,0,0,0.7)', justifyContent: 'flex-end' },
    sheet: { backgroundColor: colors.surface, borderTopLeftRadius: borderRadius.xl, borderTopRightRadius: borderRadius.xl, padding: spacing.lg },
    sheetTitle: { fontSize: 20, fontWeight: 'bold', color: colors.onSurface, marginBottom: spacing.md },
    editInput: { backgroundColor: colors.surfaceVariant, borderRadius: borderRadius.md, padding: spacing.md, color: colors.onSurface, fontSize: 16, minHeight: 100, textAlignVertical: 'top' },
    sheetButtons: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: spacing.md, marginTop: spacing.lg },
    cancelBtn: { padding: spacing.md },
    cancelText: { color: colors.onSurfaceVariant, fontSize: 16 },
    applyBtn: { backgroundColor: colors.primary, paddingVertical: spacing.sm, paddingHorizontal: spacing.lg, borderRadius: borderRadius.md },
    applyText: { color: colors.onPrimary, fontSize: 16, fontWeight: '600' },
    editingContainer: { alignItems: 'center', paddingVertical: spacing.xl },
    editingText: { color: colors.onSurface, marginTop: spacing.md },
    editorContainer: { flex: 1, backgroundColor: colors.background },
    editorHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', padding: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.surfaceVariant },
    editorTitle: { color: colors.onSurface, fontSize: 18, fontWeight: '600' },
    saveText: { color: colors.primary, fontSize: 16, fontWeight: '600' },
    codeEditor: { flex: 1, backgroundColor: colors.surfaceVariant, color: colors.onSurface, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 14, padding: spacing.md, textAlignVertical: 'top' },
    versionList: { maxHeight: 300 },
    versionItem: { backgroundColor: colors.surfaceVariant, borderRadius: borderRadius.md, padding: spacing.md, marginBottom: spacing.sm },
    versionItemActive: { backgroundColor: colors.primaryContainer, borderWidth: 1, borderColor: colors.primary },
    versionNumber: { color: colors.onSurface, fontWeight: '600' },
    versionDate: { color: colors.onSurfaceVariant, fontSize: 12 },
    versionInstruction: { color: colors.onSurfaceVariant, fontSize: 12, marginTop: 4 },
    closeBtn: { alignItems: 'center', padding: spacing.md, marginTop: spacing.md },
    closeText: { color: colors.primary, fontSize: 16 },
    debugSectionTitle: { color: colors.onSurface, fontSize: 16, fontWeight: '600', marginTop: spacing.md, marginBottom: spacing.sm },
    debugLogsContainer: { maxHeight: 150, backgroundColor: colors.background, borderRadius: borderRadius.md, padding: spacing.sm },
    debugEmpty: { color: colors.onSurfaceVariant, fontStyle: 'italic', textAlign: 'center', padding: spacing.md },
    debugLogItem: { color: colors.onSurface, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace', fontSize: 12, marginBottom: 4 },
    debugLogError: { color: colors.error },
    debugLogWarn: { color: '#FFA500' },
    networkLogItem: { flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surfaceVariant, borderRadius: borderRadius.sm, padding: spacing.sm, marginBottom: 4, gap: spacing.sm },
    networkMethod: { color: colors.primary, fontWeight: '600', fontSize: 12, width: 50 },
    networkUrl: { flex: 1, color: colors.onSurface, fontSize: 12 },
    networkStatus: { color: colors.onSurface, fontWeight: '600', fontSize: 12 },
    networkStatusError: { color: colors.error },
    debugButtons: { flexDirection: 'row', justifyContent: 'space-between', marginTop: spacing.md },
    debugClearBtn: { padding: spacing.md },
    debugClearText: { color: colors.error, fontSize: 16 },

    contextContainer: { backgroundColor: colors.primaryContainer, padding: spacing.sm, borderRadius: borderRadius.md, marginBottom: spacing.md },
    contextLabel: { color: colors.onSurfaceVariant, fontSize: 12 },
    contextValue: { color: colors.onSurface, fontWeight: 'bold', marginVertical: 4 },
    contextClearBtn: { alignSelf: 'flex-end' },
    contextClearText: { color: colors.primary, fontSize: 12 },
});
