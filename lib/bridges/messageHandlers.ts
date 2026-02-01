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
                const errorMsg = e instanceof Error ? e.message : 'Error';

                // Check if error is mana-related
                const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                    errorMsg.toLowerCase().includes('insufficient mana');

                if (isManaError) {
                    // Open mana shop
                    useManaStore.getState().openShop();
                    result = t('manaDepletedMessage');
                } else {
                    result = errorMsg;
                }
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

        case 'CALENDAR_GET_EVENTS':
            try {
                const { status } = await Calendar.requestCalendarPermissionsAsync();
                if (status !== 'granted') {
                    success = false;
                    result = t('accessDenied') || 'Permission denied';
                    break;
                }

                const calendars = await Calendar.getCalendarsAsync(Calendar.EntityTypes.EVENT);
                const calendarIds = calendars.map(c => c.id);

                // Create lookup map for calendar names
                const calendarMap = new Map(calendars.map(c => [c.id, c.title]));

                if (calendarIds.length === 0) {
                    result = JSON.stringify([]);
                    break;
                }

                // Default range: 24h if not provided
                const startDate = data.startTimeMs ? new Date(data.startTimeMs) : new Date();
                const endDate = data.endTimeMs ? new Date(data.endTimeMs) : new Date(Date.now() + 24 * 60 * 60 * 1000);

                const events = await Calendar.getEventsAsync(calendarIds, startDate, endDate);

                // Build detailed events with attendees
                const detailedEvents = await Promise.all(events.map(async (e) => {
                    // Get attendees for this event
                    let attendees: { name?: string; email?: string; status?: string; isCurrentUser?: boolean }[] = [];
                    try {
                        const rawAttendees = await Calendar.getAttendeesForEventAsync(e.id);
                        attendees = rawAttendees.map(a => ({
                            name: a.name,
                            email: a.email,
                            status: a.status,
                            isCurrentUser: a.isCurrentUser
                        }));
                    } catch {
                        // Some events may not support attendees
                    }

                    return {
                        id: e.id,
                        title: e.title,
                        startDate: e.startDate,
                        endDate: e.endDate,
                        allDay: e.allDay,
                        location: e.location,
                        notes: e.notes,
                        calendarId: e.calendarId,
                        calendarName: calendarMap.get(e.calendarId) || 'Unknown',
                        attendees
                    };
                }));

                result = JSON.stringify(detailedEvents);
            } catch (e) {
                console.error('Calendar get events error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading calendar';
            }
            break;

        case 'CALENDAR_HAS_PERMISSION':
            const calPerm = await Calendar.getCalendarPermissionsAsync();
            result = (calPerm.status === 'granted').toString();
            break;

        case 'CALENDAR_DELETE_EVENT':
            try {
                const { status } = await Calendar.requestCalendarPermissionsAsync();
                if (status !== 'granted') {
                    success = false;
                    result = t('accessDenied') || 'Permission denied';
                    break;
                }

                await Calendar.deleteEventAsync(data.eventId);
                result = 'Event deleted';
            } catch (e) {
                console.error('Calendar delete event error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error deleting event';
            }
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
                const { Share } = require('react-native');
                const shareContent: { message?: string; url?: string; title?: string } = {};

                if (data.text) {
                    shareContent.message = data.text;
                }
                if (data.url) {
                    shareContent.url = data.url;
                }

                const shareResult = await Share.share(shareContent);
                result = shareResult.action === Share.sharedAction ? 'Shared' : 'Dismissed';
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
                        fields: [
                            Contacts.Fields.Name,
                            Contacts.Fields.FirstName,
                            Contacts.Fields.LastName,
                            Contacts.Fields.PhoneNumbers,
                            Contacts.Fields.Emails,
                            Contacts.Fields.Company,
                            Contacts.Fields.JobTitle,
                            Contacts.Fields.Department,
                            Contacts.Fields.Note,
                            Contacts.Fields.UrlAddresses,
                            Contacts.Fields.Birthday,
                            Contacts.Fields.Addresses,
                            Contacts.Fields.Nickname,
                        ],
                    });
                    const query = (data.query || '').toLowerCase();

                    const filtered = allContacts.filter(c => {
                        if (!query) return true;
                        return (
                            c.name?.toLowerCase().includes(query) ||
                            c.firstName?.toLowerCase().includes(query) ||
                            c.lastName?.toLowerCase().includes(query) ||
                            c.phoneNumbers?.some(p => p.number?.includes(query)) ||
                            c.emails?.some(e => e.email?.toLowerCase().includes(query)) ||
                            c.company?.toLowerCase().includes(query)
                        );
                    });

                    // Return native structure directly (slice to 50 max)
                    // The AI prompt will be updated to understand this native schema (arrays for phones, emails, etc.)
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

                    // Build contact object for native form directly from native schema
                    const newContact: Partial<Contacts.Contact> = {
                        contactType: Contacts.ContactTypes.Person,
                        firstName: String(contact.firstName || ''),
                        lastName: String(contact.lastName || ''),
                        middleName: String(contact.middleName || ''),
                        name: String(contact.name || [contact.firstName, contact.lastName].filter(Boolean).join(' ') || ''),
                        company: String(contact.company || ''),
                        jobTitle: String(contact.jobTitle || ''),
                        department: String(contact.department || ''),
                        nickname: String(contact.nickname || ''),
                        note: String(contact.note || ''),
                    };

                    // Arrays - generic pass-through if they match schema
                    if (Array.isArray(contact.phoneNumbers)) newContact.phoneNumbers = contact.phoneNumbers;
                    if (Array.isArray(contact.emails)) newContact.emails = contact.emails;
                    if (Array.isArray(contact.addresses)) newContact.addresses = contact.addresses;
                    if (Array.isArray(contact.urlAddresses)) newContact.urlAddresses = contact.urlAddresses;

                    // Handle birthday
                    if (contact.birthday) {
                        if (typeof contact.birthday === 'object') {
                            newContact.birthday = {
                                year: Number(contact.birthday.year),
                                month: Number(contact.birthday.month), // 0-indexed in JS/Expo usually
                                day: Number(contact.birthday.day)
                            };
                        }
                    }

                    await Contacts.presentFormAsync(null, newContact as Contacts.Contact, { isNew: true });
                    result = 'Contact form presented';
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
                    const contactData = data.contact || {};

                    if (!contactData.id) {
                        throw new Error('Contact ID is required for update');
                    }

                    // Build update payload - map top level fields
                    const updatePayload: Record<string, any> = {
                        id: String(contactData.id)
                    };

                    const stringFields = ['firstName', 'lastName', 'middleName', 'company', 'jobTitle', 'department', 'nickname', 'note'];
                    stringFields.forEach(field => {
                        if (contactData[field] !== undefined) updatePayload[field] = String(contactData[field]);
                    });

                    // Arrays
                    if (Array.isArray(contactData.phoneNumbers)) updatePayload.phoneNumbers = contactData.phoneNumbers;
                    if (Array.isArray(contactData.emails)) updatePayload.emails = contactData.emails;
                    if (Array.isArray(contactData.addresses)) updatePayload.addresses = contactData.addresses;
                    if (Array.isArray(contactData.urlAddresses)) updatePayload.urlAddresses = contactData.urlAddresses;

                    // Birthday
                    if (contactData.birthday && typeof contactData.birthday === 'object') {
                        updatePayload.birthday = contactData.birthday;
                    }

                    try {
                        const resultId = await Contacts.updateContactAsync(updatePayload as any);
                        result = resultId;
                    } catch (updateError: any) {
                        // Fallback: clipboard + native editor
                        const clipboardParts: string[] = [];

                        const fullName = [updatePayload.firstName, updatePayload.lastName].filter(Boolean).join(' ');
                        if (fullName) clipboardParts.push(`Nome: ${fullName}`);

                        // Arrays
                        if (updatePayload.phoneNumbers?.length) {
                            updatePayload.phoneNumbers.forEach((p: any) => clipboardParts.push(`Tel: ${p.number}`));
                        }
                        if (updatePayload.emails?.length) {
                            updatePayload.emails.forEach((e: any) => clipboardParts.push(`Email: ${e.email}`));
                        }
                        if (updatePayload.addresses?.length) {
                            updatePayload.addresses.forEach((a: any) => {
                                const addrStr = [a.street, a.city, a.region, a.postalCode, a.country].filter(Boolean).join(', ');
                                clipboardParts.push(`Endereço: ${addrStr}`);
                            });
                        }

                        // Work info
                        if (updatePayload.company) clipboardParts.push(`Empresa: ${updatePayload.company}`);
                        if (updatePayload.jobTitle) clipboardParts.push(`Cargo: ${updatePayload.jobTitle}`);

                        const clipboardText = clipboardParts.join('\n');
                        const { Clipboard, Alert } = require('react-native');
                        if (clipboardText) Clipboard.setString(clipboardText);

                        await new Promise<void>((resolve) => {
                            Alert.alert('Dados copiados', 'As informações foram copiadas. Cole no editor.', [{ text: 'OK', onPress: () => resolve() }]);
                        });

                        await Contacts.presentFormAsync(String(contactData.id), null, { allowsEditing: true });
                        result = contactData.id;
                    }
                } else {
                    success = false;
                    result = 'Contacts permission denied';
                }
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
