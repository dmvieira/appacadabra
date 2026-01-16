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
    Platform,
    KeyboardAvoidingView,
    BackHandler,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Contacts from 'expo-contacts';
import * as LocalAuthentication from 'expo-local-authentication';

import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { useAppStore } from '../lib/store';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript } from '../lib/bridges/injectedJS';
import { handleBridgeMessage } from '../lib/bridges/messageHandlers';
import * as gemini from '../lib/api/gemini';
import * as db from '../lib/database/db';
import { colors, spacing, borderRadius } from '../lib/theme';
import { GeneratedApp, AppVersion } from '../lib/database/types';
import * as ShareIntent from 'share-intent';

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

    // Debug panel states
    const [showDebugPanel, setShowDebugPanel] = useState(false);
    const [networkLogs, setNetworkLogs] = useState<{ url: string; method: string; status?: number; time: number }[]>([]);

    // Load app data
    useEffect(() => {
        async function loadApp() {
            const appData = await db.getAppById(appId);
            if (appData) {
                setApp(appData);
                // Load stored localStorage data
                const storage = await db.getStorageForApp(appData.id);
                setSavedStorage(storage.map(s => ({ key: s.key, value: s.value })));
            }
            setIsLoading(false);
        }
        loadApp();
    }, [appId]);

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
        try {
            const messageStr = event.nativeEvent.data;
            const message = JSON.parse(messageStr);
            const { type, data, callbackName, appId: msgAppId } = message;

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

            switch (type) {
                // ============= AI Handlers =============
                case 'AI_GENERATE':
                    try {
                        console.log('[AppRunner] AI_GENERATE request received.');
                        if (data.image) console.log('[AppRunner] Image payload length:', data.image.length);
                        if (data.audio) console.log('[AppRunner] Audio payload length:', data.audio.length);

                        result = await gemini.aiGenerate({
                            prompt: data.prompt,
                            search: data.search,
                            schema: data.schema,
                            image: data.image,
                            audio: data.audio,
                        });
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                        console.error('[AppRunner] AI_GENERATE Error:', e);
                    }
                    break;

                // ============= Calendar Handlers =============
                case 'CALENDAR_CREATE_EVENT':
                case 'CALENDAR_CREATE_EVENT_REMINDER':
                    try {
                        // Cross-platform: Use Google Calendar URL
                        const startMs = data.startTimeMs;
                        const endMs = data.endTimeMs;
                        const eventTitle = encodeURIComponent(data.title || 'Novo Evento');
                        const eventDesc = encodeURIComponent(data.description || '');

                        // Format dates for Google Calendar URL (YYYYMMDDTHHmmssZ format)
                        const startDate = new Date(startMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
                        const endDate = new Date(endMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

                        const googleCalUrl = `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${eventTitle}&details=${eventDesc}&dates=${startDate}/${endDate}`;
                        await Linking.openURL(googleCalUrl);
                        result = 'Calendar opened';
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
                        // Request permission if not granted
                        const showNowPerm = await Notifications.getPermissionsAsync();
                        if (showNowPerm.status !== 'granted') {
                            const { status } = await Notifications.requestPermissionsAsync();
                            if (status !== 'granted') {
                                success = false;
                                result = 'Notification permission denied';
                                break;
                            }
                        }

                        await Notifications.scheduleNotificationAsync({
                            content: { title: data.title, body: data.message },
                            trigger: null,
                        });
                        result = 'Notification sent';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'NOTIFY_SCHEDULE':
                    try {
                        // Request permission if not granted
                        const schedulePerm = await Notifications.getPermissionsAsync();
                        if (schedulePerm.status !== 'granted') {
                            const { status } = await Notifications.requestPermissionsAsync();
                            if (status !== 'granted') {
                                success = false;
                                result = 'Notification permission denied';
                                break;
                            }
                        }

                        await Notifications.scheduleNotificationAsync({
                            content: { title: data.title, body: data.message },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                                seconds: data.delayMinutes * 60,
                            },
                        });
                        result = 'Notification scheduled';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'NOTIFY_SCHEDULE_AT':
                    try {
                        // Request permission if not granted
                        const scheduleAtPerm = await Notifications.getPermissionsAsync();
                        if (scheduleAtPerm.status !== 'granted') {
                            const { status } = await Notifications.requestPermissionsAsync();
                            if (status !== 'granted') {
                                success = false;
                                result = 'Notification permission denied';
                                break;
                            }
                        }

                        await Notifications.scheduleNotificationAsync({
                            content: { title: data.title, body: data.message },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.DATE,
                                date: new Date(data.timeMs),
                            },
                        });
                        result = 'Notification scheduled';
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
                    if (app) await db.setStorageItem(app.id, data.key, data.value);
                    break;
                case 'STORAGE_REMOVE':
                    if (app) await db.removeStorageItem(app.id, data.key);
                    break;
                case 'STORAGE_CLEAR':
                    if (app) await db.clearStorageForApp(app.id);
                    break;

                // ============= Console Log =============
                case 'CONSOLE_LOG':
                    setConsoleLogs(prev => [...prev.slice(-99), `[${data.type}] ${data.message}`]);
                    break;

                case 'NETWORK_LOG':
                    setNetworkLogs(prev => [...prev.slice(-49), {
                        url: data.url,
                        method: data.method,
                        status: data.status,
                        time: Date.now(),
                    }]);
                    break;

                case 'ELEMENT_SELECTED':
                    console.log('Element selected:', data.tagName);
                    // Disable mode
                    if (webViewRef.current) webViewRef.current.injectJavaScript('if(window.toggleSelectionMode) window.toggleSelectionMode(false); true;');
                    setIsSelectingElement(false);
                    setSelectionContext(data.html || '');
                    setShowEditSheet(true);
                    break;

                // ============= Share Handlers =============
                case 'SHARE_CONTENT':
                    try {
                        if (await Sharing.isAvailableAsync()) {
                            const content = data.text || data.url || '';
                            const tempPath = FileSystem.cacheDirectory + 'share_temp.txt';
                            await FileSystem.writeAsStringAsync(tempPath, content);
                            await Sharing.shareAsync(tempPath, { mimeType: 'text/plain' });
                            result = 'Shared';
                        } else {
                            if (data.url) await Linking.openURL(`mailto:?body=${encodeURIComponent(data.text || '')} ${data.url}`);
                            result = 'Shared via fallback';
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'SHARE_FILE':
                    try {
                        if (await Sharing.isAvailableAsync()) {
                            const tempPath = FileSystem.cacheDirectory + (data.filename || 'shared_file');
                            await FileSystem.writeAsStringAsync(tempPath, data.base64, { encoding: FileSystem.EncodingType.Base64 });
                            await Sharing.shareAsync(tempPath, { mimeType: data.mimeType || 'application/octet-stream' });
                            result = 'File shared';
                        } else {
                            success = false;
                            result = 'Sharing not available';
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                // ============= Contacts Handlers =============
                case 'CONTACTS_GET_ALL':
                    try {
                        const contactsPerm = await Contacts.requestPermissionsAsync();
                        if (contactsPerm.status === 'granted') {
                            const { data: contacts } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails] });
                            result = JSON.stringify(contacts.slice(0, 100));
                        } else {
                            success = false;
                            result = 'Contacts permission denied';
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'CONTACTS_SEARCH':
                    try {
                        const searchPerm = await Contacts.requestPermissionsAsync();
                        if (searchPerm.status === 'granted') {
                            const { data: allContacts } = await Contacts.getContactsAsync({ fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails] });
                            const query = (data.query || '').toLowerCase();
                            const filtered = allContacts.filter(c => c.name?.toLowerCase().includes(query) || c.phoneNumbers?.some(p => p.number?.includes(query)) || c.emails?.some(e => e.email?.toLowerCase().includes(query)));
                            result = JSON.stringify(filtered.slice(0, 50));
                        } else {
                            success = false;
                            result = 'Contacts permission denied';
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'CONTACTS_ADD':
                    try {
                        const addPerm = await Contacts.requestPermissionsAsync();
                        if (addPerm.status === 'granted') {
                            const contact = data.contact || {};
                            const newContact: Contacts.Contact = {
                                contactType: Contacts.ContactTypes.Person,
                                name: contact.name || '',
                                firstName: contact.firstName || contact.name?.split(' ')[0] || '',
                                lastName: contact.lastName || contact.name?.split(' ').slice(1).join(' ') || '',
                                phoneNumbers: contact.phone ? [{ number: contact.phone, label: 'mobile' }] : [],
                                emails: contact.email ? [{ email: contact.email, label: 'work' }] : [],
                            };
                            const contactId = await Contacts.addContactAsync(newContact);
                            result = contactId;
                        } else {
                            success = false;
                            result = 'Contacts permission denied';
                        }
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;



                // ============= Auth Handlers =============
                case 'AUTH_IS_AVAILABLE':
                    try {
                        const hasHardware = await LocalAuthentication.hasHardwareAsync();
                        const isEnrolled = await LocalAuthentication.isEnrolledAsync();
                        const types = await LocalAuthentication.supportedAuthenticationTypesAsync();
                        result = JSON.stringify({ available: hasHardware && isEnrolled, types });
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'AUTH_AUTHENTICATE':
                    try {
                        const authResult = await LocalAuthentication.authenticateAsync({
                            promptMessage: data.reason || 'Confirmar identidade',
                            fallbackLabel: 'Usar senha',
                            disableDeviceFallback: false,
                        });
                        result = JSON.stringify(authResult);
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;



                // ============= Sensors Handlers =============
                case 'SENSORS_START_ACCELEROMETER':
                    try {
                        Accelerometer.setUpdateInterval(data.intervalMs || 100);
                        Accelerometer.addListener(sensorData => {
                            if (webViewRef.current && data.callbackName) {
                                webViewRef.current.injectJavaScript(createCallbackScript(data.callbackName, true, JSON.stringify(sensorData)));
                            }
                        });
                        result = 'Accelerometer started';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'SENSORS_START_GYROSCOPE':
                    try {
                        Gyroscope.setUpdateInterval(data.intervalMs || 100);
                        Gyroscope.addListener(sensorData => {
                            if (webViewRef.current && data.callbackName) {
                                webViewRef.current.injectJavaScript(createCallbackScript(data.callbackName, true, JSON.stringify(sensorData)));
                            }
                        });
                        result = 'Gyroscope started';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'SENSORS_START_MAGNETOMETER':
                    try {
                        Magnetometer.setUpdateInterval(data.intervalMs || 100);
                        Magnetometer.addListener(sensorData => {
                            if (webViewRef.current && data.callbackName) {
                                const { x, y } = sensorData;
                                let heading = Math.atan2(y, x) * (180 / Math.PI);
                                if (heading < 0) heading += 360;
                                const dataWithHeading = { ...sensorData, heading };
                                webViewRef.current.injectJavaScript(createCallbackScript(data.callbackName, true, JSON.stringify(dataWithHeading)));
                            }
                        });
                        result = 'Magnetometer started';
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                case 'SENSORS_STOP_ACCELEROMETER':
                    Accelerometer.removeAllListeners();
                    result = 'Accelerometer stopped';
                    break;

                case 'SENSORS_STOP_GYROSCOPE':
                    Gyroscope.removeAllListeners();
                    result = 'Gyroscope stopped';
                    break;

                case 'SENSORS_STOP_MAGNETOMETER':
                    Magnetometer.removeAllListeners();
                    result = 'Magnetometer stopped';
                    break;

                case 'SENSORS_STOP_ALL':
                    Accelerometer.removeAllListeners();
                    Gyroscope.removeAllListeners();
                    Magnetometer.removeAllListeners();
                    result = 'All sensors stopped';
                    break;

                default:
                    // Delegate to shared handlers for common message types
                    const sharedResult = await handleBridgeMessage(type, data, {
                        webViewRef: webViewRef as React.RefObject<WebView>,
                        appId: app?.id || null,
                    });
                    if (sharedResult.handled) {
                        success = sharedResult.success;
                        result = sharedResult.result;
                    } else {
                        console.log('Unknown message type:', type);
                    }
            }

            if (callbackName && webViewRef.current) {
                const script = createCallbackScript(callbackName, success, result);
                webViewRef.current.injectJavaScript(script);
            }
        } catch (e) {
            console.error('Error handling WebView message:', e);
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
            const updatedApp = await updateAppWithAI(app, editPrompt, selectionContext);
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

    if (!app) {
        // If app failed to load or just started
        if (isLoading) {
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
    const combinedScript = `${getInjectedJavaScript(app.id)} ${storageScript}`;

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
                        <Text style={styles.backText}>← Voltar</Text>
                    </TouchableOpacity>
                    <Text style={styles.title} numberOfLines={1}>{app.name}</Text>
                    <Text style={styles.version}>v{app.currentVersion}</Text>
                </View>
            )}

            {/* WebView */}
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
            {mode === 'edit' && (
                <View style={styles.toolbar}>
                    <TouchableOpacity
                        style={[styles.toolbarBtn, isSelectingElement && { backgroundColor: colors.primaryContainer }]}
                        onPress={handleEditPress}
                    >
                        <Text style={styles.toolbarIcon}>{isSelectingElement ? '❌' : '✏️'}</Text>
                        <Text style={styles.toolbarText}>{isSelectingElement ? 'Cancelar' : 'Editar'}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.toolbarBtn} onPress={() => { setManualCode(app.code); setShowManualEditor(true); }}>
                        <Text style={styles.toolbarIcon}>💻</Text>
                        <Text style={styles.toolbarText}>Código</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.toolbarBtn} onPress={() => { loadVersions(); setShowHistory(true); }}>
                        <Text style={styles.toolbarIcon}>📜</Text>
                        <Text style={styles.toolbarText}>Histórico</Text>
                    </TouchableOpacity>
                    <TouchableOpacity style={styles.toolbarBtn} onPress={() => setShowDebugPanel(true)}>
                        <Text style={styles.toolbarIcon}>🐛</Text>
                        <Text style={styles.toolbarText}>Debug</Text>
                    </TouchableOpacity>
                </View>
            )}

            {/* Edit Sheet */}
            <Modal visible={showEditSheet} transparent animationType="slide">
                <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : 'height'} style={styles.sheetOverlay}>
                    <View style={styles.sheet}>
                        <Text style={styles.sheetTitle}>Editar com IA</Text>
                        {isEditing ? (
                            <View style={styles.editingContainer}>
                                <ActivityIndicator size="large" color={colors.primary} />
                                <Text style={styles.editingText}>Aplicando mudanças...</Text>
                            </View>
                        ) : (
                            <>
                                {selectionContext ? (
                                    <View style={styles.contextContainer}>
                                        <Text style={styles.contextLabel}>Focando na seleção:</Text>
                                        <Text style={styles.contextValue} numberOfLines={2}>"{selectionContext}"</Text>
                                        <TouchableOpacity onPress={() => setSelectionContext('')} style={styles.contextClearBtn}>
                                            <Text style={styles.contextClearText}>Remover seleção</Text>
                                        </TouchableOpacity>
                                    </View>
                                ) : null}
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
                                    <TouchableOpacity style={styles.cancelBtn} onPress={() => setShowEditSheet(false)}>
                                        <Text style={styles.cancelText}>Cancelar</Text>
                                    </TouchableOpacity>
                                    <TouchableOpacity style={styles.applyBtn} onPress={handleApplyEdit}>
                                        <Text style={styles.applyText}>Aplicar</Text>
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
                        <TouchableOpacity onPress={() => setShowManualEditor(false)}><Text style={styles.cancelText}>Cancelar</Text></TouchableOpacity>
                        <Text style={styles.editorTitle}>Editor de Código</Text>
                        <TouchableOpacity onPress={handleSaveManual}><Text style={styles.saveText}>Salvar</Text></TouchableOpacity>
                    </View>
                    <TextInput style={styles.codeEditor} value={manualCode} onChangeText={setManualCode} multiline autoCapitalize="none" autoCorrect={false} spellCheck={false} />
                </SafeAreaView>
            </Modal>

            <Modal visible={showHistory} transparent animationType="slide">
                <View style={styles.sheetOverlay}>
                    <View style={[styles.sheet, { maxHeight: '70%' }]}>
                        <Text style={styles.sheetTitle}>Histórico de Versões</Text>
                        <ScrollView style={styles.versionList}>
                            {versions.map((version) => (
                                <TouchableOpacity key={version.id} style={[styles.versionItem, version.version === app.currentVersion && styles.versionItemActive]} onPress={() => handleRestoreVersion(version)} disabled={version.version === app.currentVersion}>
                                    <Text style={styles.versionNumber}>v{version.version}</Text>
                                    <Text style={styles.versionDate}>{new Date(version.createdAt).toLocaleDateString('pt-BR')}</Text>
                                    {version.instruction && <Text style={styles.versionInstruction} numberOfLines={1}>{version.instruction}</Text>}
                                </TouchableOpacity>
                            ))}
                        </ScrollView>
                        <TouchableOpacity style={styles.closeBtn} onPress={() => setShowHistory(false)}><Text style={styles.closeText}>Fechar</Text></TouchableOpacity>
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

        </SafeAreaView>
    );
}

const styles = StyleSheet.create({
    container: { flex: 1, backgroundColor: colors.background },
    hidden: { position: 'absolute', opacity: 0, zIndex: -1, width: 0, height: 0, overflow: 'hidden' },
    loadingContainer: { justifyContent: 'center', alignItems: 'center' },
    header: { flexDirection: 'row', alignItems: 'center', padding: spacing.md, backgroundColor: colors.surface, borderBottomWidth: 1, borderBottomColor: colors.surfaceVariant },
    backBtn: { marginRight: spacing.md },
    backText: { color: colors.primary, fontSize: 16 },
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
