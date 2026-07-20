// Reads a content:// URI as base64, trying three strategies in order.
// Returns null only if all three fail. Isolated from ShareReceiver so it
// can be unit-tested without pulling in the full React Native modal stack.
//
// Strategy 1: copyAsync to cache + readAsStringAsync (works for MediaStore,
//   Google Files, most well-behaved ContentProviders).
// Strategy 2: readAsStringAsync directly on the content:// URI (works for
//   some providers where copyAsync's file-descriptor path is not supported).
// Strategy 3 (Android only): native ContentResolver.openInputStream via the
//   share-intent module. Rescues WhatsApp voice notes and similar quirky
//   ContentProviders that reject the copyAsync path.

import { Platform } from 'react-native';
import * as FileSystem from 'expo-file-system/legacy';
import * as ShareIntent from 'share-intent';

export async function readContentUriAsBase64(uri: string, fileName: string): Promise<string | null> {
    const safeName = (fileName || 'shared').replace(/[^\w.-]/g, '_');
    const cacheUri = FileSystem.cacheDirectory + `share_${Date.now()}_${safeName}`;

    // Strategy 1
    try {
        await FileSystem.copyAsync({ from: uri, to: cacheUri });
        const info = await FileSystem.getInfoAsync(cacheUri);
        const size = (info as { exists?: boolean; size?: number }).size ?? 0;
        if (info.exists && size > 0) {
            const b64 = await FileSystem.readAsStringAsync(cacheUri, { encoding: FileSystem.EncodingType.Base64 });
            await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
            const clean = b64.replace(/[\r\n]/g, '');
            if (clean.length > 0) return clean;
        } else {
            console.warn('shareRead: strategy 1 produced empty file, trying strategy 2');
            await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
        }
    } catch (e) {
        console.warn('shareRead: strategy 1 (copyAsync) failed:', e);
        await FileSystem.deleteAsync(cacheUri, { idempotent: true }).catch(() => {});
    }

    // Strategy 2
    try {
        const b64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
        const clean = b64.replace(/[\r\n]/g, '');
        if (clean.length > 0) return clean;
        console.warn('shareRead: strategy 2 returned empty base64');
    } catch (e) {
        console.warn('shareRead: strategy 2 (direct read) failed:', e);
    }

    // Strategy 3 (Android only)
    if (Platform.OS === 'android') {
        try {
            const b64 = ShareIntent.readContentUriBase64(uri);
            if (b64 && b64.length > 0) return b64;
            console.warn('shareRead: strategy 3 returned empty base64');
        } catch (e) {
            console.warn('shareRead: strategy 3 (native read) failed:', e);
        }
    }

    return null;
}
