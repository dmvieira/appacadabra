import React, { useEffect, useState, useRef, useCallback } from 'react';
import {
    View,
    Text,
    StyleSheet,
    ActivityIndicator,
    BackHandler,
    Platform,
} from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { WebView, WebViewMessageEvent } from 'react-native-webview';
import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Contacts from 'expo-contacts';
import * as LocalAuthentication from 'expo-local-authentication';
import * as AuthSession from 'expo-auth-session';
import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { getInjectedJavaScript, createCallbackScript, createStorageRestoreScript, createSharedContentSetupScript } from './lib/bridges/injectedJS';
import * as gemini from './lib/api/gemini';
import * as db from './lib/database/db';
import { colors } from './lib/theme';
import { GeneratedApp } from './lib/database/types';

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

            let success = true;
            let result = '';

            switch (type) {
                case 'AI_GENERATE':
                    try {
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
                    }
                    break;

                case 'CALENDAR_CREATE_EVENT':
                case 'CALENDAR_CREATE_EVENT_REMINDER':
                    try {
                        // Cross-platform: Use Google Calendar URL - works on both Android and iOS
                        const startMs = data.startTimeMs;
                        const endMs = data.endTimeMs;
                        const eventTitle = encodeURIComponent(data.title || 'Novo Evento');
                        const eventDesc = encodeURIComponent(data.description || '');

                        // Format dates for Google Calendar URL (YYYYMMDDTHHmmssZ format)
                        const startDate = new Date(startMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
                        const endDate = new Date(endMs).toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';

                        // Google Calendar URL - user can confirm before saving
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

                        const id1 = await Notifications.scheduleNotificationAsync({
                            content: { title: data.title, body: data.message },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
                                seconds: data.delayMinutes * 60,
                            },
                        });
                        result = id1;
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

                        const id2 = await Notifications.scheduleNotificationAsync({
                            content: { title: data.title, body: data.message },
                            trigger: {
                                type: Notifications.SchedulableTriggerInputTypes.DATE,
                                date: new Date(data.timeMs),
                            },
                        });
                        result = id2;
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

                case 'STORAGE_SET':
                    if (app) await db.setStorageItem(app.id, data.key, data.value);
                    break;

                case 'STORAGE_REMOVE':
                    if (app) await db.removeStorageItem(app.id, data.key);
                    break;

                case 'STORAGE_CLEAR':
                    if (app) await db.clearStorageForApp(app.id);
                    break;

                case 'CONSOLE_LOG':
                case 'NETWORK_LOG':
                    // Silently ignore in run-only mode
                    break;

                case 'LOCATION_GET_CURRENT_POSITION':
                    try {
                        console.log('RunnerApp: Handling LOCATION_GET_CURRENT_POSITION');
                        const locStatus = await Location.requestForegroundPermissionsAsync();
                        if (locStatus.status === 'granted') {
                            const loc = await Location.getCurrentPositionAsync({});
                            result = JSON.stringify(loc);
                        } else {
                            result = 'Permission denied';
                            success = false;
                        }
                    } catch (e) {
                        console.error('RunnerApp location error:', e);
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
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

                // ============= Biometrics Handlers =============
                case 'BIOMETRICS_IS_AVAILABLE':
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

                case 'BIOMETRICS_AUTHENTICATE':
                    try {
                        const authResult = await LocalAuthentication.authenticateAsync({
                            promptMessage: data.reason || 'Autenticar',
                            fallbackLabel: 'Usar senha',
                            disableDeviceFallback: false,
                        });
                        result = JSON.stringify(authResult);
                    } catch (e) {
                        success = false;
                        result = e instanceof Error ? e.message : 'Error';
                    }
                    break;

                // ============= Auth Handlers =============
                case 'AUTH_OPEN_URL':
                    try {
                        const redirectUri = data.redirectUrl || AuthSession.makeRedirectUri();
                        const authUrl = data.authUrl.includes('redirect_uri=') ? data.authUrl : `${data.authUrl}${data.authUrl.includes('?') ? '&' : '?'}redirect_uri=${encodeURIComponent(redirectUri)}`;
                        await Linking.openURL(authUrl);
                        result = JSON.stringify({ type: 'opened', redirectUri });
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
                    console.log('Unknown message type:', type);
            }

            if (callbackName && webViewRef.current) {
                const script = createCallbackScript(callbackName, success, result);
                webViewRef.current.injectJavaScript(script);
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
        ${getInjectedJavaScript(app.id)}
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
                    const setupScript = createSharedContentSetupScript();
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
                if (url.startsWith('http://') || url.startsWith('https://')) {
                    if (!url.includes('localhost')) {
                        Linking.openURL(url);
                        return false;
                    }
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

