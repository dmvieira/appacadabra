
import firebaseAuth, { signInAnonymously, onAuthStateChanged as onAuthStateChangedModular, getIdToken } from '@react-native-firebase/auth';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import firebaseFirestore, { doc, collection, query, where, orderBy, limit, getDoc, getDocs, setDoc } from '@react-native-firebase/firestore';
import { getApp } from '@react-native-firebase/app';
// @ts-ignore - Index.d.ts exports class as type, but it is a value in runtime. Import from root to ensure module registration.
import { initializeAppCheck, ReactNativeFirebaseAppCheckProvider } from '@react-native-firebase/app-check';
import firebaseCrashlytics, { setCrashlyticsCollectionEnabled } from '@react-native-firebase/crashlytics';
import firebaseAnalytics, { setAnalyticsCollectionEnabled } from '@react-native-firebase/analytics';
import pako from 'pako';

import * as Notifications from 'expo-notifications';
import * as Localization from 'expo-localization';
import { Platform } from 'react-native';
import messaging from '@react-native-firebase/messaging';

// Compression Utils
function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function base64ToUint8Array(base64: string): Uint8Array {
    const binary_string = atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes;
}

export function compressContent(text: string): string {
    if (!text) return '';
    const compressed = pako.gzip(text);
    return `GZIP:${uint8ArrayToBase64(compressed)}`;
}

export function decompressContent(input: string): string {
    if (!input) return '';
    if (input.startsWith('GZIP:')) {
        const base64 = input.substring(5);
        try {
            const decompressed = pako.ungzip(base64ToUint8Array(base64), { to: 'string' });
            return decompressed;
        } catch (e) {
            console.error('Decompression failed', e);
            return input;
        }
    }
    return input;
}

const STORAGE_BUCKET = 'appacadabra-bee0f.firebasestorage.app';

/**
 * Resolves a Storage path (e.g. `store_icons/{spellId}/icon.png`) into a
 * public HTTPS URL. publishSpell uploads icons via `bucket.file().makePublic()`,
 * so we construct the canonical GCS URL directly instead of pulling in
 * `@react-native-firebase/storage` (extra native dep + rebuild).
 */
export function publicStorageUrl(path: string | null | undefined): string | null {
    if (!path) return null;
    const encoded = path.split('/').map(encodeURIComponent).join('/');
    return `https://storage.googleapis.com/${STORAGE_BUCKET}/${encoded}`;
}

function getFunctionsInstance() {
    return getFunctions(getApp(), 'southamerica-east1');
}

export async function ensureAuthenticated(): Promise<string> {
    const auth = firebaseAuth();
    const currentUser = auth.currentUser;

    if (currentUser) {
        try {
            await getIdToken(currentUser, true);
        } catch (e) {
            console.log('Firebase: Failed to refresh token, proceeding anyway', e);
        }
        return currentUser.uid;
    }

    const result = await signInAnonymously(auth);
    console.log('Firebase: Signed in anonymously as', result.user.uid);
    return result.user.uid;
}

async function initializeAppCheckWrapper() {
    try {
        // @ts-ignore - Class is exported as type only in d.ts, but is a value at runtime
        const provider = new ReactNativeFirebaseAppCheckProvider();
        // Debug tokens are only used in dev builds to avoid Play Integrity rate limits.
        // Production builds use Play Integrity (Android) / App Attest (iOS).
        if (__DEV__) {
            provider.configure({
                android: {
                    provider: 'debug',
                    debugToken: '11223344-5566-4778-8990-aabbccddeeff',
                },
                apple: {
                    provider: 'debug',
                    debugToken: 'aabbccdd-eeff-4112-8334-556677889900',
                },
                web: {
                    provider: 'reCaptchaV3',
                    siteKey: 'none',
                },
            });
        } else {
            provider.configure({
                android: { provider: 'playIntegrity' },
                apple: { provider: 'appAttestWithDeviceCheckFallback' },
                web: { provider: 'reCaptchaV3', siteKey: 'none' },
            });
        }

        await initializeAppCheck(getApp(), {
            provider,
            isTokenAutoRefreshEnabled: true,
        });
        console.log(`Firebase: App Check activated (debug provider with fixed tokens)`);
    } catch (e) {
        console.error('Firebase: App Check activation failed. Proceeding without App Check.', e);
    }
}

initializeAppCheckWrapper();

try {
    setCrashlyticsCollectionEnabled(firebaseCrashlytics(), !__DEV__);
} catch (e) {
    if (!__DEV__) console.warn('Firebase: Crashlytics not available', e);
}
try {
    setAnalyticsCollectionEnabled(firebaseAnalytics(), !__DEV__);
} catch (e) {
    if (!__DEV__) console.warn('Firebase: Analytics not available', e);
}

export function getCurrentUserId(): string | null {
    return firebaseAuth().currentUser?.uid || null;
}

export function onAuthStateChanged(callback: (userId: string | null) => void): () => void {
    try {
        const auth = firebaseAuth();
        return onAuthStateChangedModular(auth, (user) => {
            callback(user?.uid || null);
        });
    } catch (e) {
        console.error('Firebase: onAuthStateChanged failed, auth module unavailable:', e);
        return () => {};
    }
}

// ============= Spell Store =============

export interface PublishSpellInput {
    name: string;
    description?: string;
    htmlBase64: string;
    version: number;
    previewImageBase64?: string;
    iconBase64?: string;
    visibility?: 'public' | 'unlisted';
    forkOfSpellId?: string;
    /** BCP-47 language code of the user's device locale (e.g. 'pt', 'en'). Used as authoritative originalLang. */
    locale?: string;
    /** If set, update this existing store listing instead of creating a new one. */
    existingSpellId?: string;
}

export interface PublishSpellResult {
    spellId: string;
    slug: string;
    storeUrl: string;
}

export async function publishSpell(input: PublishSpellInput): Promise<PublishSpellResult> {
    await ensureAuthenticated();
    const fn = httpsCallable<PublishSpellInput, PublishSpellResult>(
        getFunctionsInstance(), 'publishSpell'
    );
    const result = await fn(input);
    return result.data;
}

export async function unpublishSpell(spellId: string): Promise<{ success: boolean }> {
    await ensureAuthenticated();
    const fn = httpsCallable<{ spellId: string }, { success: boolean }>(
        getFunctionsInstance(), 'unpublishSpell'
    );
    const result = await fn({ spellId });
    return result.data;
}

export async function learnSpell(spellId: string): Promise<{ success?: boolean; alreadyLearned?: boolean }> {
    await ensureAuthenticated();
    const fn = httpsCallable<{ spellId: string }, { success?: boolean; alreadyLearned?: boolean }>(
        getFunctionsInstance(), 'learnSpell'
    );
    const result = await fn({ spellId });
    return result.data;
}

export async function unlearnSpell(spellId: string): Promise<{ ok: boolean; alreadyUnlearned?: boolean }> {
    await ensureAuthenticated();
    const fn = httpsCallable<{ spellId: string }, { ok: boolean; alreadyUnlearned?: boolean }>(
        getFunctionsInstance(), 'unlearnSpell'
    );
    const result = await fn({ spellId });
    return result.data;
}

export interface SyncedSpellItem {
    spellId: string;
    slug: string;
    name: string;
    description: string;
    iconPath: string | null;
    authorUid: string;
    authorName: string;
    publishedVersion: number;
    signedHtmlUrl: string;
    originalLang?: string;
    translations?: Record<string, { name: string; description: string }>;
    forkOfSpellId?: string | null;
    rootSpellId?: string;
}

export async function syncLearnedSpells(input?: { forceSpellId?: string; recoverAll?: boolean }): Promise<{ spells: SyncedSpellItem[] }> {
    await ensureAuthenticated();
    const fn = httpsCallable<{ forceSpellId?: string; recoverAll?: boolean } | undefined, { spells: SyncedSpellItem[] }>(
        getFunctionsInstance(), 'syncLearnedSpells'
    );
    const payload: { forceSpellId?: string; recoverAll?: boolean } = {};
    if (input?.forceSpellId) payload.forceSpellId = input.forceSpellId;
    if (input?.recoverAll) payload.recoverAll = true;
    const result = await fn(Object.keys(payload).length > 0 ? payload : undefined);
    return result.data;
}

export interface TopStoreSpell {
    spellId: string;
    name: string;
    description?: string;
    iconUrl?: string;
    learnCount?: number;
}

/**
 * Lists the most-learned active spells. Used by the BYOK onboarding to
 * surface what the platform can do before asking for a key. Anonymous
 * Firestore reads are permitted by the security rules on `store_spells`.
 */
export async function listTopStoreSpells(maxResults = 6): Promise<TopStoreSpell[]> {
    try {
        const firestore = firebaseFirestore();
        // Filter by visibility=public to match the existing composite index
        // (status, visibility, learnCount DESC) in firestore.indexes.json and
        // the website's browse query (website/store/js/browse.js). Without this
        // filter the query fails with FAILED_PRECONDITION and returns [].
        const q = query(
            collection(firestore, 'store_spells'),
            where('status', '==', 'active'),
            where('visibility', '==', 'public'),
            orderBy('learnCount', 'desc'),
            limit(maxResults),
        );
        const snap = await getDocs(q);
        // Pick locale-matched name/description from the spell's translations
        // map, falling back to EN then to the top-level fields. Same pattern
        // used by storeSync.ts:262-266 and website/store/js/utils.js.
        const userLang = Localization.getLocales()[0]?.languageCode ?? 'en';
        return snap.docs.map((d: any) => {
            const data = d.data() as any;
            const meta = data?.translations?.[userLang]
                ?? data?.translations?.['en']
                ?? { name: data?.name, description: data?.description };
            return {
                spellId: d.id,
                name: meta?.name ?? data?.name ?? data?.title ?? 'Spell',
                description: meta?.description ?? data?.description,
                iconUrl: publicStorageUrl(data?.iconPath) ?? undefined,
                learnCount: typeof data?.learnCount === 'number' ? data.learnCount : 0,
            };
        });
    } catch (e: any) {
        console.warn('[Firebase] listTopStoreSpells failed:', e?.message);
        return [];
    }
}

export async function getStoreSpellStatus(spellId: string): Promise<'active' | 'removed' | 'not_found' | 'unknown'> {
    try {
        const firestore = firebaseFirestore();
        const docRef = doc(collection(firestore, 'store_spells'), spellId);
        const snap = await getDoc(docRef);
        if (!snap.exists()) return 'not_found';
        const data = snap.data() as { status?: string } | undefined;
        const status = data?.status;
        return status === 'active' ? 'active' : 'removed';
    } catch (e: any) {
        console.warn('[Firebase] getStoreSpellStatus failed:', e?.message);
        return 'unknown';
    }
}

import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

const grantedScopeKeys = new Set<string>();

// Serializes all GoogleSignin operations — getTokens/addScopes are not concurrent-safe.
let _googleSigninQueue: Promise<any> = Promise.resolve();
function withGoogleSigninLock<T>(fn: () => Promise<T>): Promise<T> {
    const result = _googleSigninQueue.then(fn, fn);
    _googleSigninQueue = result.catch(() => {});
    return result;
}

GoogleSignin.configure({
    scopes: ['https://www.googleapis.com/auth/drive.appdata'],
    webClientId: '901177243529-0vod4amdjigg9bvve0h1ebaa609hpdba.apps.googleusercontent.com',
    offlineAccess: true,
    hostedDomain: '',
    forceCodeForRefreshToken: true,
    accountName: '',
});

import { GoogleAuthProvider, linkWithCredential, signInWithCredential } from '@react-native-firebase/auth';

export async function signInWithGoogle() {
    try {
        await GoogleSignin.hasPlayServices();
        const response = await GoogleSignin.signIn();

        if (response.type === 'cancelled') {
            throw new Error('Sign in cancelled');
        }

        const idToken = response.data?.idToken;

        if (!idToken) throw new Error('No ID token found');

        const googleCredential = GoogleAuthProvider.credential(idToken);
        return signInWithCredential(firebaseAuth(), googleCredential);
    } catch (error: any) {
        console.error('Google Sign-In Error', error);
        throw error;
    }
}

export async function linkWithGoogle() {
    try {
        await GoogleSignin.hasPlayServices();

        // Try silent first — avoids native picker when Play Services has a cached session
        let idToken: string | null = null;
        try {
            const silent = await GoogleSignin.signInSilently();
            idToken = silent.data?.idToken ?? null;
        } catch {
            // No cached session — fall through to interactive sign-in
        }

        if (!idToken) {
            const response = await GoogleSignin.signIn();
            if (response.type === 'cancelled') {
                throw new Error('Sign in cancelled');
            }
            idToken = response.data?.idToken ?? null;
        }

        if (!idToken) throw new Error('No ID token from Google Sign-In');

        const googleCredential = GoogleAuthProvider.credential(idToken);
        let user = firebaseAuth().currentUser;
        if (!user) {
            // BYOK cold-start has no implicit anonymous bootstrap (server-side
            // generation used to do it). Mirror the v2.0.15 caller pattern here
            // so every sign-in entry point works without a pre-existing user.
            await ensureAuthenticated();
            user = firebaseAuth().currentUser;
        }

        // Fast-path: the current Firebase user is already linked with Google.
        // linkWithCredential would throw auth/provider-already-linked here
        // (sometimes surfaced as auth/unknown by the native module), but the
        // user's intent — "be signed in with Google" — is already satisfied.
        if (isGoogleUser()) {
            return { user: user! } as any;
        }

        try {
            return await linkWithCredential(user!, googleCredential);
        } catch (linkError: any) {
            if (linkError.code === 'auth/credential-already-in-use') {
                // Account already exists — sign in directly with the same credential
                return await signInWithCredential(firebaseAuth(), googleCredential);
            }
            // Provider is already linked to this user (race or surfaced as auth/unknown).
            // The intent is satisfied — treat as success rather than bubbling an error.
            const linkMsg = String(linkError?.message ?? '');
            if (
                linkError.code === 'auth/provider-already-linked' ||
                /already been linked to the given provider/i.test(linkMsg)
            ) {
                return { user: firebaseAuth().currentUser! } as any;
            }
            throw linkError;
        }
    } catch (error: any) {
        console.error('Link Google Error', error);
        if (error.code === statusCodes.SIGN_IN_CANCELLED) {
            throw new Error('Sign in cancelled');
        } else if (error.code === statusCodes.IN_PROGRESS) {
            throw new Error('Sign in in progress');
        } else if (error.code === statusCodes.PLAY_SERVICES_NOT_AVAILABLE) {
            throw new Error('Play services not available');
        } else {
            throw error;
        }
    }
}

export async function signOut() {
    try {
        await GoogleSignin.revokeAccess();
    } catch (error) {
        console.warn('[signOut] revokeAccess failed (non-critical):', error);
    }
    try {
        await GoogleSignin.signOut();
    } catch (error) {
        console.warn('[signOut] GoogleSignin.signOut failed:', error);
    }
    await firebaseAuth().signOut();
}

export function getCurrentUser() {
    return firebaseAuth().currentUser;
}

/** Check if the current Firebase user is linked with Google (vs anonymous-only) */
export function isGoogleUser(): boolean {
    const user = firebaseAuth().currentUser;
    if (!user) return false;
    return user.providerData.some(p => p.providerId === 'google.com');
}

/** Get the Google OAuth access token for API calls (e.g. Drive) */
export function getGoogleAccessToken(): Promise<string | null> {
    return withGoogleSigninLock(async () => {
        try {
            const tokens = await GoogleSignin.getTokens();
            return tokens.accessToken;
        } catch (e) {
            console.warn('[Firebase] Failed to get Google access token:', e);
            return null;
        }
    });
}

/** Request additional Google OAuth scopes lazily (incremental auth).
 *  If not signed in: signs in requesting these scopes.
 *  If already signed in: requests only the new scopes via incremental consent.
 *  Returns access token, or null if user cancelled/denied.
 */
export function requestGoogleScopes(scopes: string[]): Promise<string | null> {
    return withGoogleSigninLock(async () => {
        const scopeKey = scopes.slice().sort().join(',');
        try {
            const isSignedIn = await GoogleSignin.getCurrentUser() !== null;
            if (!isSignedIn) {
                await GoogleSignin.signIn();
                grantedScopeKeys.delete(scopeKey);
            }
            if (!grantedScopeKeys.has(scopeKey)) {
                const userWithScopes = await GoogleSignin.addScopes({ scopes });
                if (!userWithScopes) return null;
                grantedScopeKeys.add(scopeKey);
            }
            const tokens = await GoogleSignin.getTokens();
            return tokens.accessToken;
        } catch (e: any) {
            if (e.code === statusCodes.SIGN_IN_CANCELLED) return null;
            console.error('[requestGoogleScopes] failed:', e);
            grantedScopeKeys.delete(scopeKey);
            return null;
        }
    });
}

/**
 * Request notification permissions and save the Expo Push Token to the user's document.
 */
export async function registerAndSavePushTokenAsync(userId: string, locale?: string) {
    if (Platform.OS === 'web') return;

    try {
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== 'granted') {
            const { status } = await Notifications.requestPermissionsAsync();
            finalStatus = status;
        }

        if (finalStatus !== 'granted') {
            console.log('[Firebase] Push notifications permission not granted');
            return;
        }

        const pushToken = await messaging().getToken();

        console.log('[Firebase] FCM Push Token obtained:', pushToken);

        const db = firebaseFirestore();
        await setDoc(doc(db, 'users', userId), { pushToken, ...(locale ? { locale } : {}) }, { merge: true });
        console.log('[Firebase] Push Token saved to Firestore for user', userId);
    } catch (e: any) {
        console.error('[Firebase] Failed to get/save push token:', e?.message, e?.code, e);
    }
}
