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
import * as Speech from 'expo-speech';
import * as Print from 'expo-print';
import * as ImagePicker from 'expo-image-picker';
import { Audio } from 'expo-av';
import { useBridgeUIStore } from '../bridgeUIStore';
import { Vibration } from 'react-native';
import { Accelerometer, Gyroscope, Magnetometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';

// State for Audio Recording
let currentRecording: Audio.Recording | null = null;
import {
    initialize as initHealthConnect,
    requestPermission,
    readRecords,
    aggregateRecord,
    getGrantedPermissions,
    getSdkStatus,
    SdkAvailabilityStatus
} from 'react-native-health-connect';
import { WebView } from 'react-native-webview';
import * as ai from '../api/ai';

import * as db from '../database/db';
import { createCallbackScript } from './injectedJS';
import { t } from '../i18n';
import { useManaStore } from '../manaStore';
import { useAppStore } from '../store';
import { updateStorageCache, removeFromStorageCache } from '../storageCache';

// ============= Notification Limits (Native Protection) =============
const MAX_NOTIFICATIONS_PER_SPELL = 10;

/**
 * Get all scheduled notifications for a specific spell
 */
async function getSpellNotifications(appId: number | null) {
    if (!appId) return [];
    const all = await Notifications.getAllScheduledNotificationsAsync();
    return all.filter(n =>
        (n.content as any).channelId === `spell-${appId}` ||
        n.content.data?.appId === appId
    );
}

/**
 * Cancel duplicate notification (same title + body) for a spell
 */
async function cancelDuplicateNotification(appId: number | null, title: string, body: string) {
    const existing = await getSpellNotifications(appId);
    for (const n of existing) {
        if (n.content.title === title && n.content.body === body) {
            await Notifications.cancelScheduledNotificationAsync(n.identifier);
            return true; // Cancelled a duplicate
        }
    }
    return false;
}

/**
 * Check if spell has reached notification limit
 */
async function isAtNotificationLimit(appId: number | null): Promise<boolean> {
    const existing = await getSpellNotifications(appId);
    return existing.length >= MAX_NOTIFICATIONS_PER_SPELL;
}

// Singleton promise to prevent parallel permission requests
let healthInitPromise: Promise<{ ok: boolean; error?: string }> | null = null;

// Helper to ensure Health Connect is ready and has permissions
async function ensureHealthAccess(): Promise<{ ok: boolean; error?: string }> {
    if (healthInitPromise) {
        return healthInitPromise;
    }

    healthInitPromise = (async () => {
        try {
            const sdkStatus = await getSdkStatus();
            if (sdkStatus !== SdkAvailabilityStatus.SDK_AVAILABLE) {
                return { ok: false, error: 'Health Connect not available on this device' };
            }

            const initialized = await initHealthConnect();
            if (!initialized) {
                return { ok: false, error: 'Failed to initialize Health Connect' };
            }

            const permissions = [
                { accessType: 'read', recordType: 'Steps' },
                { accessType: 'read', recordType: 'HeartRate' },
                { accessType: 'read', recordType: 'ExerciseSession' },
                { accessType: 'read', recordType: 'SleepSession' },
                { accessType: 'read', recordType: 'Distance' },
                { accessType: 'read', recordType: 'ActiveCaloriesBurned' },
            ];

            // Optimize: Check if we already have these permissions
            const granted = await getGrantedPermissions();
            const missing = permissions.filter(p =>
                !granted.some(g => g.recordType === p.recordType && g.accessType === p.accessType)
            );

            if (missing.length > 0) {
                // Only request if something is missing
                await requestPermission(permissions as any);
            }

            return { ok: true };
        } catch (e: any) {
            console.error('Health Access Error:', e);
            return { ok: false, error: e.message || 'Health Access Error' };
        }
    })();

    // Clear promise after 5 seconds to allow retries later if needed
    healthInitPromise.finally(() => {
        setTimeout(() => { healthInitPromise = null; }, 5000);
    });

    return healthInitPromise;
}

export interface HandlerContext {
    webViewRef: React.RefObject<WebView>;
    viewContainerRef?: React.RefObject<any>; // Useful for screen capture
    appId: number | null;
    callbackName?: string; // Callback name from the message wrapper
}

export interface HandlerResult {
    success: boolean;
    result: string;
    handled: boolean;  // false if message type was not recognized
    deferredCallback?: boolean;
}

/**
 * Handle a WebView bridge message.
 * Returns { handled: false } if the message type is not recognized,
 * allowing the caller to handle it locally.
 */
// Map numeric sleep stages to prompt-compatible strings
const mapSleepStage = (stage: number): string => {
    switch (stage) {
        case 1: return 'AWAKE'; // AWAKE
        case 2: return 'LIGHT'; // SLEEPING (Generic) -> Map to Light as fallback
        case 3: return 'AWAKE'; // OUT_OF_BED -> Map to Awake
        case 4: return 'LIGHT'; // LIGHT
        case 5: return 'DEEP'; // DEEP
        case 6: return 'REM'; // REM
        default: return 'UNKNOWN';
    }
};

export async function handleBridgeMessage(
    type: string,
    data: any,
    ctx: HandlerContext & { callbackName?: string }
): Promise<HandlerResult> {
    let success = true;
    let result = '';

    // Helper to log to both native console and WebView console
    const debugLog = (msg: string) => {
        const prefix = '[Native Bridge]';
        const fullMsg = `${prefix} ${msg}`;
        if (ctx.webViewRef.current) {
            // Use JSON.stringify to safely escape the string for JS execution
            ctx.webViewRef.current.injectJavaScript(`console.log(${JSON.stringify(fullMsg)}); true;`);
        }
        console.log(fullMsg);
    };

    switch (type) {
        case 'AI_GENERATE':
            debugLog(`AI Generate request: ${data.prompt?.substring(0, 50)}...`);
            try {
                const genResult = await ai.aiGenerate({
                    prompt: data.prompt,
                    search: data.search,
                    schema: data.schema,
                    image: data.image,
                    audio: data.audio,
                });
                result = genResult.text;

                // Log cost and update app's totalManaCost
                const creditsUsed = genResult.creditsUsed || 0;
                console.log(`[Bridge] AI generated. Credits used: ${creditsUsed}`);

                // Update App Total Mana Cost atomically
                if (ctx.appId && creditsUsed > 0) {
                    try {
                        await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                        debugLog(`App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                    } catch (e) {
                        console.warn('Failed to update app mana cost:', e);
                    }
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
            debugLog(`Calendar create event: ${data.title}`);
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
            debugLog(`Calendar get events request`);
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

                debugLog(`Found ${detailedEvents.length} events`);
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
            debugLog(`Calendar delete event: ${data.eventId}`);
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
            debugLog(`Notify show now: ${data.title}`);
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

                // Cancel existing if id provided (upsert behavior)
                if (data.id) {
                    try { await Notifications.cancelScheduledNotificationAsync(data.id); } catch { }
                }

                await Notifications.scheduleNotificationAsync({
                    identifier: data.id || undefined,
                    content: {
                        title: data.title,
                        body: data.message,
                        data: { appId: ctx.appId },
                        channelId: `spell-${ctx.appId}`,
                    } as any,
                    trigger: null,
                });
                result = data.id || 'Notification sent';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_SCHEDULE':
            debugLog(`Notify schedule: ${data.title} in ${data.delayMinutes}min`);
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

                // Native protection: auto-dedupe identical title+body
                await cancelDuplicateNotification(ctx.appId, data.title, data.message);

                // Native protection: check limit (unless upsert with existing id)
                if (!data.id && await isAtNotificationLimit(ctx.appId)) {
                    success = false;
                    result = `Limit reached (max ${MAX_NOTIFICATIONS_PER_SPELL} notifications per spell)`;
                    break;
                }

                // Cancel existing if id provided (upsert behavior)
                if (data.id) {
                    try { await Notifications.cancelScheduledNotificationAsync(data.id); } catch { }
                }

                const identifier = await Notifications.scheduleNotificationAsync({
                    identifier: data.id || undefined,
                    content: {
                        title: data.title,
                        body: data.message,
                        data: { appId: ctx.appId },
                        channelId: `spell-${ctx.appId}`,
                    } as any,
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
            debugLog(`Notify schedule at: ${data.title} at ${new Date(data.timeMs).toISOString()}`);
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

                // Native protection: auto-dedupe identical title+body
                await cancelDuplicateNotification(ctx.appId, data.title, data.message);

                // Native protection: check limit (unless upsert with existing id)
                if (!data.id && await isAtNotificationLimit(ctx.appId)) {
                    success = false;
                    result = `Limit reached (max ${MAX_NOTIFICATIONS_PER_SPELL} notifications per spell)`;
                    break;
                }

                // Cancel existing if id provided (upsert behavior)
                if (data.id) {
                    try { await Notifications.cancelScheduledNotificationAsync(data.id); } catch { }
                }

                const identifierAt = await Notifications.scheduleNotificationAsync({
                    identifier: data.id || undefined,
                    content: {
                        title: data.title,
                        body: data.message,
                        data: { appId: ctx.appId },
                        channelId: `spell-${ctx.appId}`,
                    } as any,
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

        case 'NOTIFY_GET_SCHEDULED':
            debugLog(`Notify get scheduled request`);
            // Get all scheduled notifications for this spell
            try {
                const allScheduled = await Notifications.getAllScheduledNotificationsAsync();
                // Filter to only this spell's notifications (by channelId or data.appId)
                const spellNotifications = allScheduled.filter(n =>
                    (n.content as any).channelId === `spell-${ctx.appId}` ||
                    n.content.data?.appId === ctx.appId
                );
                result = JSON.stringify(spellNotifications.map(n => ({
                    id: n.identifier,
                    title: n.content.title,
                    body: n.content.body,
                    trigger: n.trigger
                })));
                debugLog(`Found ${spellNotifications.length} scheduled notifications`);
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_CANCEL':
            debugLog(`Notify cancel: ${data.id}`);
            // Cancel a specific notification by ID
            try {
                await Notifications.cancelScheduledNotificationAsync(data.id);
                result = 'Notification cancelled';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'NOTIFY_CANCEL_ALL':
            debugLog(`Notify cancel all`);
            // Cancel all notifications for this spell
            try {
                const allToCancel = await Notifications.getAllScheduledNotificationsAsync();
                const spellToCancel = allToCancel.filter(n =>
                    (n.content as any).channelId === `spell-${ctx.appId}` ||
                    n.content.data?.appId === ctx.appId
                );
                for (const n of spellToCancel) {
                    await Notifications.cancelScheduledNotificationAsync(n.identifier);
                }
                result = `Cancelled ${spellToCancel.length} notifications`;
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Storage Handlers =============
        case 'STORAGE_SET':
            debugLog(`Storage set: ${data.key}`);
            if (ctx.appId) {
                await db.setStorageItem(ctx.appId, data.key, data.value);
                // Keep cache in sync so returning from background doesn't overwrite new data
                updateStorageCache(ctx.appId, data.key, data.value);
            }
            break;

        case 'STORAGE_REMOVE':
            debugLog(`Storage remove: ${data.key}`);
            if (ctx.appId) {
                await db.removeStorageItem(ctx.appId, data.key);
                // Keep cache in sync so returning from background doesn't overwrite new data
                removeFromStorageCache(ctx.appId, data.key);
            }
            break;

        case 'STORAGE_CLEAR':
            debugLog(`Storage clear`);
            if (ctx.appId) {
                await db.clearStorageForApp(ctx.appId);
            }
            break;

        // ============= Location Handler =============
        case 'LOCATION_GET_CURRENT_POSITION':
            debugLog(`Location get current position`);
            try {
                const locStatus = await Location.requestForegroundPermissionsAsync();
                if (locStatus.status === 'granted') {
                    const loc = await Location.getCurrentPositionAsync({});
                    debugLog(`Location found: ${loc.coords.latitude}, ${loc.coords.longitude}`);
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
            debugLog(`Share content request`);
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
            debugLog(`Share file: ${data.filename}`);
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
            debugLog(`Contacts search: ${data.query}`);
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
                    debugLog(`Found ${filtered.length} contacts`);
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
            debugLog(`Contacts add request`);
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
            debugLog(`Contacts update request: ${data.contact?.id}`);
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
            debugLog(`Sensors start accelerometer: ${data.intervalMs}ms`);
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
            debugLog(`Sensors start gyroscope: ${data.intervalMs}ms`);
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
            debugLog(`Sensors start magnetometer: ${data.intervalMs}ms`);
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

        // ============= Health Connect Handlers =============
        case 'HEALTH_INITIALIZE':
            // Optimization: Initialization is now lazy. We return success immediately
            // so the web app can proceed, but we don't trigger permissions here.
            result = 'Health Connect initialized';
            break;

        case 'HEALTH_GET_STEPS':
            try {
                const access = await ensureHealthAccess();
                if (!access.ok) {
                    success = false;
                    result = access.error || 'Health Access Denied';
                    break;
                }
                const stepsStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                const stepsEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                debugLog(`Querying Steps from ${stepsStart.toISOString()} to ${stepsEnd.toISOString()}`);

                // Parallel fetch: Aggregation (for accurate total) and Records (for details)
                const [stepsRecords, stepsAgg] = await Promise.all([
                    readRecords('Steps', {
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: stepsStart.toISOString(),
                            endTime: stepsEnd.toISOString()
                        }
                    }),
                    aggregateRecord({
                        recordType: 'Steps',
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: stepsStart.toISOString(),
                            endTime: stepsEnd.toISOString()
                        }
                    })
                ]);


                //debugLog(`Aggregation Result: ${JSON.stringify(stepsAgg)}`);
                // Use COUNT_TOTAL from native result, fallback to count/total or manual sum
                const totalSteps = (stepsAgg as any).COUNT_TOTAL || (stepsAgg as any).count || (stepsAgg as any).total || stepsRecords.records.reduce((sum: number, r: { count?: number }) => sum + (r.count || 0), 0) || 0;

                debugLog(`Found total steps: ${totalSteps}`);
                result = JSON.stringify({ totalSteps, records: stepsRecords.records });
            } catch (e) {
                console.error('Health get steps error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading steps';
            }
            break;

        case 'HEALTH_GET_HEART_RATE':
            try {
                const access = await ensureHealthAccess();
                if (!access.ok) {
                    success = false;
                    result = access.error || 'Health Access Denied';
                    break;
                }
                const hrStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                const hrEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                debugLog(`Querying HeartRate from ${hrStart.toISOString()} to ${hrEnd.toISOString()}`);

                const hrRecords = await readRecords('HeartRate', {
                    timeRangeFilter: {
                        operator: 'between',
                        startTime: hrStart.toISOString(),
                        endTime: hrEnd.toISOString()
                    }
                });

                debugLog(`Found ${hrRecords.records.length} heart rate records.`);
                result = JSON.stringify(hrRecords.records);
            } catch (e) {
                console.error('Health get heart rate error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading heart rate';
            }
            break;

        case 'HEALTH_GET_EXERCISE':
            try {
                const access = await ensureHealthAccess();
                if (!access.ok) {
                    success = false;
                    result = access.error || 'Health Access Denied';
                    break;
                }
                const exStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                const exEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                debugLog(`Querying ExerciseSession from ${exStart.toISOString()} to ${exEnd.toISOString()}`);

                const exRecords = await readRecords('ExerciseSession', {
                    timeRangeFilter: {
                        operator: 'between',
                        startTime: exStart.toISOString(),
                        endTime: exEnd.toISOString()
                    }
                });

                debugLog(`Found ${exRecords.records.length} records.`);
                if (exRecords.records.length > 0) {
                    debugLog(`First record: ${JSON.stringify(exRecords.records[0])}`);
                }

                // Map exercise type numbers to readable names
                const exerciseTypeNames: Record<number, string> = {
                    0: 'OTHER', 8: 'BIKING', 16: 'DANCING', 32: 'GOLF', 36: 'HIIT',
                    37: 'HIKING', 44: 'MARTIAL_ARTS', 46: 'ROWING', 48: 'PILATES', 51: 'ROCK_CLIMBING',
                    53: 'ROWING', 56: 'RUNNING', 64: 'SOCCER', 68: 'STAIR_CLIMBING',
                    70: 'STRENGTH_TRAINING', 71: 'STRETCHING', 73: 'SWIMMING',
                    76: 'TENNIS', 79: 'WALKING', 81: 'WEIGHTLIFTING', 83: 'YOGA'
                };

                const enrichedRecords = exRecords.records.map((r: { exerciseType?: number; startTime?: string; endTime?: string; title?: string; notes?: string }) => ({
                    ...r,
                    exerciseTypeName: exerciseTypeNames[r.exerciseType || 0] || 'OTHER'
                }));

                result = JSON.stringify(enrichedRecords);
            } catch (e) {
                console.error('Health get exercise error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading exercise';
            }
            break;

        case 'HEALTH_GET_SLEEP':
            try {
                const access = await ensureHealthAccess();
                if (!access.ok) {
                    success = false;
                    result = access.error || 'Health Access Denied';
                    break;
                }
                const sleepStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
                const sleepEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                debugLog(`Querying SleepSession from ${sleepStart.toISOString()} to ${sleepEnd.toISOString()}`);

                const sleepRecords = await readRecords('SleepSession', {
                    timeRangeFilter: {
                        operator: 'between',
                        startTime: sleepStart.toISOString(),
                        endTime: sleepEnd.toISOString()
                    }
                });

                debugLog(`Found ${sleepRecords.records.length} sleep records.`);

                // Map records to match prompt contract (convert numeric stages to strings)
                const mappedRecords = sleepRecords.records.map((r: any) => {
                    const stages = r.stages?.map((s: any) => ({
                        startTime: s.startTime,
                        endTime: s.endTime,
                        stage: mapSleepStage(s.stage)
                    })) || [];

                    // Log first session's stages for debugging
                    if (r === sleepRecords.records[0]) {
                        debugLog(`First session stages count: ${stages.length}`);
                        if (stages.length > 0) debugLog(`First stage: ${JSON.stringify(stages[0])}`);
                    }

                    return {
                        startTime: r.startTime,
                        endTime: r.endTime,
                        title: r.title,
                        notes: r.notes,
                        stages: stages
                    };
                });

                result = JSON.stringify(mappedRecords);
            } catch (e) {
                console.error('Health get sleep error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading sleep';
            }
            break;

        // ============= Text-to-Speech Handlers =============
        case 'TTS_SPEAK': {
            try {
                const { text, language, pitch, rate, volume } = data;
                if (!text) {
                    success = false;
                    result = 'Text is required';
                    break;
                }
                const options: Speech.SpeechOptions = {};
                if (language) options.language = language;
                if (pitch !== undefined) options.pitch = pitch;
                if (rate !== undefined) options.rate = rate;
                if (volume !== undefined) options.volume = volume;
                options.onDone = () => {
                    debugLog('TTS finished speaking');
                };
                Speech.speak(text, options);
                result = 'Speaking';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'TTS Error';
            }
            break;
        }

        case 'TTS_STOP': {
            try {
                Speech.stop();
                result = 'Stopped';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'TTS Stop Error';
            }
            break;
        }

        case 'TTS_IS_SPEAKING': {
            try {
                const speaking = await Speech.isSpeakingAsync();
                result = speaking ? 'true' : 'false';
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'TTS Error';
            }
            break;
        }

        // ============= AI Image Generation Handler =============
        case 'AI_GENERATE_IMAGE': {
            debugLog(`AI Image Gen request: ${data.prompt?.substring(0, 50)}...`);
            try {
                const imgResult = await ai.aiGenerateImage(data.prompt);
                result = imgResult.imageBase64;

                // Log cost and update mana
                const creditsUsed = imgResult.creditsUsed || 0;
                console.log(`[Bridge] AI image generated. Credits used: ${creditsUsed}`);

                if (ctx.appId && creditsUsed > 0) {
                    try {
                        await useAppStore.getState().incrementAppManaCost(ctx.appId, creditsUsed);
                        debugLog(`App ${ctx.appId} mana cost increased by ${creditsUsed}`);
                    } catch (e) {
                        console.warn('Failed to update app mana cost:', e);
                    }
                }
            } catch (e) {
                success = false;
                const errorMsg = e instanceof Error ? e.message : 'Error';

                const isManaError = errorMsg.toLowerCase().includes('insufficient credits') ||
                    errorMsg.toLowerCase().includes('insufficient mana');

                if (isManaError) {
                    useManaStore.getState().openShop();
                    result = t('manaDepletedMessage');
                } else {
                    result = errorMsg;
                }
            }
            break;
        }

        // ============= Vibration Handler =============
        case 'VIBRATE': {
            const pattern = data.pattern !== undefined ? data.pattern : 400;
            console.log(`[Native Bridge] VIBRATE command received. Input: ${JSON.stringify(pattern)}`);

            try {
                // Cancel any previous vibration to ensure a clean slate
                Vibration.cancel();

                if (Array.isArray(pattern)) {
                    // ARRAY PATTERN
                    // Android supports patterns natively: [0, vibrate, wait, vibrate, ...]
                    // iOS does not support patterns natively -> use manual loop or fallback

                    // Using require here to avoid top-level import issues if platform specific
                    const { Platform } = require('react-native');

                    if (Platform.OS === 'android') {
                        // Native Android Pattern
                        // Prepend 0 to start immediately if the first element is duration
                        // Web/User pattern: [vibrate, wait, vibrate, wait...]
                        // Android pattern: [wait, vibrate, wait, vibrate...]
                        const androidPattern = [0, ...pattern];
                        console.log(`[Native Bridge] Android Native Pattern: ${JSON.stringify(androidPattern)}`);
                        Vibration.vibrate(androidPattern);
                    } else {
                        // iOS / Other - Manual Loop
                        // Note: iOS Vibration.vibrate() ignores duration and pattern (fixed 400ms)
                        // So we use Haptics for short durations or just best effort
                        console.log(`[Native Bridge] Manual pattern execution (iOS/Other)`);

                        let currentTime = 0;
                        for (let i = 0; i < pattern.length; i++) {
                            const duration = pattern[i];
                            const triggerTime = currentTime;

                            if (i % 2 === 0) {
                                // VIBRATE
                                if (duration > 0) {
                                    setTimeout(() => {
                                        console.log(`[Native Bridge] Manual Vibrate: ${duration}ms`);
                                        // On iOS, vibrate() is fixed length, so we rely more on Haptics for short bursts
                                        if (duration < 1000) {
                                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => { });
                                            // Fallback to standar vibrate if very long?
                                        } else {
                                            Vibration.vibrate();
                                        }
                                    }, triggerTime);
                                }
                            }
                            currentTime += duration;
                        }
                    }

                } else if (typeof pattern === 'number') {
                    // SINGLE DURATION
                    console.log(`[Native Bridge] Single Vibrate: ${pattern}ms`);
                    if (pattern > 0) {
                        Vibration.vibrate(pattern);
                    }
                    // Safety/Enhancement haptic for short bursts
                    if (pattern <= 100) {
                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)
                            .catch(e => console.error('[Native Bridge] Haptics error:', e));
                    }
                }

                result = 'Vibrated';
            } catch (e) {
                console.error('[Native Bridge] Vibration failed:', e);
                success = false;
                result = String(e);
            }
            break;
        }

        // ============= Screen Capture Handler =============
        case 'SCREEN_CAPTURE':
            debugLog('Capturing screen...');
            // First choice: viewContainerRef (usually more reliable for capturing WebView content on Android)
            // Second choice: webViewRef
            const captureTarget = (ctx.viewContainerRef && ctx.viewContainerRef.current)
                ? ctx.viewContainerRef.current
                : (ctx.webViewRef && ctx.webViewRef.current ? ctx.webViewRef.current : null);

            if (captureTarget) {
                try {
                    const { captureRef } = require('react-native-view-shot');
                    const uri = await captureRef(captureTarget, {
                        format: 'png',
                        quality: 0.8,
                        result: 'base64'
                    });
                    result = uri.replace(/(\r\n|\n|\r)/gm, "");
                } catch (e) {
                    success = false;
                    result = e instanceof Error ? e.message : 'Screen capture failed';
                }
            } else {
                success = false;
                result = 'Capture target not available';
            }
            break;

        // ============= Print Handler =============
        case 'PRINT': {
            debugLog('Requesting print dialog...');
            try {
                if (data.html) {
                    await Print.printAsync({
                        html: data.html
                    });
                    result = 'Print dialog opened';
                } else {
                    success = false;
                    result = 'No content to print';
                }
            } catch (e) {
                console.error('Print error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Print failed';
            }
            break;
        }

        // ============= Camera/Multimedia Handler =============
        case 'CAMERA_TAKE_PHOTO': {
            debugLog('Taking photo...');
            try {
                const permission = await ImagePicker.requestCameraPermissionsAsync();
                if (!permission.granted) throw new Error('Camera permission denied');

                const resultPicker = await ImagePicker.launchCameraAsync({
                    mediaTypes: ImagePicker.MediaTypeOptions.Images,
                    base64: true,
                    quality: 0.8,
                });

                if (!resultPicker.canceled && resultPicker.assets[0].base64) {
                    result = resultPicker.assets[0].base64;
                } else {
                    success = false;
                    result = 'Cancelled';
                }
            } catch (e) {
                console.error('Camera error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Camera failed';
            }
            break;
        }

        // ============= QR Scanner Handler =============
        case 'SCANNER_SCAN': {
            debugLog('Opening QR scanner...');
            // Support both direct data.callback and wrapper's callbackName
            const callbackName = data.callback || ctx.callbackName;

            // Open scanner via store
            useBridgeUIStore.getState().openScanner(callbackName);

            // Result is technically "Scanner opened", but we defer the callback
            // so the webview doesn't receive this string as the scan result.
            // The actual result will be injected by QRScannerOverlay.
            result = 'Scanner opened';
            return { success: true, result, handled: true, deferredCallback: true };
        }

        case 'AUDIO_RECORD_START': {
            debugLog('Starting audio recording...');
            try {
                const perm = await Audio.requestPermissionsAsync();
                if (!perm.granted) throw new Error('Audio permission denied');

                await Audio.setAudioModeAsync({ allowsRecordingIOS: true, playsInSilentModeIOS: true });
                if (currentRecording) { await currentRecording.stopAndUnloadAsync(); currentRecording = null; }

                const { recording } = await Audio.Recording.createAsync(Audio.RecordingOptionsPresets.HIGH_QUALITY);
                currentRecording = recording;
                result = 'Recording started';
            } catch (e) {
                console.error('Audio start error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Audio start failed';
            }
            break;
        }

        case 'AUDIO_RECORD_STOP': {
            debugLog('Stopping audio recording...');
            try {
                if (!currentRecording) throw new Error('No recording active');
                await currentRecording.stopAndUnloadAsync();
                const uri = currentRecording.getURI();
                currentRecording = null;

                if (uri) {
                    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
                    result = base64;
                } else {
                    throw new Error('No recording URI');
                }
            } catch (e) {
                console.error('Audio stop error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Audio stop failed';
            }
            break;
        }

        default:
            // Message type not handled by shared module
            return { success: false, result: '', handled: false };
    }

    return { success, result, handled: true };
}
