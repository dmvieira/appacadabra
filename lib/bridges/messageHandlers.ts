/**
 * Shared WebView message handlers
 * 
 * This module provides a unified handler for WebView bridge messages,
 * reducing code duplication across [id].tsx, RunnerApp.tsx, and AppRunner.tsx
 */

import * as Calendar from 'expo-calendar';
import * as Notifications from 'expo-notifications';
import * as Linking from 'expo-linking';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';
import * as Contacts from 'expo-contacts';
import * as LocalAuthentication from 'expo-local-authentication';
import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import { WebView } from 'react-native-webview';
import * as ai from '../api/ai';
import * as AuthSession from 'expo-auth-session'; // Add import for AuthSession to support AUTH_OPEN_URL
import * as db from '../database/db';
import { createCallbackScript } from './injectedJS';
import { t } from '../i18n';
import { useManaStore } from '../manaStore';

export interface HandlerContext {
    webViewRef: React.RefObject<WebView>;
    appId: number | null;
}

export interface HandlerResult {
    success: boolean;
    result: string;
    handled: boolean;  // false if message type was not recognized
}

/**
 * Handle a WebView bridge message.
 * Returns { handled: false } if the message type is not recognized,
 * allowing the caller to handle it locally.
 */
export async function handleBridgeMessage(
    type: string,
    data: any,
    ctx: HandlerContext
): Promise<HandlerResult> {
    let success = true;
    let result = '';

    switch (type) {
        // ============= AI Handler =============
        case 'AI_GENERATE':
            try {
                // Mana check is handled by server now, but we could add a check if we fetched balance
                // For now, let's trust the server response or generic error

                const genResult = await ai.aiGenerate({
                    prompt: data.prompt,
                    search: data.search,
                    schema: data.schema,
                    image: data.image,
                    audio: data.audio,
                });
                result = genResult.text;

                // Log cost (optional)
                console.log(`[Bridge] AI generated. Usage:`, genResult.usage);

                // Update App Total Mana Cost if we have appId
                // Assuming we can get cost from usage if server provides it in response
                if (ctx.appId) {
                    // Similar to [id].tsx, we might skip this update if we don't have exact cost
                    // or rely on server to update the app record if possible (but server func usually doesn't update app doc unless specified)
                    // We will leave this as is for now, maybe just skipping cost update locally
                }
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Calendar Handlers =============
        case 'CALENDAR_CREATE_EVENT':
        case 'CALENDAR_CREATE_EVENT_REMINDER':
            try {
                const startMs = data.startTimeMs;
                const endMs = data.endTimeMs;
                const eventTitle = encodeURIComponent(data.title || t('newEvent'));
                const eventDesc = encodeURIComponent(data.description || '');

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
                const schedulePerm = await Notifications.getPermissionsAsync();
                if (schedulePerm.status !== 'granted') {
                    const { status } = await Notifications.requestPermissionsAsync();
                    if (status !== 'granted') {
                        success = false;
                        result = 'Notification permission denied';
                        break;
                    }
                }

                const identifier = await Notifications.scheduleNotificationAsync({
                    content: { title: data.title, body: data.message },
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
                const scheduleAtPerm = await Notifications.getPermissionsAsync();
                if (scheduleAtPerm.status !== 'granted') {
                    const { status } = await Notifications.requestPermissionsAsync();
                    if (status !== 'granted') {
                        success = false;
                        result = 'Notification permission denied';
                        break;
                    }
                }

                const identifierAt = await Notifications.scheduleNotificationAsync({
                    content: { title: data.title, body: data.message },
                    trigger: {
                        type: Notifications.SchedulableTriggerInputTypes.DATE,
                        date: new Date(data.timeMs),
                    },
                });
                result = identifierAt;
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
            if (ctx.appId) {
                await db.setStorageItem(ctx.appId, data.key, data.value);
            }
            break;

        case 'STORAGE_REMOVE':
            if (ctx.appId) {
                await db.removeStorageItem(ctx.appId, data.key);
            }
            break;

        case 'STORAGE_CLEAR':
            if (ctx.appId) {
                await db.clearStorageForApp(ctx.appId);
            }
            break;

        // ============= Location Handler =============
        case 'LOCATION_GET_CURRENT_POSITION':
            try {
                const locStatus = await Location.requestForegroundPermissionsAsync();
                if (locStatus.status === 'granted') {
                    const loc = await Location.getCurrentPositionAsync({});
                    result = JSON.stringify(loc);
                } else {
                    result = 'Permission denied';
                    success = false;
                }
            } catch (e) {
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
                    if (data.url) {
                        await Linking.openURL(`mailto:?body=${encodeURIComponent(data.text || '')} ${data.url}`);
                    }
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


        case 'CONTACTS_SEARCH':
            try {
                const searchPerm = await Contacts.requestPermissionsAsync();
                if (searchPerm.status === 'granted') {
                    const { data: allContacts } = await Contacts.getContactsAsync({
                        fields: [Contacts.Fields.Name, Contacts.Fields.PhoneNumbers, Contacts.Fields.Emails],
                    });
                    const query = (data.query || '').toLowerCase();
                    const filtered = allContacts.filter(c =>
                        c.name?.toLowerCase().includes(query) ||
                        c.phoneNumbers?.some(p => p.number?.includes(query)) ||
                        c.emails?.some(e => e.email?.toLowerCase().includes(query))
                    );
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

                    // Fix for "Cannot add contacts to local/SIM" (iOS/Android)
                    let containerId;
                    try {
                        containerId = await Contacts.getDefaultContainerIdAsync();
                    } catch (cError) {
                        console.warn('Could not get default container ID', cError);
                    }

                    const contactId = await Contacts.addContactAsync(newContact, containerId);
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

        case 'CONTACTS_UPDATE':
            try {
                const updatePerm = await Contacts.requestPermissionsAsync();
                if (updatePerm.status === 'granted') {
                    const contact = data.contact || {};
                    if (!contact.id) {
                        throw new Error('Contact ID is required for update');
                    }
                    const resultId = await Contacts.updateContactAsync(contact);
                    result = resultId;
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


        case 'AUTH_AUTHENTICATE':
            try {
                // Check availability internally
                const hasHardware = await LocalAuthentication.hasHardwareAsync();
                const isEnrolled = await LocalAuthentication.isEnrolledAsync();

                if (!hasHardware || !isEnrolled) {
                    throw new Error(t('biometricsNotAvailable') || 'Biometric authentication not available');
                }

                const authResult = await LocalAuthentication.authenticateAsync({
                    promptMessage: data.reason || t('confirmIdentity'),
                    fallbackLabel: t('usePassword'),
                    disableDeviceFallback: false,
                });
                result = JSON.stringify(authResult);
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'AUTH_OPEN_URL':
            try {
                // Open auth URL in browser and return the redirect result
                const redirectUri = data.redirectUrl || AuthSession.makeRedirectUri();
                const authUrl = data.authUrl.includes('redirect_uri=')
                    ? data.authUrl
                    : `${data.authUrl}${data.authUrl.includes('?') ? '&' : '?'}redirect_uri=${encodeURIComponent(redirectUri)}`;
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
                    if (ctx.webViewRef.current && data.callbackName) {
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
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
                    if (ctx.webViewRef.current && data.callbackName) {
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
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
                    if (ctx.webViewRef.current && data.callbackName) {
                        const { x, y } = sensorData;
                        let heading = Math.atan2(y, x) * (180 / Math.PI);
                        if (heading < 0) heading += 360;
                        const dataWithHeading = { ...sensorData, heading };
                        const script = createCallbackScript(data.callbackName, true, JSON.stringify(dataWithHeading));
                        ctx.webViewRef.current.injectJavaScript(script);
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
            // Message type not handled by shared module
            return { success: false, result: '', handled: false };
    }

    return { success, result, handled: true };
}
