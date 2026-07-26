import { NativeModules, Platform } from 'react-native';
import { t } from './i18n';

// Cross-platform keep-alive facade for WebView-initiated AI calls
// (AppacadabraAI.* inside a running spell). Each acquire returns an opaque
// token; the caller passes the same token to release() in a finally block.
//
// Platform behavior:
//   - iOS: BackgroundGenerator.acquireKeepAlive/releaseKeepAlive extends the
//     app's background execution window via UIApplication.beginBackgroundTask
//     (~30s cap — enough for text and image gen, best-effort for video).
//   - Android: WebViewAiKeepAlive.acquire/release starts a foreground service
//     (foregroundServiceType=dataSync) so the process is not trimmed while
//     the fetch to OpenRouter is in flight. Ref-counted — the notification
//     stays up until the last release.
//   - Other platforms / unsupported builds: no-op (returns "" / resolves).
//
// The facade is safe to call before the native modules are ready; a missing
// module is treated as a no-op rather than an error, so a WebView AI call
// never fails because keep-alive couldn't be armed.

interface IosNativeModule {
    acquireKeepAlive?(reason: string): Promise<string>;
    releaseKeepAlive?(tokenId: string): Promise<void>;
}

interface AndroidNativeModule {
    acquire?(reason: string | null, title: string | null): Promise<string>;
    release?(tokenId: string): Promise<void>;
}

function getIosModule(): IosNativeModule | null {
    if (Platform.OS !== 'ios') return null;
    const mod = (NativeModules as Record<string, unknown>).BackgroundGenerator as IosNativeModule | undefined;
    if (mod && typeof mod.acquireKeepAlive === 'function') return mod;
    return null;
}

function getAndroidModule(): AndroidNativeModule | null {
    if (Platform.OS !== 'android') return null;
    const mod = (NativeModules as Record<string, unknown>).WebViewAiKeepAlive as AndroidNativeModule | undefined;
    if (mod && typeof mod.acquire === 'function') return mod;
    return null;
}

/**
 * Acquire a keep-alive token for an in-flight WebView AI call. Returns an
 * opaque token string — empty string means the platform doesn't support
 * keep-alive (or the native module is missing) and the caller should treat
 * the release as a no-op.
 */
export async function acquire(reason: string): Promise<string> {
    try {
        const ios = getIosModule();
        if (ios) {
            return await ios.acquireKeepAlive!(reason);
        }
        const android = getAndroidModule();
        if (android) {
            // Localized notification title — Android FGS requires a visible
            // notification, and the user should see it in their language.
            let title = '';
            try {
                title = t('webviewAiKeepAliveNotification') || '';
            } catch { /* ignore */ }
            return await android.acquire!(reason, title || null);
        }
    } catch (e) {
        // Never fail the AI call because keep-alive couldn't be armed.
        console.warn('[keepAlive] acquire failed:', e);
    }
    return '';
}

/**
 * Release a previously-acquired token. Safe to call with an empty string
 * (no-op) or with a token that was never issued (best-effort).
 */
export async function release(tokenId: string): Promise<void> {
    if (!tokenId) return;
    try {
        const ios = getIosModule();
        if (ios) {
            await ios.releaseKeepAlive!(tokenId);
            return;
        }
        const android = getAndroidModule();
        if (android) {
            await android.release!(tokenId);
            return;
        }
    } catch (e) {
        console.warn('[keepAlive] release failed:', e);
    }
}

/**
 * Wraps a WebView-initiated AI call in an acquire/release pair. On iOS this
 * extends the background execution window (~30s); on Android it holds a
 * foreground service so the fetch to OpenRouter isn't killed if the user
 * backgrounds the app mid-call. The release is guaranteed even if the wrapped
 * call throws — critical to avoid a stuck FGS notification.
 */
export async function withKeepAlive<T>(reason: string, fn: () => Promise<T>): Promise<T> {
    const token = await acquire(reason);
    try {
        return await fn();
    } finally {
        await release(token);
    }
}
