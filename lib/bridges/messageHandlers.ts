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
import { Accelerometer, Gyroscope, Magnetometer, Pedometer } from 'expo-sensors';
import * as Haptics from 'expo-haptics';
import * as Battery from 'expo-battery';
import * as Network from 'expo-network';

// State for Audio Recording
let currentRecording: Audio.Recording | null = null;
let audioRecordingTimeout: NodeJS.Timeout | null = null;
let scannerTimeout: NodeJS.Timeout | null = null;
let pedometerSubscription: any | null = null;

// Throttling for high-frequency messages
const messageThrottles: { [key: string]: number } = {};
function shouldLog(type: string, key?: string): boolean {
    const throttleKey = key ? `${type}:${key}` : type;
    if (messageThrottles[throttleKey] === undefined) {
        messageThrottles[throttleKey] = 0;
        return true; // Always log early first event
    }
    messageThrottles[throttleKey]++;
    return messageThrottles[throttleKey] % 50 === 0;
}
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
    try {
        const all = await Notifications.getAllScheduledNotificationsAsync();
        return all.filter(n => {
            const content = n.content as any;
            return content.channelId === `spell-${appId}` ||
                content.data?.appId == appId || // Loose equality to match string/number
                (content.data && content.data.appId && content.data.appId.toString() === appId.toString());
        });
    } catch (e) {
        console.error('Error fetching notifications:', e);
        return [];
    }
}

/**
 * Cancel duplicate notification (same title + body) for a spell
 */
async function cancelDuplicateNotification(appId: number | null, title: string, body: string) {
    console.log(`[Bridge] cancelDuplicateNotification: appId=${appId}, title=${title}`);
    const existing = await getSpellNotifications(appId);
    for (const n of existing) {
        if (n.content.title === title && n.content.body === body) {
            console.log(`[Bridge] Cancelling duplicate notification: ${n.identifier}`);
            await Notifications.cancelScheduledNotificationAsync(n.identifier);
            // Don't return true immediately, let's cancel ALL duplicates just in case
        }
    }
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
                { accessType: 'read', recordType: 'TotalCaloriesBurned' },
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
    let deferredCallback = false;

    // Helper to log to both native console and WebView console
    const debugLog = (msg: string, force = false) => {
        const prefix = '[Native Bridge]';
        const fullMsg = `${prefix} ${msg}`;

        // Log to native console always
        console.log(fullMsg);

        // Conditional log to WebView to avoid flooding (only if forced or first/50th event)
        if (ctx.webViewRef.current) {
            ctx.webViewRef.current.injectJavaScript(`console.log(${JSON.stringify(fullMsg)}); true;`);
        }
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

                const titleStr = typeof data.title === 'string' ? data.title : String(data.title || '');
                const bodyStr = typeof data.message === 'string' ? data.message : String(data.message || t('appName'));
                const appIdStr = ctx.appId ? String(ctx.appId) : '0';
                const channelId = ctx.appId ? `spell-${ctx.appId}` : 'default';

                await Notifications.scheduleNotificationAsync({
                    identifier: (data.id && String(data.id)) || undefined,
                    content: {
                        title: titleStr,
                        body: bodyStr,
                        data: { appId: appIdStr },
                        channelId: channelId,
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
            const scheduleDate = new Date(data.timeMs || Date.now());
            debugLog(`Notify schedule: ${data.title} at ${scheduleDate.toISOString()}`);

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

                // Ensure channel exists (idempotent)
                await Notifications.setNotificationChannelAsync(`spell-${ctx.appId}`, {
                    name: `Spell ${ctx.appId}`,
                    importance: Notifications.AndroidImportance.HIGH,
                    vibrationPattern: [0, 250, 250, 250],
                    lightColor: '#FF9500',
                });

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

                const titleStr = typeof data.title === 'string' ? data.title : String(data.title || '');
                const bodyStr = typeof data.message === 'string' ? data.message : String(data.message || t('appName'));
                const appIdStr = ctx.appId ? String(ctx.appId) : '0';

                // Use minimal delay logic
                const rawDelay = Math.floor((scheduleDate.getTime() - Date.now()) / 1000);
                const secondsDelay = Math.max(1, rawDelay);

                // CHEMICALLY PURE OBJECT RECONSTRUCTION

                const safeTrigger: any = {
                    type: 'timeInterval',
                    seconds: Number(secondsDelay),
                    repeats: false,
                };

                const safeContent: any = {
                    title: String(titleStr),
                    body: String(bodyStr),
                };

                // CRITICAL FIX: The Android scheduler fails to serialize the 'data' JSON object
                // with "NotSerializableException: org.json.JSONObject".
                // We will rely ONLY on channelId to identify the spell.
                if (appIdStr && appIdStr !== '0') {
                    const channelId = 'spell-' + String(appIdStr);

                    // Create the channel first to ensure it exists and persists
                    await Notifications.setNotificationChannelAsync(channelId, {
                        name: data.title || `App ${appIdStr}`,
                        importance: Notifications.AndroidImportance.DEFAULT,
                    });

                    safeContent.channelId = channelId;

                    // FALLBACK STRATEGY: Use 'badge' to store the App ID.
                    // Since 'channelId' is not returning in getAllScheduledNotificationsAsync on Android
                    // and 'data' causes crashes, 'badge' (a primitive number) is our best bet for identification.
                    safeContent.badge = Number(appIdStr);
                }

                const request: any = {
                    content: safeContent,
                    trigger: safeTrigger,
                };

                if (data.id) {
                    request.identifier = String(data.id);
                }

                debugLog(`[Bridge] CLEAN OBJECT ATTEMPT: ${JSON.stringify(request)}`);

                const identifier = await Notifications.scheduleNotificationAsync(request);
                result = identifier;
            } catch (e) {
                console.error('[Bridge] NOTIFY_SCHEDULE Error:', e);
                const errorMessage = e instanceof Error ? e.message : String(e);
                debugLog(`[Bridge] NOTIFY_SCHEDULE FAIL: ${errorMessage}`);
                success = false;
                result = errorMessage;
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
            if (shouldLog('STORAGE_SET', data.key)) {
                debugLog(`Storage set: ${data.key} (Throttled x${messageThrottles['STORAGE_SET:' + data.key] || 0})`);
            }
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

        case 'CONSOLE_LOG':
            if (shouldLog('CONSOLE_LOG')) {
                const count = messageThrottles['CONSOLE_LOG'] || 0;
                debugLog(`Remote console [${data.type}]: ${data.message} (Throttled x${count})`);
            }
            break;

        case 'NETWORK_LOG':
            if (shouldLog('NETWORK_LOG')) {
                const count = messageThrottles['NETWORK_LOG'] || 0;
                debugLog(`Remote network: ${data.method} ${data.url} status: ${data.status} (Throttled x${count})`);
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
                const { Share: RNShare } = require('react-native');
                const shareContent: { message?: string; url?: string; title?: string } = {};

                if (data.text) {
                    shareContent.message = data.text;
                }
                if (data.url) {
                    shareContent.url = data.url;
                }

                const shareResult = await RNShare.share(shareContent);
                result = shareResult.action === RNShare.sharedAction ? 'Shared' : 'Dismissed';
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




        // ============= Sensors (Accelerometer, Gyroscope, Magnetometer, GPS, Pedometer) =============
        case 'SENSORS_START_ACCELEROMETER':
            debugLog(`Sensors start accelerometer: ${data.intervalMs}ms`);
            Accelerometer.removeAllListeners(); // Prevent duplicates
            try {
                if (!await Accelerometer.isAvailableAsync()) throw new Error('Accelerometer not available');

                let accelCount = 0;
                const accelInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                Accelerometer.setUpdateInterval(accelInterval);
                Accelerometer.addListener(sensorData => {
                    accelCount++;
                    if (accelCount === 1 || accelCount % 50 === 0) debugLog(`Native Accelerometer update (x${accelCount})`);
                    if (ctx.webViewRef.current && ctx.callbackName) {
                        const script = createCallbackScript(ctx.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = JSON.stringify({ status: 'started', sensor: 'accelerometer' });
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_START_GYROSCOPE':
            debugLog(`Sensors start gyroscope: ${data.intervalMs}ms`);
            Gyroscope.removeAllListeners(); // Prevent duplicates
            try {
                if (!await Gyroscope.isAvailableAsync()) throw new Error('Gyroscope not available');

                let gyroCount = 0;
                const gyroInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                Gyroscope.setUpdateInterval(gyroInterval);
                Gyroscope.addListener(sensorData => {
                    gyroCount++;
                    if (gyroCount === 1 || gyroCount % 50 === 0) debugLog(`Native Gyroscope update (x${gyroCount})`);
                    if (ctx.webViewRef.current && ctx.callbackName) {
                        const script = createCallbackScript(ctx.callbackName, true, JSON.stringify(sensorData));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = JSON.stringify({ status: 'started', sensor: 'gyroscope' });
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_START_MAGNETOMETER':
            debugLog(`Sensors start magnetometer: ${data.intervalMs}ms`);
            Magnetometer.removeAllListeners(); // Prevent duplicates
            try {
                if (!await Magnetometer.isAvailableAsync()) throw new Error('Magnetometer not available');

                let magCount = 0;
                const magInterval = typeof data.intervalMs === 'number' ? data.intervalMs : parseInt(String(data.intervalMs)) || 100;
                Magnetometer.setUpdateInterval(magInterval);
                Magnetometer.addListener(sensorData => {
                    magCount++;
                    const { x, y } = sensorData;
                    // Traditional Compass Heading: atan2(x, y) 
                    // North is y max, East is x max
                    let heading = Math.atan2(x, y) * (180 / Math.PI);
                    if (heading < 0) heading += 360;
                    const dataWithHeading = { ...sensorData, heading };

                    if (magCount === 1 || magCount % 50 === 0) debugLog(`Native Magnetometer update (x${magCount}) heading: ${Math.round(heading)}`);
                    if (ctx.webViewRef.current && ctx.callbackName) {
                        const script = createCallbackScript(ctx.callbackName, true, JSON.stringify(dataWithHeading));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = JSON.stringify({ status: 'started', sensor: 'magnetometer' });
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_START_PEDOMETER':
            debugLog(`Sensors start pedometer`);
            try {
                if (pedometerSubscription) pedometerSubscription.remove();

                if (!await Pedometer.isAvailableAsync()) throw new Error('Pedometer not available');

                const permissions = await Pedometer.requestPermissionsAsync();
                if (!permissions.granted) throw new Error('Pedometer permission denied');

                pedometerSubscription = Pedometer.watchStepCount(result => {
                    debugLog(`Native Pedometer step: ${result.steps}`);
                    if (ctx.webViewRef.current && ctx.callbackName) {
                        const script = createCallbackScript(ctx.callbackName, true, JSON.stringify(result));
                        ctx.webViewRef.current.injectJavaScript(script);
                    }
                });
                result = JSON.stringify({ status: 'started', sensor: 'pedometer' });
            } catch (e) {
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'SENSORS_STOP_ACCELEROMETER':
            Accelerometer.removeAllListeners();
            result = JSON.stringify({ status: 'stopped', sensor: 'accelerometer' });
            break;

        case 'SENSORS_STOP_GYROSCOPE':
            Gyroscope.removeAllListeners();
            result = JSON.stringify({ status: 'stopped', sensor: 'gyroscope' });
            break;

        case 'SENSORS_STOP_MAGNETOMETER':
            Magnetometer.removeAllListeners();
            result = JSON.stringify({ status: 'stopped', sensor: 'magnetometer' });
            break;

        case 'SENSORS_STOP_PEDOMETER':
            if (pedometerSubscription) {
                pedometerSubscription.remove();
                pedometerSubscription = null;
                result = JSON.stringify({ status: 'stopped', sensor: 'pedometer' });
            } else {
                result = JSON.stringify({ status: 'not_running', sensor: 'pedometer' });
            }
            break;

        case 'SENSORS_STOP_ALL':
            Accelerometer.removeAllListeners();
            Gyroscope.removeAllListeners();
            Magnetometer.removeAllListeners();
            if (pedometerSubscription) {
                pedometerSubscription.remove();
                pedometerSubscription = null;
            }
            result = JSON.stringify({ status: 'stopped_all' });
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

                const enrichedRecords = exRecords.records.map((r: { exerciseType?: number; startTime?: string; endTime?: string; title?: string; notes?: string }) => {
                    const typeName = exerciseTypeNames[r.exerciseType || 0] || 'OTHER';
                    const localizedName = t(`exercise_${typeName.toLowerCase()}`, { defaultValue: typeName });

                    return {
                        ...r,
                        exerciseTypeName: typeName,
                        exerciseTypeLabel: localizedName,
                        title: r.title || localizedName
                    };
                });

                result = JSON.stringify(enrichedRecords);
            } catch (e) {
                console.error('Health get exercise error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading exercise';
            }
            break;

        case 'HEALTH_GET_CALORIES':
            try {
                const access = await ensureHealthAccess();
                if (!access.ok) {
                    success = false;
                    result = access.error || 'Health Access Denied';
                    break;
                }
                const calStart = data.startTimeMs ? new Date(data.startTimeMs) : new Date(Date.now() - 24 * 60 * 60 * 1000);
                const calEnd = data.endTimeMs ? new Date(data.endTimeMs) : new Date();

                debugLog(`Querying Calories from ${calStart.toISOString()} to ${calEnd.toISOString()}`);

                // Parallel fetch: Aggregation (for total) and Records (for details)
                // Use 'TotalCaloriesBurned' which combines active + basal
                const [calRecords, calAgg] = await Promise.all([
                    readRecords('TotalCaloriesBurned', {
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: calStart.toISOString(),
                            endTime: calEnd.toISOString()
                        }
                    }),
                    aggregateRecord({
                        recordType: 'TotalCaloriesBurned',
                        timeRangeFilter: {
                            operator: 'between',
                            startTime: calStart.toISOString(),
                            endTime: calEnd.toISOString()
                        }
                    })
                ]);

                // Calculate total from aggregation result (ENERGY_TOTAL) or fallback to manual sum
                // records usually have 'energy' object with 'inKilocalories'
                const aggTotal = (calAgg as any).ENERGY_TOTAL?.inKilocalories || (calAgg as any).totalEnergy?.inKilocalories || 0;

                let totalCalories = aggTotal;

                // Fallback summation if aggregation fails (sometimes happens on certain devices/permissions)
                if (!totalCalories && calRecords.records) {
                    totalCalories = calRecords.records.reduce((sum: number, r: any) => {
                        const kcal = r.energy?.inKilocalories || 0;
                        return sum + kcal;
                    }, 0);
                }

                debugLog(`Found total calories: ${totalCalories}`);
                result = JSON.stringify({ totalCalories, records: calRecords.records });
            } catch (e) {
                console.error('Health get calories error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error reading calories';
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

        // ============= Device Info Handlers =============
        case 'DEVICE_GET_BATTERY_LEVEL':
            try {
                const level = await Battery.getBatteryLevelAsync();
                result = String(level);
            } catch (e) {
                console.error('Battery level error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'DEVICE_IS_CHARGING':
            try {
                const status = await Battery.getBatteryStateAsync();
                const isCharging = status === Battery.BatteryState.CHARGING || status === Battery.BatteryState.FULL;
                result = String(isCharging);
            } catch (e) {
                console.error('Battery charging error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'DEVICE_GET_NETWORK_INFO':
            try {
                const state = await Network.getNetworkStateAsync();
                // Return simplified type compatible with old navigator.connection.effectiveType or a new rich object
                // For now, let's return the type string (WIFI, CELLULAR, NONE, UNKNOWN)
                console.log(`[Bridge] Network State:`, JSON.stringify(state));

                // Map Expo Network Types to translated strings
                // Use loose equality or check against enum values directly
                if (state.type === Network.NetworkStateType.WIFI) result = t('network_wifi');
                else if (state.type === Network.NetworkStateType.CELLULAR) result = t('network_cellular');
                else if (state.type === Network.NetworkStateType.NONE) result = t('network_none');
                else result = t('network_unknown'); // Default fallback for UNKNOWN or unexpected values

                console.log(`[Bridge] Network result: ${result}`);
            } catch (e) {
                console.error('Network info error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        case 'DEVICE_IS_ONLINE':
            try {
                const state = await Network.getNetworkStateAsync();
                const isOnline = state.isInternetReachable !== false;
                result = String(isOnline);
            } catch (e) {
                console.error('Network online check error:', e);
                success = false;
                result = e instanceof Error ? e.message : 'Error';
            }
            break;

        // ============= Vibration Handler =============
        case 'VIBRATE': {
            let pattern = data.pattern;
            console.log(`[Native Bridge] VIBRATE command received. Raw type: ${typeof pattern}, Value: ${JSON.stringify(pattern)}`);

            try {
                // Cancel any previous vibration to ensure a clean slate
                Vibration.cancel();

                // 1. Normalize input: Handle stringified JSON that might have slipped through
                if (typeof pattern === 'string') {
                    try {
                        const parsed = JSON.parse(pattern);
                        if (Array.isArray(parsed) || typeof parsed === 'number') {
                            pattern = parsed;
                            console.log(`[Native Bridge] Parsed string pattern to: ${JSON.stringify(pattern)}`);
                        }
                    } catch (e) {
                        // Not JSON, assume simple string -> ignore or treat as error
                        console.warn('[Native Bridge] VIBRATE: Could not parse string pattern');
                    }
                }

                // 2. Handle Array Pattern
                if (Array.isArray(pattern)) {
                    // Normalize array: Ensure all elements are numbers
                    const validPattern = pattern.map(p => Number(p)).filter(n => !isNaN(n));

                    if (validPattern.length === 0) {
                        console.warn('[Native Bridge] VIBRATE: Empty pattern array');
                        result = 'Empty pattern';
                        break;
                    }

                    // Android: Native patterns supported. Prepend 0 to start immediately.
                    // Web/User: [vibrate, wait, vibrate, ...]
                    // Android: [wait, vibrate, wait, vibrate, ...]
                    const { Platform } = require('react-native');

                    if (Platform.OS === 'android') {
                        const androidPattern = [0, ...validPattern];
                        console.log(`[Native Bridge] Vibrating Android Pattern: ${JSON.stringify(androidPattern)}`);
                        Vibration.vibrate(androidPattern);
                        result = 'Vibrated (Android Pattern)';
                    } else {
                        // iOS/Other: Fallback loop (Best effort)
                        console.log(`[Native Bridge] Vibrating iOS/Manual Pattern: ${JSON.stringify(validPattern)}`);
                        let currentTime = 0;
                        for (let i = 0; i < validPattern.length; i++) {
                            const duration = validPattern[i];
                            if (i % 2 === 0 && duration > 0) { // Even index = Vibrate
                                setTimeout(() => {
                                    Vibration.vibrate();
                                    // Enhance with Haptics for short bursts on iOS
                                    if (duration < 100) {
                                        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => { });
                                    }
                                }, currentTime);
                            }
                            currentTime += duration;
                        }
                        result = 'Vibrated (Manual Pattern)';
                    }
                }
                // 3. Handle Single Number (Duration)
                else {
                    const duration = Number(pattern);
                    if (!isNaN(duration) && duration > 0) {
                        console.log(`[Native Bridge] Vibrating Single Duration: ${duration}ms`);
                        Vibration.vibrate(duration);

                        // Safety/Enhancement haptic
                        if (duration <= 100) {
                            Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => { });
                        }
                        result = `Vibrated ${duration}ms`;
                    } else {
                        console.warn(`[Native Bridge] VIBRATE: Invalid pattern format: ${pattern}`);
                        result = 'Invalid pattern';
                        success = false;
                    }
                }
            } catch (e) {
                console.error('[Native Bridge] Vibration FATAL error:', e);
                success = false;
                result = e instanceof Error ? e.message : String(e);
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

            // AUTO-CLOSE TIMEOUT (2 minutes max to save battery)
            if (scannerTimeout) clearTimeout(scannerTimeout);
            scannerTimeout = setTimeout(() => {
                console.log('[Bridge] Auto-closing scanner due to timeout');
                useBridgeUIStore.getState().closeScanner();
            }, 2 * 60 * 1000); // 2 minutes

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

                // AUTO-STOP TIMEOUT (5 minutes max)
                if (audioRecordingTimeout) clearTimeout(audioRecordingTimeout);
                audioRecordingTimeout = setTimeout(async () => {
                    console.log('[Bridge] Auto-stopping audio recording due to timeout');
                    if (currentRecording) {
                        try {
                            await currentRecording.stopAndUnloadAsync();
                        } catch (e) {
                            console.warn('Error auto-stopping audio:', e);
                        }
                        currentRecording = null;
                    }
                }, 5 * 60 * 1000); // 5 minutes

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

                if (audioRecordingTimeout) {
                    clearTimeout(audioRecordingTimeout);
                    audioRecordingTimeout = null;
                }

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

    return { success, result, handled: true, deferredCallback };
}
