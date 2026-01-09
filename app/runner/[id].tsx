import React, { useEffect, useState, useRef, useCallback } from 'react';
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
} from 'react-native';
import { useLocalSearchParams, useRouter, Stack } from 'expo-router';
import { useIsFocused } from '@react-navigation/native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import { useAppStore } from '../../lib/store';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript, createSharedContentSetupScript } from '../../lib/bridges/injectedJS';
import * as gemini from '../../lib/api/gemini';
import * as db from '../../lib/database/db';
import { colors, spacing, borderRadius } from '../../lib/theme';
import { GeneratedApp, AppVersion } from '../../lib/database/types';

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

export default function RunnerScreen() {
    const { id, edit, share, payload } = useLocalSearchParams<{ id: string; edit?: string; share?: string; payload?: string }>();
    const isFocused = useIsFocused();
    const router = useRouter();
    const webViewRef = useRef<WebView>(null);
    const [localSharedContent, setLocalSharedContent] = useState<any>(null);
    const [lastProcessedPayload, setLastProcessedPayload] = useState<string | null>(null);

    const [app, setApp] = useState<GeneratedApp | null>(null);
    const [isLoading, setIsLoading] = useState(true);
    const [consoleLogs, setConsoleLogs] = useState<string[]>([]);

    // Edit mode states
    const isEditMode = edit === 'true';
    const isShareMode = share === 'true'; // Keep for other logic, but injection uses payload presence
    const [showEditSheet, setShowEditSheet] = useState(false);
    const [editPrompt, setEditPrompt] = useState('');
    const [isEditing, setIsEditing] = useState(false);

    // Selection mode state
    const [isSelectionMode, setIsSelectionMode] = useState(false);

    // Manual editor
    const [showManualEditor, setShowManualEditor] = useState(false);
    const [manualCode, setManualCode] = useState('');

    // Version history
    const [showHistory, setShowHistory] = useState(false);
    const [versions, setVersions] = useState<AppVersion[]>([]);

    const { updateAppCode, updateAppWithAI, sharedContent, clearSharedContent } = useAppStore();

    console.log('RunnerScreen: RENDER id:', id, 'isFocused:', isFocused, 'appId:', app?.id);

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

    // Saved localStorage items
    const [savedStorage, setSavedStorage] = useState<{ key: string; value: string }[]>([]);

    // Debug panel states
    const [showDebugPanel, setShowDebugPanel] = useState(false);
    const [networkLogs, setNetworkLogs] = useState<{ url: string; method: string; status?: number; time: number; duration?: number; responseBody?: string }[]>([]);

    // Load app data
    useEffect(() => {
        async function loadApp() {
            if (!id) return;
            const appData = await db.getAppById(parseInt(id));
            if (appData) {
                setApp(appData);
                // Load stored localStorage data
                const storage = await db.getStorageForApp(appData.id);
                setSavedStorage(storage.map(s => ({ key: s.key, value: s.value })));
            }
            setIsLoading(false);
        }
        loadApp();
    }, [id]);

    // Inject saved localStorage and shared content (File or Store)
    const handleLoadEnd = useCallback(() => {
        console.log('Runner: handleLoadEnd called');

        if (webViewRef.current) {
            // Inject saved storage
            if (savedStorage.length > 0) {
                const script = createStorageRestoreScript(savedStorage);
                webViewRef.current.injectJavaScript(script);
            }

            // CHECK BOTH SOURCES: Local File Payload OR Global Store
            const contentToInject = localSharedContent || sharedContent;
            const shouldInject = !!contentToInject && isFocused;

            console.log('Runner: Checking injection. hasContent:', !!contentToInject, 'isFocused:', isFocused);

            if (shouldInject) {
                console.log('Runner: Injecting shared content setup (onLoadEnd)');
                const setupScript = createSharedContentSetupScript();
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
    }, [savedStorage, localSharedContent, sharedContent, clearSharedContent, isFocused]);

    // Handle incoming share when already loaded (hot update)
    useEffect(() => {
        const contentToInject = localSharedContent || sharedContent;
        const shouldInject = !!contentToInject && webViewRef.current && isFocused;

        if (shouldInject) {
            console.log('Runner: Shared content updated while running (focused)');

            const setupScript = createSharedContentSetupScript();
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
        try {
            const messageStr = event.nativeEvent.data;
            // console.log('RAW WebView Message:', messageStr); // Uncomment for deep debug

            const message = JSON.parse(messageStr);
            const { type, data, callbackName, appId } = message;

            // Log non-frequent messages
            if (type !== 'CONSOLE_LOG' && type !== 'NETWORK_LOG') {
                console.log('WebView Message received:', type);
            } else if (Math.random() > 0.95) {
                // Sample some logs just to prove they are arriving
                console.log('Sample Log/Network message received:', type);
            }

            let success = true;
            let result = '';

            switch (type) {
                // ============= AI Handlers =============
                case 'ELEMENT_SELECTED':
                    // User selected an element in selection mode
                    setIsSelectionMode(false);
                    // Turn off selection mode in webview
                    if (webViewRef.current) {
                        webViewRef.current.injectJavaScript('window.toggleSelectionMode(false); true;');
                    }

                    const { tagName, html, preview } = data;
                    setEditPrompt(`Alterar este elemento ${tagName}:\n${preview}\n\n[Instrução aqui]`);
                    setShowEditSheet(true);
                    break;

                case 'AI_GENERATE_TEXT':
                    try {
                        result = await gemini.aiGenerateText(data.prompt);
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'AI_DESCRIBE_IMAGE':
                    try {
                        result = await gemini.aiDescribeImage(data.base64, data.prompt);
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'AI_EXTRACT_STRUCTURED':
                    try {
                        result = await gemini.aiExtractStructuredData(data.text, data.schema);
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                // ============= Calendar Handlers =============
                case 'CALENDAR_CREATE_EVENT':
                case 'CALENDAR_CREATE_EVENT_REMINDER':
                    try {
                        // Try to open calendar with pre-filled event
                        const url = Platform.select({
                            ios: `calshow:${Math.floor(data.startTimeMs / 1000)}`,
                            android: `content://com.android.calendar/time/${data.startTimeMs}`,
                            default: '',
                        });

                        // For better UX, use Linking to open calendar
                        if (Platform.OS === 'android') {
                            await Linking.openURL(`content://com.android.calendar/events`);
                        } else {
                            // On iOS, we need calendar permission first
                            const { status } = await Calendar.requestCalendarPermissionsAsync();
                            if (status === 'granted') {
                                const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
                                const defaultCalendar = calendars.find(c => c.allowsModifications);

                                if (defaultCalendar) {
                                    await Calendar.createEventAsync(defaultCalendar.id, {
                                        title: data.title,
                                        notes: data.description,
                                        startDate: new Date(data.startTimeMs),
                                        endDate: new Date(data.endTimeMs),
                                        alarms: type === 'CALENDAR_CREATE_EVENT_REMINDER'
                                            ? [{ relativeOffset: -data.reminderMinutes }]
                                            : undefined,
                                    });
                                    result = 'Event created successfully';
                                } else {
                                    result = 'No writable calendar found';
                                    success = false;
                                }
                            } else {
                                result = 'Calendar permission denied';
                                success = false;
                            }
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'CALENDAR_HAS_PERMISSION':
                    const calPerm = await Calendar.getCalendarPermissionsAsync();
                    result = (calPerm.status === 'granted').toString();
                    break;

                case 'CALENDAR_REQUEST_PERMISSION':
                    await Calendar.requestCalendarPermissionsAsync();
                    break;

                // ============= Notification Handlers =============
                case 'NOTIFY_SHOW_NOW':
                    try {
                        await Notifications.scheduleNotificationAsync({
                            content: {
                                title: data.title,
                                body: data.message,
                            },
                            trigger: null, // immediate
                        });
                        result = 'Notification sent';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'NOTIFY_SCHEDULE':
                    try {
                        const identifier = await Notifications.scheduleNotificationAsync({
                            content: {
                                title: data.title,
                                body: data.message,
                            },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                                seconds: data.delayMinutes * 60,
                            },
                        });
                        result = identifier;
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'NOTIFY_SCHEDULE_AT':
                    try {
                        const identifier = await Notifications.scheduleNotificationAsync({
                            content: {
                                title: data.title,
                                body: data.message,
                            },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.DATE,
                                date: new Date(data.timeMs),
                            },
                        });
                        result = identifier;
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'NOTIFY_HAS_PERMISSION':
                    const notifPerm = await Notifications.getPermissionsAsync();
                    result = (notifPerm.status === 'granted').toString();
                    break;

                case 'NOTIFY_REQUEST_PERMISSION':
                    await Notifications.requestPermissionsAsync();
                    break;

                // ============= Storage Handlers =============
                case 'STORAGE_SET':
                    if (app) {
                        await db.setStorageItem(app.id, data.key, data.value);
                    }
                    break;

                case 'STORAGE_REMOVE':
                    if (app) {
                        await db.removeStorageItem(app.id, data.key);
                    }
                    break;

                case 'STORAGE_CLEAR':
                    if (app) {
                        await db.clearStorageForApp(app.id);
                    }
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

                default:
                    console.log('Unknown message type:', type);
            }

            // Send callback if needed
            if (callbackName && webViewRef.current) {
                const script = createCallbackScript(callbackName, success, result);
                webViewRef.current.injectJavaScript(script);
            }
        } catch (e) {
            console.error('Error handling WebView message:', e);
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

        setIsEditing(true);
        try {
            const updatedApp = await updateAppWithAI(app, editPrompt);
            if (updatedApp) {
                setApp(updatedApp);
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
        if (updatedApp) {
            setApp(updatedApp);
        }
        setShowManualEditor(false);
    };

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
            'Excluir Versão',
            `Tem certeza que deseja excluir a versão ${version.version}?`,
            [
                { text: 'Cancelar', style: 'cancel' },
                {
                    text: 'Excluir',
                    style: 'destructive',
                    onPress: async () => {
                        await db.deleteVersion(version.id);
                        const updatedVersions = await db.getVersionsForApp(app.id);
                        setVersions(updatedVersions);
                    }
                }
            ]
        );
    };

    if (isLoading || !app) {
        return (
            <SafeAreaView style={styles.container}>
                <View style={styles.loadingContainer}>
                    <ActivityIndicator size="large" color={colors.primary} />
                </View>
            </SafeAreaView>
        );
    }

    // Prepare localStorage injection script
    const getStorageInitScript = async () => {
        const storage = await db.getStorageForApp(app.id);
        if (storage.length === 0) return '';

        const items = storage.map(s =>
            `localStorage.setItem(${JSON.stringify(s.key)}, ${JSON.stringify(s.value)});`
        ).join('\n');

        return `(function() { ${items} })();`;
    };

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

    // Combine scripts
    const storageScript = createStorageRestoreScript(savedStorage);
    const combinedScript = `
        ${getInjectedJavaScript(app.id)}
        ${storageScript}
    `;

    return (
        <SafeAreaView style={styles.container} edges={['top']}>
            {/* Configure Header Options */}
            <Stack.Screen
                options={{
                    title: app?.name || 'App',
                    headerShown: false, // We use our own header or none
                }}
            />

            {/* Header - Only in Edit Mode */}
            {isEditMode && (
                <View style={styles.header}>
                    <TouchableOpacity onPress={() => router.back()} style={styles.backBtn}>
                        <Text style={styles.backText}>← Voltar</Text>
                    </TouchableOpacity>
                    <Text style={styles.title} numberOfLines={1}>{app.name}</Text>
                    <Text style={styles.version}>v{app.currentVersion}</Text>
                </View>
            )}

            {/* WebView */}
            <WebView
                ref={webViewRef}
                source={{ html: htmlContent, baseUrl: 'https://appacadabra.local/' }} // baseUrl required for some permissions
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
                onLoadEnd={handleLoadEnd}
                onMessage={handleMessage}
                onError={(e) => console.error('WebView error:', e.nativeEvent)}
                onShouldStartLoadWithRequest={(request) => {
                    const { url } = request;
                    // External URLs - open in browser
                    if (url.startsWith('http://') || url.startsWith('https://')) {
                        if (!url.includes('localhost')) {
                            Linking.openURL(url);
                            return false;
                        }
                    }
                    return true;
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

            {/* Edit Mode Toolbar */}
            {isEditMode && (
                <View style={styles.toolbar}>
                    <TouchableOpacity
                        style={[styles.toolbarBtn, isSelectionMode && styles.toolbarBtnActive]}
                        onPress={() => {
                            const newMode = !isSelectionMode;
                            setIsSelectionMode(newMode);
                            if (webViewRef.current) {
                                webViewRef.current.injectJavaScript(`window.toggleSelectionMode(${newMode}); true;`);
                            }
                        }}
                    >
                        <Text style={styles.toolbarIcon}>👆</Text>
                        <Text style={styles.toolbarText}>{isSelectionMode ? 'Cancel' : 'Select'}</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.toolbarBtn}
                        onPress={() => {
                            setEditPrompt('');  // Clear previous selection context
                            setShowEditSheet(true);
                        }}
                    >
                        <Text style={styles.toolbarIcon}>✏️</Text>
                        <Text style={styles.toolbarText}>Editar</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.toolbarBtn}
                        onPress={() => {
                            setManualCode(app.code);
                            setShowManualEditor(true);
                        }}
                    >
                        <Text style={styles.toolbarIcon}>💻</Text>
                        <Text style={styles.toolbarText}>Código</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.toolbarBtn}
                        onPress={() => {
                            loadVersions();
                            setShowHistory(true);
                        }}
                    >
                        <Text style={styles.toolbarIcon}>📜</Text>
                        <Text style={styles.toolbarText}>Histórico</Text>
                    </TouchableOpacity>

                    <TouchableOpacity
                        style={styles.toolbarBtn}
                        onPress={() => setShowDebugPanel(true)}
                    >
                        <Text style={styles.toolbarIcon}>🐛</Text>
                        <Text style={styles.toolbarText}>Debug</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* Edit Sheet Modal */}
            <Modal visible={showEditSheet} transparent animationType="slide">
                <KeyboardAvoidingView
                    behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
                    style={styles.sheetOverlay}
                >
                    <View style={styles.sheet}>
                        <Text style={styles.sheetTitle}>Editar com IA</Text>

                        {isEditing ? (
                            <View style={styles.editingContainer}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.editingText}>Aplicando mudanças...</Text>
                            </View>
                        ) : (
                            <>
                                <TextInput
                                    style={styles.editInput}
                                    value={editPrompt}
                                    onChangeText={setEditPrompt}
                                    placeholder="Descreva as mudanças desejadas..."
                                    placeholderTextColor={colors.onSurfaceVariant}
                                    multiline
                                    numberOfLines={4}
                                />

                                <View style={styles.sheetButtons}>
                                    <TouchableOpacity
                                        style={styles.cancelBtn}
                                        onPress={() => setShowEditSheet(false)}
                                    >
                                        <Text style={styles.cancelText}>Cancelar</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity
                                        style={styles.applyBtn}
                                        onPress={handleApplyEdit}
                                    >
                                        <Text style={styles.applyText}>Aplicar</Text>
                                    </TouchableOpacity>
                                </View>
                            </>
                        )}
                    </View>
                </KeyboardAvoidingView>
            </Modal>

            {/* Manual Editor Modal */}
            <Modal visible={showManualEditor} animationType="slide">
                <SafeAreaView style={styles.editorContainer}>
                    <View style={styles.editorHeader}>
                        <TouchableOpacity onPress={() => setShowManualEditor(false)}>
                            <Text style={styles.cancelText}>Cancelar</Text>
                        </TouchableOpacity>
                        <Text style={styles.editorTitle}>Editor de Código</Text>
                        <TouchableOpacity onPress={handleSaveManual}>
                            <Text style={styles.saveText}>Salvar</Text>
                        </TouchableOpacity>
                    </View>

                    <TextInput
                        style={styles.codeEditor}
                        value={manualCode}
                        onChangeText={setManualCode}
                        multiline
                        autoCapitalize="none"
                        autoCorrect={false}
                        spellCheck={false}
                    />
                </SafeAreaView>
            </Modal>

            {/* Version History Modal */}
            <Modal visible={showHistory} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '70%' }]}>
                        <Text style={styles.sheetTitle}>Histórico de Versões</Text>

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
                            <Text style={styles.closeText}>Fechar</Text>
                        </TouchableOpacity>
                    </View>
                </View>
            </Modal>

            {/* Debug Panel Modal */}
            <Modal visible={showDebugPanel} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '80%' }]}>
                        <Text style={styles.sheetTitle}>🐛 Debug</Text>

                        <Text style={styles.debugSectionTitle}>Console Logs ({consoleLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {consoleLogs.length === 0 ? (
                                <Text style={styles.debugEmpty}>Nenhum log ainda</Text>
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

                        <Text style={styles.debugSectionTitle}>Network ({networkLogs.length})</Text>
                        <ScrollView style={styles.debugLogsContainer}>
                            {networkLogs.length === 0 ? (
                                <Text style={styles.debugEmpty}>Nenhuma requisição ainda</Text>
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
                                                <Text style={{ color: colors.onSurfaceVariant, fontSize: 10, marginLeft: 4 }}>
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
                                <Text style={styles.debugClearText}>Limpar</Text>
                            </TouchableOpacity>
                            <TouchableOpacity
                                style={styles.closeBtn}
                                onPress={() => setShowDebugPanel(false)}
                            >
                                <Text style={styles.closeText}>Fechar</Text>
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
        marginRight: spacing.md,
    },
    backText: {
        color: colors.primary,
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
    toolbar: {
        flexDirection: 'row',
        backgroundColor: colors.surface,
        borderTopWidth: 1,
        borderTopColor: colors.surfaceVariant,
        paddingVertical: spacing.sm,
        paddingHorizontal: spacing.md,
        justifyContent: 'space-around',
    },
    toolbarBtn: {
        alignItems: 'center',
        padding: spacing.sm,
    },
    toolbarIcon: {
        fontSize: 24,
    },
    toolbarText: {
        color: colors.onSurface,
        fontSize: 12,
        marginTop: 4,
    },
    toolbarBtnActive: {
        backgroundColor: colors.primary + '20', // Low opacity primary
        borderRadius: borderRadius.sm,
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
    editInput: {
        backgroundColor: colors.surfaceVariant,
        borderRadius: borderRadius.md,
        padding: spacing.md,
        color: colors.onSurface,
        fontSize: 16,
        minHeight: 100,
        textAlignVertical: 'top',
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
    codeEditor: {
        flex: 1,
        backgroundColor: colors.surfaceVariant,
        color: colors.onSurface,
        fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
        fontSize: 14,
        padding: spacing.md,
        textAlignVertical: 'top',
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
});
