/**
 * Shared WebView message handlers
 * 
 * This module provides a unified handler for WebView bridge messages,
 * reducing code duplication across [id].tsx, RunnerApp.tsx, and AppRunner.tsx
 */

import * as Notifications from 'expo-notifications';
import * as Location from 'expo-location';
import * as FileSystem from 'expo-file-system/legacy';
import * as Speech from 'expo-speech';
import { Audio } from 'expo-av';
import { WebView } from 'react-native-webview';
import { useBridgeUIStore } from '../bridgeUIStore';
import { markBackupDirty } from '../backupSync';
import { NativeModules } from 'react-native';
import * as db from '../database/db';
import { ALL_CAPABILITIES } from '../capabilities/index';
import { ExpandedStorageItem } from './injectedJS';
import { updateStorageCache, removeFromStorageCache } from '../storageCache';

// State for Audio Recording
let currentRecording: Audio.Recording | null = null;
let audioRecordingTimeout: NodeJS.Timeout | null = null;
// State for AI TTS
let currentAITTS: Audio.Sound | null = null;
let currentVideoSound: Audio.Sound | null = null;
let scannerTimeout: NodeJS.Timeout | null = null;
let pedometerSubscription: any | null = null;

/**
 * Cleanup all active media: stop audio recording, TTS, and video playback.
 * Call this when leaving the app or unmounting the WebView.
 */
export async function cleanupAllMedia(): Promise<void> {
    console.log('[Bridge] cleanupAllMedia: stopping all media...');

    // Stop audio recording
    if (currentRecording) {
        try {
            await currentRecording.stopAndUnloadAsync();
        } catch (e) {
            console.warn('[Bridge] Error stopping audio recording:', e);
        }
        currentRecording = null;
    }
    if (audioRecordingTimeout) {
        clearTimeout(audioRecordingTimeout);
        audioRecordingTimeout = null;
    }

    // Stop TTS (device)
    try {
        Speech.stop();
    } catch (e) {
        console.warn('[Bridge] Error stopping TTS:', e);
    }

    // Stop AI TTS
    if (currentAITTS) {
        try {
            await currentAITTS.stopAsync();
            await currentAITTS.unloadAsync();
        } catch (e) {
            console.warn('[Bridge] Error stopping AI TTS playback:', e);
        }
        currentAITTS = null;
    }

    // Stop video playback
    if (currentVideoSound) {
        try {
            await currentVideoSound.stopAsync();
            await currentVideoSound.unloadAsync();
        } catch (e) {
            console.warn('[Bridge] Error stopping video playback:', e);
        }
        currentVideoSound = null;
    }

    // Pause all HTML5 audio/video in the WebView
    const webViewRef = useBridgeUIStore.getState().webViewRef;
    if (webViewRef?.current) {
        try {
            const pauseScript = `
                (function() {
                    var media = document.querySelectorAll('audio, video');
                    for (var i = 0; i < media.length; i++) {
                        media[i].pause();
                    }
                })();
            `;
            webViewRef.current.injectJavaScript(pauseScript);
        } catch (e) {
            console.warn('[Bridge] Error injecting pause script:', e);
        }
    }
}

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

// ============= Storage Blob Helpers =============
const STORAGE_BLOB_MARKER = '__appblob__:';

export const AI_MEDIA_EXT: Record<string, string> = {
    AI_GENERATE_IMAGE: 'jpg', AI_GENERATE_VIDEO: 'mp4',
    CAMERA_TAKE_PHOTO: 'jpg', CAMERA_RECORD_VIDEO: 'mp4',
    AUDIO_RECORD_STOP: 'm4a', AUDIO_SPEAK_AI: 'wav',
};
export const AI_MEDIA_MIME: Record<string, string> = {
    AI_GENERATE_IMAGE: 'image/jpeg', AI_GENERATE_VIDEO: 'video/mp4',
    CAMERA_TAKE_PHOTO: 'image/jpeg', CAMERA_RECORD_VIDEO: 'video/mp4',
    AUDIO_RECORD_STOP: 'audio/m4a', AUDIO_SPEAK_AI: 'audio/wav',
};

export async function saveAiMediaToFile(
    appId: number, callbackName: string, action: string, base64: string
): Promise<string> {
    const ext = AI_MEDIA_EXT[action] ?? 'bin';
    const docDir = (FileSystem.documentDirectory ?? '').replace('file://', '');
    const dir = `${docDir}appacadabra_media/${appId}`;
    await FileSystem.makeDirectoryAsync(`file://${dir}`, { intermediates: true }).catch(() => { });
    const path = `${dir}/${callbackName}.${ext}`;
    await FileSystem.writeAsStringAsync(`file://${path}`, base64, { encoding: FileSystem.EncodingType.Base64 });
    return path; // bare path (no file://)
}

export function buildBlobMarker(mimeType: string, callbackName: string, barePath: string): string {
    return `${STORAGE_BLOB_MARKER}${mimeType}|${callbackName}|${barePath}`;
}

// Map from base64 fingerprint → callbackName, so storeBlobToFile can embed the callbackName
// in the marker for proper relic linking in the data viewer.
const pendingMediaBlobs = new Map<string, string>(); // base64Key → callbackName
const pendingMediaMimeTypes = new Map<string, string>(); // callbackName → mimeType hint
const MAX_PENDING = 20;
// Fallback queue for when fingerprint lookup fails (e.g. base64 round-trip differences)
const pendingMediaQueue: { callbackName: string; mimeType: string }[] = [];
const MAX_QUEUE = 5;

function pendingMediaKey(base64: string): string {
    // Strip data: prefix and whitespace to match storeBlobToFile normalization
    const raw = base64.replace(/^data:.*?;base64,/i, '');
    const cleaned = raw.replace(/\s/g, '');
    return `${cleaned.slice(0, 100)}:${cleaned.length}`;
}

export function registerPendingMediaBlob(base64: string, callbackName: string, mimeTypeHint?: string): void {
    if (pendingMediaBlobs.size >= MAX_PENDING) {
        pendingMediaBlobs.delete(pendingMediaBlobs.keys().next().value!);
    }
    pendingMediaBlobs.set(pendingMediaKey(base64), callbackName);
    if (callbackName && mimeTypeHint) {
        pendingMediaMimeTypes.set(callbackName, mimeTypeHint);
        pendingMediaQueue.push({ callbackName, mimeType: mimeTypeHint });
        if (pendingMediaQueue.length > MAX_QUEUE) pendingMediaQueue.shift();
    }
}

function isLargeBase64(value: string): boolean {
    if (value.length < 500) return false;
    if (/^data:[a-z]+\/[a-z0-9+.\-]+;base64,/i.test(value)) return true;
    // Strip whitespace before testing (Android base64 has \n every 76 chars)
    const cleaned = value.replace(/\s/g, '');
    if (cleaned.length < 500) return false;
    // Standard base64 (A-Za-z0-9+/=)
    if (/^[A-Za-z0-9+/]{500,}={0,2}$/.test(cleaned)) return true;
    // URL-safe base64 (A-Za-z0-9-_=) — some Expo/Android versions use this
    if (/^[A-Za-z0-9\-_]{500,}={0,2}$/.test(cleaned)) return true;
    return false;
}

async function storeBlobToFile(appId: number, key: string, value: string): Promise<string> {
    let base64Data = value;
    let mimeType = '';
    let ext = 'bin';

    const prefixMatch = value.match(/^data:(.*?);?base64,/i);
    if (prefixMatch) {
        mimeType = prefixMatch[1] ? prefixMatch[1].split(';')[0] : '';
        base64Data = value.replace(/^data:.*?;base64,/i, '');
        ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? 'bin';
    }
    base64Data = base64Data.replace(/\s/g, ''); // Strip whitespace (Android adds \n every 76 chars)

    // Look up registered callbackName before file creation so ext is correct
    const cbKey = pendingMediaKey(base64Data);
    let cbName = pendingMediaBlobs.get(cbKey) ?? '';
    if (cbName) pendingMediaBlobs.delete(cbKey);

    // Fallback: fingerprint may not match due to base64 round-trip differences;
    // use the most recently registered entry that still has a pending mime type.
    if (!cbName) {
        for (let i = pendingMediaQueue.length - 1; i >= 0; i--) {
            const entry = pendingMediaQueue[i];
            if (pendingMediaMimeTypes.has(entry.callbackName)) {
                cbName = entry.callbackName;
                pendingMediaQueue.splice(i, 1);
                break;
            }
        }
    }

    // If no mimeType from data: prefix, try the hint stored by registerPendingMediaBlob
    if (!mimeType && cbName && pendingMediaMimeTypes.has(cbName)) {
        mimeType = pendingMediaMimeTypes.get(cbName)!;
        ext = mimeType.split('/')[1]?.replace('jpeg', 'jpg') ?? ext;
        pendingMediaMimeTypes.delete(cbName);
    }

    const safeKey = key.replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
    const dir = `${FileSystem.documentDirectory}appacadabra_media/${appId}`;
    await FileSystem.makeDirectoryAsync(dir, { intermediates: true }).catch(() => { });
    const fileUri = `${dir}/ls_${safeKey}.${ext}`;
    await FileSystem.writeAsStringAsync(fileUri, base64Data, {
        encoding: FileSystem.EncodingType.Base64,
    });

    const barePath = fileUri.startsWith('file://') ? fileUri.slice(7) : fileUri;
    // Format: __appblob__:mimeType|callbackName|barePath  (cbName may be empty for backward compat)
    const effectiveCbName = cbName || safeKey;
    return `${STORAGE_BLOB_MARKER}${mimeType}|${effectiveCbName}|${barePath}`;
}

export async function expandStorageBlobMarkers(
    items: { key: string; value: string }[]
): Promise<ExpandedStorageItem[]> {
    return Promise.all(items.map(async (item): Promise<ExpandedStorageItem> => {
        if (!item.value.startsWith(STORAGE_BLOB_MARKER)) return item;
        const payload = item.value.slice(STORAGE_BLOB_MARKER.length);
        // Support both formats:
        //   New: mimeType|callbackName|barePath  (2 pipes)
        //   Old: mimeType|barePath               (1 pipe)
        const firstSep = payload.indexOf('|');
        const mimeType = payload.slice(0, firstSep);
        const rest = payload.slice(firstSep + 1);
        const secondSep = rest.indexOf('|');

        if (secondSep >= 0) {
            // New format: mimeType|callbackName|barePath
            const callbackName = rest.slice(0, secondSep);
            const barePath = rest.slice(secondSep + 1);
            try {
                const base64 = await FileSystem.readAsStringAsync(`file://${barePath}`, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                const blobDataUri = mimeType ? `data:${mimeType};base64,${base64}` : base64;
                return {
                    key: item.key,
                    value: item.value, // Keep marker as value for WebView localStorage
                    blobDataUri,
                    blobCallbackName: callbackName || item.key || undefined,
                };
            } catch {
                return { key: item.key, value: '' };
            }
        } else {
            // Old format: mimeType|barePath (backward compat: expand to data URI directly)
            const barePath = rest;
            try {
                const base64 = await FileSystem.readAsStringAsync(`file://${barePath}`, {
                    encoding: FileSystem.EncodingType.Base64,
                });
                return { key: item.key, value: mimeType ? `data:${mimeType};base64,${base64}` : base64 };
            } catch {
                return { key: item.key, value: '' };
            }
        }
    }));
}

export async function migrateStorageBlobsToFiles(appId: number): Promise<void> {
    const items = await db.getStorageForApp(appId);
    for (const item of items) {
        if (item.value.startsWith(STORAGE_BLOB_MARKER)) continue;
        if (!isLargeBase64(item.value)) continue;
        const marker = await storeBlobToFile(appId, item.key, item.value);
        await db.setStorageItem(appId, item.key, marker);
        updateStorageCache(appId, item.key, marker);
    }
}

// ============= Alarm Registry (in-memory, AlarmManager not queryable) =============
interface AlarmEntry {
    id: string;
    title: string;
    body: string;
    timeMs: number;
    isAlarm: true;
}
// Map<appId, Map<id, AlarmEntry>>
const alarmRegistry = new Map<number, Map<string, AlarmEntry>>();
// Track which appIds have been loaded from DB to avoid repeated DB reads
const alarmRegistryLoaded = new Set<number>();

async function getAlarmRegistry(appId: number): Promise<Map<string, AlarmEntry>> {
    if (!alarmRegistry.has(appId)) alarmRegistry.set(appId, new Map());
    const reg = alarmRegistry.get(appId)!;
    if (!alarmRegistryLoaded.has(appId)) {
        alarmRegistryLoaded.add(appId);
        try {
            const rows = await db.getAlarmsForApp(appId);
            for (const row of rows) {
                if (!reg.has(row.alarmId)) {
                    reg.set(row.alarmId, { id: row.alarmId, title: row.title, body: row.body, timeMs: row.timeMs, isAlarm: true });
                }
            }
        } catch { }
    }
    return reg;
}

/**
 * Get all scheduled notifications for a specific spell
 */
async function getSpellNotifications(appId: number | null) {
    if (!appId) return [];
    try {
        const all = await Notifications.getAllScheduledNotificationsAsync();
        return all.filter(n => {
            const content = n.content as any;

            // 1. channelId "spell-{id}" (Android primary)
            if (content.channelId === `spell-${appId}`) return true;

            // 2. data.appId (iOS / older Android) — loose equality for string/number
            if (content.data?.appId == appId) return true;
            if (content.data?.appId && content.data.appId.toString() === appId.toString()) return true;

            // 3. data.payload (stringified workaround)
            if (content.data?.payload) {
                try {
                    const p = typeof content.data.payload === 'string' ? JSON.parse(content.data.payload) : content.data.payload;
                    if (p.appId && Number(p.appId) === Number(appId)) return true;
                } catch { }
            }

            // 4. badge (Android fallback — stores appId as badge number)
            if (typeof content.badge === 'number' && content.badge === Number(appId)) return true;

            return false;
        });
    } catch (e) {
        console.error('Error fetching notifications:', e);
        return [];
    }
}

export async function cancelAlarmEntry(appId: number, alarmId: string): Promise<void> {
    try {
        await NativeModules.AlarmModule.cancelAlarm(alarmId);
    } catch (e) {
        console.warn('[cancelAlarmEntry] NativeModule cancel failed:', e);
    }
    await db.deleteAlarm(appId, alarmId);
    alarmRegistry.get(appId)?.delete(alarmId);
}

export async function cancelSpellNotifications(appId: number): Promise<void> {
    const toCancel = await getSpellNotifications(appId);
    for (const n of toCancel) {
        await Notifications.cancelScheduledNotificationAsync(n.identifier).catch(() => { });
    }
    const reg = await getAlarmRegistry(appId);
    for (const alarmId of reg.keys()) {
        await NativeModules.AlarmModule.cancelAlarm(alarmId).catch(() => { });
    }
    reg.clear();
    alarmRegistryLoaded.delete(appId);
    await db.deleteAllAlarmsForApp(appId).catch(() => { });
}

/**
 * Restore all future alarms from SQLite after a process restart.
 * AlarmManager entries are lost when the RN process dies; this re-registers them.
 */
export async function restoreScheduledAlarms(): Promise<void> {
    const now = Date.now();
    try {
        const future = (await db.getAllFutureAlarms()).filter(a => a.timeMs > now);
        for (const alarm of future) {
            try {
                await NativeModules.AlarmModule.scheduleAlarm(
                    alarm.alarmId, alarm.title, alarm.body, alarm.timeMs
                );
                // Update in-memory registry
                if (!alarmRegistry.has(alarm.appId)) alarmRegistry.set(alarm.appId, new Map());
                alarmRegistry.get(alarm.appId)!.set(alarm.alarmId, {
                    id: alarm.alarmId, title: alarm.title, body: alarm.body, timeMs: alarm.timeMs, isAlarm: true
                });
                alarmRegistryLoaded.add(alarm.appId);
            } catch { }
        }
        console.log(`[Bridge] restoreScheduledAlarms: restored ${future.length} alarm(s)`);
    } catch (e) {
        console.warn('[Bridge] restoreScheduledAlarms failed:', e);
    }
}


export interface HandlerContext {
    webViewRef: React.RefObject<WebView>;
    viewContainerRef?: React.RefObject<any>; // Useful for screen capture
    appId: number | null;
    callbackName?: string; // Callback name from the message wrapper
    onJobCreated?: (jobId: string) => void; // Called when Firestore job doc is created
}

export interface HandlerResult {
    success: boolean;
    result: string;
    handled: boolean;  // false if message type was not recognized
    deferredCallback?: boolean;
    creditsUsed?: number;
    isFirstAiUse?: boolean;
}

/**
 * Handle a WebView bridge message.
 * Returns { handled: false } if the message type is not recognized,
 * allowing the caller to handle it locally.
 */
export async function handleBridgeMessage(
    type: string,
    data: any,
    ctx: HandlerContext & { callbackName?: string }
): Promise<HandlerResult> {
    let success = true;
    let result = '';
    let deferredCallback = false;
    let creditsUsedResult = 0;
    let isFirstAiUse = false;

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

    // ── Capability module delegates ──────────────────────────────────────────
    // Each registered capability handles its own message types and returns null
    // for types it doesn't own. Extracted capabilities are removed from the
    // switch below as they are migrated.
    for (const cap of ALL_CAPABILITIES) {
        const capRes = await cap.handleMessage(type, data, ctx);
        if (capRes !== null) {
            return {
                success: capRes.success ?? true,
                result: capRes.result ?? '',
                handled: true,
                deferredCallback: capRes.deferredCallback ?? false,
                creditsUsed: capRes.creditsUsed ?? 0,
                isFirstAiUse: capRes.isFirstAiUse ?? false,
            };
        }
    }

    switch (type) {
        // ============= Storage Handlers =============
        case 'STORAGE_SET':
            if (shouldLog('STORAGE_SET', data.key)) {
                debugLog(`Storage set: ${data.key} (Throttled x${messageThrottles['STORAGE_SET:' + data.key] || 0})`);
            }
            if (ctx.appId) {
                let storedValue = data.value;
                if (isLargeBase64(data.value)) {
                    storedValue = await storeBlobToFile(ctx.appId, data.key, data.value);
                }
                await db.setStorageItem(ctx.appId, data.key, storedValue);
                // Keep cache in sync so returning from background doesn't overwrite new data
                updateStorageCache(ctx.appId, data.key, storedValue);
                markBackupDirty();
                const { DeviceEventEmitter } = require('react-native');
                DeviceEventEmitter.emit('STORAGE_UPDATED', { appId: ctx.appId });
                result = 'OK';
            }
            break;

        case 'STORAGE_REMOVE':
            debugLog(`Storage remove: ${data.key}`);
            if (ctx.appId) {
                await db.removeStorageItem(ctx.appId, data.key);
                // Keep cache in sync so returning from background doesn't overwrite new data
                removeFromStorageCache(ctx.appId, data.key);
                markBackupDirty();
                const { DeviceEventEmitter } = require('react-native');
                DeviceEventEmitter.emit('STORAGE_UPDATED', { appId: ctx.appId });
            }
            break;

        case 'STORAGE_CLEAR':
            debugLog('Storage clear');
            if (ctx.appId) {
                await db.clearStorageForApp(ctx.appId);
                markBackupDirty();
                const { DeviceEventEmitter } = require('react-native');
                DeviceEventEmitter.emit('STORAGE_CLEARED', { appId: ctx.appId });
                DeviceEventEmitter.emit('STORAGE_UPDATED', { appId: ctx.appId });
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

        default:
            // Message type not handled by shared module
            return { success: false, result: '', handled: false };
    }

    return {
        success,
        result,
        handled: true,
        deferredCallback,
        creditsUsed: creditsUsedResult,
        isFirstAiUse
    };
}
