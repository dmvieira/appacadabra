
import firebaseAuth, { signInAnonymously, onAuthStateChanged as onAuthStateChangedModular, getIdToken, reload as reloadUser } from '@react-native-firebase/auth';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import firebaseFirestore, { doc, collection, onSnapshot, addDoc, serverTimestamp, query, where, orderBy, limit, getDoc, setDoc } from '@react-native-firebase/firestore';
import { getApp } from '@react-native-firebase/app';
// @ts-ignore - Index.d.ts exports class as type, but it is a value in runtime. Import from root to ensure module registration.
import { initializeAppCheck, ReactNativeFirebaseAppCheckProvider } from '@react-native-firebase/app-check';
import firebaseCrashlytics, { setCrashlyticsCollectionEnabled } from '@react-native-firebase/crashlytics';
import firebaseAnalytics, { setAnalyticsCollectionEnabled } from '@react-native-firebase/analytics';
import Constants from 'expo-constants';
import pako from 'pako';

const APP_VERSION = Constants.expoConfig?.version || '1.0.0';

import * as Notifications from 'expo-notifications';
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
            return input; // Fallback? Or throw?
        }
    }
    return input;
}

// Types for function responses
export interface GenerationResult {
    text: string;
    usage: {
        promptTokens: number;
        responseTokens: number;
        totalTokens: number;
    };
    creditsUsed: number;
    creditsRemaining: number;
}

export interface CreditsResult {
    credits: number;
}

export interface AddCreditsResult {
    success: boolean;
    creditsRemaining: number;
}

export interface Job {
    id: string;
    userId: string;
    action: 'create' | 'edit' | 'convert' | 'app_icon' | 'webview_ai' | 'webview_ai_tts' | 'webview_ai_image' | 'webview_ai_similarity' | 'webview_ai_video';
    status: 'queued' | 'processing' | 'completed' | 'failed';
    createdAt: any;
    payload?: any; // Added payload so we can retrieve appId from it
    result?: {
        text: string;
        usage?: any;
        creditsUsed?: number;
        creditsRemaining?: number;
        appName?: string;
    };
    error?: string;
}

export interface PreviousEdit {
    version: number;
    instruction: string;
}

/**
 * Why Anonymous Auth?
 * We use anonymous authentication to assign a unique User ID (UID) to this device.
 * This allows us to:
 * 1. Store your Mana balance safely in the cloud (Firestore).
 * 2. Apply rate limits to prevent abuse.
 * 3. Keep your data private (Firestore Security Rules).
 * All without forcing you to create an account or password immediately.
 */
// Helper for functions instance - Explicitly bind to default app to ensure Auth integration
function getFunctionsInstance() {
    return getFunctions(getApp(), 'southamerica-east1');
}

export async function ensureAuthenticated(): Promise<string> {
    const auth = firebaseAuth();
    const currentUser = auth.currentUser;

    if (currentUser) {
        // Force token refresh to ensure Functions SDK picks it up
        try {
            await getIdToken(currentUser, true);
        } catch (e) {
            console.log('Firebase: Failed to refresh token, proceeding anyway', e);
        }
        return currentUser.uid;
    }

    // Sign in anonymously if not authenticated
    const result = await signInAnonymously(auth);
    console.log('Firebase: Signed in anonymously as', result.user.uid);
    return result.user.uid;
}

// Initialize App Check
async function initializeAppCheckWrapper() {
    try {
        // Activate App Check: debug provider in dev, production providers in release builds
        // @ts-ignore - Class is exported as type only in d.ts, but is a value at runtime
        const provider = new ReactNativeFirebaseAppCheckProvider();
        // Debug tokens are only used in dev builds to avoid Play Integrity rate limits.
        // Production builds use Play Integrity (Android) / App Attest (iOS).
        // Before enabling enforceAppCheck: true in Functions, register the production
        // App Check providers in Firebase Console → App Check.
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
        // We do NOT block app initialization. Functions will (hopefully) work if enforceAppCheck is false.
    }
}

// Call initialization immediately
initializeAppCheckWrapper();

// Enable Crashlytics + Analytics collection (disabled in dev to reduce noise)
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

// Get current user ID (null if not authenticated)
export function getCurrentUserId(): string | null {
    return firebaseAuth().currentUser?.uid || null;
}

// Listen to auth state changes
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

// Helper to submit a job and wait for it
// Internal Helper: Sanitize payload to remove undefined values (Firestore doesn't like them)
function sanitizePayload(payload: any): any {
    if (payload === undefined) return null;
    if (payload === null) return null;
    if (typeof payload !== 'object') return payload; // Return primitives (string, number, boolean)

    if (Array.isArray(payload)) {
        return payload.map(item => sanitizePayload(item)).filter(item => item !== undefined);
    }

    const clean: any = {};
    Object.keys(payload).forEach(key => {
        const value = sanitizePayload(payload[key]);
        if (value !== undefined) {
            clean[key] = value;
        }
    });
    return clean;
}

// Helper to submit a job and wait for it
async function submitJobAndWait(
    action: Job['action'],
    payload: any,
    options?: { onJobCreated?: (jobId: string) => void }
): Promise<GenerationResult> {
    console.log(`[DEBUG] submitJobAndWait called. Action: ${action}`);
    try {
        const userId = await ensureAuthenticated();
        console.log(`[DEBUG] UserId: ${userId}`);

        const db = firebaseFirestore();
        const jobsRef = collection(db, 'jobs');

        // Check for large media to bypass Firestore 1MB limit
        // If an image/video array exists and looks large, upload to Storage first
        const uploadIfNeeded = async (key: string, contentType: string) => {
            if (payload[key] && Array.isArray(payload[key])) {
                const totalSize = payload[key].reduce((acc: number, cur: string) => acc + (cur?.length || 0), 0);
                // If total size > 800KB, upload via Storage proxy
                if (totalSize > 800_000) {
                    console.log(`[DEBUG] Payload ${key} is large (${Math.round(totalSize / 1024)}KB). Uploading to Storage...`);
                    const uploadFn = httpsCallable(getFunctionsInstance(), 'uploadMedia');
                    const uploadResult = await uploadFn({ media: payload[key], contentType });
                    const { urls } = uploadResult.data as { urls: string[] };
                    payload[key] = urls; // Replace base64 with URLs
                    console.log(`[DEBUG] ${key} uploaded. Received ${urls.length} URLs.`);
                }
            }
        };

        await uploadIfNeeded('imagesBase64', 'image/jpeg');
        await uploadIfNeeded('videosBase64', 'video/mp4');
        await uploadIfNeeded('audiosBase64', 'audio/wav');

        const cleanPayload = sanitizePayload({ ...payload, appVersion: APP_VERSION });
        console.log(`[DEBUG] Adding doc to jobs collection with payload size: ${JSON.stringify(cleanPayload).length} chars`);

        // Create a new job document
        const jobDoc = await addDoc(jobsRef, {
            userId,
            action,
            status: 'queued',
            createdAt: serverTimestamp(),
            payload: cleanPayload
        });

        console.log(`[DEBUG] Job submitted. ID: ${jobDoc.id}. Listening...`);
        options?.onJobCreated?.(jobDoc.id);

        // Poll/Listen for completion
        return new Promise<GenerationResult>((resolve, reject) => {
            let retryCount = 0;
            const BACKOFF_CAP_MS = 30_000;
            const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
            const startedAt = Date.now();
            let unsubscribe: (() => void) | null = null;

            const listen = () => {
                if (unsubscribe) unsubscribe();
                console.log(`[DEBUG] Setting up onSnapshot for ${jobDoc.id} (retry ${retryCount})`);
                unsubscribe = onSnapshot(jobDoc, (snapshot) => {
                    console.log(`[DEBUG] Snapshot update for ${jobDoc.id}. Exists? ${snapshot.exists()}`);
                    const data = snapshot.data() as Job | undefined;
                    if (!data) {
                        console.log(`[DEBUG] No data in snapshot.`);
                        return;
                    }
                    console.log(`[DEBUG] Job Status: ${data.status}`);

                    if (data.status === 'completed' && data.result) {
                        console.log(`[DEBUG] Job completed!`);
                        unsubscribe?.();
                        const finalText = decompressContent(data.result.text);
                        resolve({
                            text: finalText,
                            usage: data.result.usage || { promptTokens: 0, responseTokens: 0, totalTokens: 0 },
                            creditsUsed: data.result.creditsUsed || 0,
                            creditsRemaining: data.result.creditsRemaining || 0
                        });
                    } else if (data.status === 'failed') {
                        console.log(`[DEBUG] Job failed: ${data.error}`);
                        unsubscribe?.();
                        reject(new Error(data.error || 'Job failed unknown error'));
                    }
                }, async (error) => {
                    console.log('[DEBUG] Job listener error:', error);

                    if ((error as any).code !== 'unavailable') {
                        reject(error);
                        return;
                    }

                    const elapsed = Date.now() - startedAt;
                    if (elapsed >= TOTAL_TIMEOUT_MS) {
                        console.log('[DEBUG] Timeout atingido. Tentando getDoc de resgate...');
                        try {
                            const snap = await getDoc(jobDoc);
                            const d = snap.data() as Job | undefined;
                            if (d?.status === 'completed' && d.result) {
                                console.log('[DEBUG] Resgate: job já estava completo, recuperando resultado');
                                const finalText = decompressContent(d.result.text);
                                resolve({
                                    text: finalText,
                                    usage: d.result.usage || { promptTokens: 0, responseTokens: 0, totalTokens: 0 },
                                    creditsUsed: d.result.creditsUsed || 0,
                                    creditsRemaining: d.result.creditsRemaining || 0
                                });
                                return;
                            } else if (d?.status === 'failed') {
                                reject(new Error(d?.error || 'Job failed'));
                                return;
                            }
                        } catch (fetchErr) {
                            console.log('[DEBUG] getDoc de resgate também falhou:', fetchErr);
                        }
                        reject(error);
                        return;
                    }

                    retryCount++;
                    const delay = Math.min(Math.pow(2, retryCount) * 1000, BACKOFF_CAP_MS);
                    console.log(`[DEBUG] UNAVAILABLE — retry em ${delay}ms (total elapsed: ${Math.round(elapsed / 1000)}s)`);
                    setTimeout(listen, delay);
                });
            };

            listen();
        });
    } catch (e) {
        console.log('[DEBUG] submitJobAndWait CRITICAL ERROR:', e);
        throw e;
    }
}

// Generate a new spell (create app) - ASYNC
export async function generateSpellCreate(prompt: string): Promise<GenerationResult> {
    return submitJobAndWait('create', {
        prompt: compressContent(prompt)
    });
}

// ...

export async function generateSpellEdit(
    currentCode: string,
    instruction: string,
    options?: {
        previousEdits?: PreviousEdit[];
        selectedContext?: string;
    }
): Promise<GenerationResult> {
    return submitJobAndWait('edit', {
        currentCode: compressContent(currentCode),
        instruction: compressContent(instruction),
        previousEdits: options?.previousEdits,
        selectedContext: options?.selectedContext ? compressContent(options.selectedContext) : undefined,
    });
}

// Convert
export async function generateSpellConvert(
    sourceCode: string,
    frameworkHint?: string
): Promise<GenerationResult> {
    return submitJobAndWait('convert', {
        sourceCode: compressContent(sourceCode),
        frameworkHint,
    });
}

// App Icon / Logo Generation (fixed cost: 0.5 mana)
export async function generateSpellLogoGen(
    prompt: string
): Promise<GenerationResult> {
    return submitJobAndWait('app_icon', {
        prompt: compressContent(prompt),
    });
}

// WebView AI
export async function generateSpellWebviewAI(
    prompt: string,
    options?: {
        schema?: object;
        imagesBase64?: string[];
        videosBase64?: string[];
        audiosBase64?: string[];
        useSearch?: boolean;
        onJobCreated?: (jobId: string) => void;
    }
): Promise<GenerationResult> {
    return submitJobAndWait('webview_ai', {
        prompt: compressContent(prompt),
        schema: options?.schema,
        imagesBase64: options?.imagesBase64,
        videosBase64: options?.videosBase64,
        audiosBase64: options?.audiosBase64,
        useSearch: options?.useSearch,
    }, { onJobCreated: options?.onJobCreated });
}

// Similarity (embedding-based)
export async function generateSpellSimilarity(
    items: string[],
    onJobCreated?: (jobId: string) => void
): Promise<GenerationResult> {
    return submitJobAndWait('webview_ai_similarity', { items }, { onJobCreated });
}

// Image Generation via Gemini
export async function generateSpellImageGen(
    prompt: string,
    imagesBase64?: string[],
    onJobCreated?: (jobId: string) => void
): Promise<GenerationResult> {
    return submitJobAndWait('webview_ai_image', {
        prompt: compressContent(prompt),
        imagesBase64,
    }, { onJobCreated });
}

// TTS Generation via Gemini TTS
export async function generateSpellTTS(
    text: string,
    voiceName?: string,
    onJobCreated?: (jobId: string) => void
): Promise<GenerationResult> {
    return submitJobAndWait('webview_ai_tts', {
        prompt: compressContent(text),
        voiceName: voiceName || 'Aoede',
    }, { onJobCreated });
}

// Video Generation via Veo
export async function generateSpellVideoGen(
    prompt: string,
    imagesBase64?: string[],
    onJobCreated?: (jobId: string) => void
): Promise<GenerationResult> {
    return submitJobAndWait('webview_ai_video', {
        prompt: compressContent(prompt),
        imagesBase64,
    }, { onJobCreated });
}

// Attach to an existing job and wait for its completion (used for recovery after reload)
export async function waitForExistingJob(jobId: string): Promise<GenerationResult> {
    await ensureAuthenticated();
    const firestoreDb = firebaseFirestore();
    const jobDocRef = doc(firestoreDb, 'jobs', jobId);

    return new Promise<GenerationResult>((resolve, reject) => {
        let retryCount = 0;
        const BACKOFF_CAP_MS = 30_000;
        const TOTAL_TIMEOUT_MS = 15 * 60 * 1000;
        const startedAt = Date.now();
        let unsubscribe: (() => void) | null = null;

        const listen = () => {
            if (unsubscribe) unsubscribe();
            unsubscribe = onSnapshot(jobDocRef, (snapshot) => {
                const data = snapshot.data() as Job | undefined;
                if (!data) return;

                if (data.status === 'completed' && data.result) {
                    unsubscribe?.();
                    const finalText = decompressContent(data.result.text);
                    resolve({
                        text: finalText,
                        usage: data.result.usage || { promptTokens: 0, responseTokens: 0, totalTokens: 0 },
                        creditsUsed: data.result.creditsUsed || 0,
                        creditsRemaining: data.result.creditsRemaining || 0,
                    });
                } else if (data.status === 'failed') {
                    unsubscribe?.();
                    reject(new Error(data.error || 'Job failed'));
                }
            }, async (error) => {
                if ((error as any).code !== 'unavailable') {
                    reject(error);
                    return;
                }
                const elapsed = Date.now() - startedAt;
                if (elapsed >= TOTAL_TIMEOUT_MS) {
                    try {
                        const snap = await getDoc(jobDocRef);
                        const d = snap.data() as Job | undefined;
                        if (d?.status === 'completed' && d.result) {
                            const finalText = decompressContent(d.result.text);
                            resolve({
                                text: finalText,
                                usage: d.result.usage || { promptTokens: 0, responseTokens: 0, totalTokens: 0 },
                                creditsUsed: d.result.creditsUsed || 0,
                                creditsRemaining: d.result.creditsRemaining || 0,
                            });
                            return;
                        } else if (d?.status === 'failed') {
                            reject(new Error(d?.error || 'Job failed'));
                            return;
                        }
                    } catch {}
                    reject(error);
                    return;
                }
                retryCount++;
                const delay = Math.min(Math.pow(2, retryCount) * 1000, BACKOFF_CAP_MS);
                setTimeout(listen, delay);
            });
        };

        listen();
    });
}

// Credits
export async function getCredits(): Promise<number> {
    await ensureAuthenticated();

    const getCreditsFunc = httpsCallable<void, CreditsResult>(getFunctionsInstance(), 'getCredits');
    const result = await getCreditsFunc();

    return result.data.credits;
}

export async function suggestSpells(query: string): Promise<Array<{ title: string; description: string }>> {
    await ensureAuthenticated();
    const { getCurrentLanguage } = require('./i18n');
    const language = getCurrentLanguage();
    const fn = httpsCallable<{ query: string; language: string }, { suggestions: Array<{ title: string; description: string }> }>(
        getFunctionsInstance(), 'suggestSpells'
    );
    const result = await fn({ query, language });
    return result.data.suggestions;
}

export async function claimInstallBonus(hardwareId: string): Promise<{ granted: boolean; newBalance?: number; bonusAmount?: number }> {
    const fn = httpsCallable<{ hardwareId: string }, { granted: boolean; newBalance?: number; bonusAmount?: number }>(
        getFunctionsInstance(), 'claimInstallBonus'
    );
    const result = await fn({ hardwareId });
    return result.data;
}

export async function estimateManaCost(type: string, data: any): Promise<{ mana: string; value: number }> {
    const fn = httpsCallable<{ type: string; data: any }, { mana: string; value: number }>(
        getFunctionsInstance(), 'estimateManaCost'
    );
    const result = await fn({ type, data });
    return result.data;
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

export interface SyncedSpellItem {
    spellId: string;
    slug: string;
    name: string;
    description: string;
    iconPath: string | null;
    authorName: string;
    publishedVersion: number;
    signedHtmlUrl: string;
    originalLang?: string;
    translations?: Record<string, { name: string; description: string }>;
    forkOfSpellId?: string | null;
    rootSpellId?: string;
}

export async function syncLearnedSpells(): Promise<{ spells: SyncedSpellItem[] }> {
    await ensureAuthenticated();
    const fn = httpsCallable<void, { spells: SyncedSpellItem[] }>(
        getFunctionsInstance(), 'syncLearnedSpells'
    );
    const result = await fn();
    return result.data;
}

export async function markSpellSynced(
    spellId: string,
    localAppId: number | null,
    syncedToApp: boolean
): Promise<{ success: boolean }> {
    await ensureAuthenticated();
    const fn = httpsCallable<{ spellId: string; localAppId: number | null; syncedToApp: boolean }, { success: boolean }>(
        getFunctionsInstance(), 'markSpellSynced'
    );
    const result = await fn({ spellId, localAppId, syncedToApp });
    return result.data;
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

export async function addCredits(amount: number, source: string, purchaseToken?: string): Promise<AddCreditsResult> {
    await ensureAuthenticated();

    console.log('[Firebase] Calling addCredits...', amount, source);
    try {
        const addCreditsFunc = httpsCallable<{ amount: number; source: string; purchaseToken?: string }, AddCreditsResult>(getFunctionsInstance(), 'addCredits');
        const result = await addCreditsFunc({ amount, source, ...(purchaseToken ? { purchaseToken } : {}) });
        console.log('[Firebase] addCredits success');
        return result.data;
    } catch (e: any) {
        console.error('[Firebase] addCredits ERROR:', e.code, e.message, e.details);
        throw e;
    }
}

export async function voidPurchase(purchaseToken: string, productId: string): Promise<{ success: boolean }> {
    await ensureAuthenticated();

    console.log('[Firebase] Calling voidPurchase...', productId);
    try {
        const voidPurchaseFunc = httpsCallable<{ purchaseToken: string; productId: string }, { success: boolean }>(getFunctionsInstance(), 'voidPurchase');
        const result = await voidPurchaseFunc({ purchaseToken, productId });
        console.log('[Firebase] voidPurchase success');
        return result.data;
    } catch (e: any) {
        console.error('[Firebase] voidPurchase ERROR:', e.code, e.message, e.details);
        throw e;
    }
}

// Listen to credits changes in real-time
export function onCreditsChanged(callback: (credits: number) => void, explicitUserId?: string): () => void {
    const userId = explicitUserId || getCurrentUserId();
    if (!userId) {
        console.warn('Firebase: Cannot listen to credits - not authenticated');
        return () => { };
    }

    const db = firebaseFirestore();
    const userDocRef = doc(collection(db, 'users'), userId);

    // In modular SDK, onSnapshot is a top-level function that takes the reference
    const unsubscribe = onSnapshot(userDocRef, (docSnapshot) => {
        const credits = docSnapshot.data()?.credits || 0;
        console.log('Firebase: Real-time credit update:', credits);
        callback(credits);
    }, (error: any) => {
        // permission-denied is expected briefly during auth state transitions (e.g. anonymous→Google link)
        if (error.code === 'firestore/permission-denied') {
            console.warn('Firebase: Credits listener permission-denied (auth transition, will auto-recover)');
        } else {
            console.error('Firebase: Error listening to credits:', error);
        }
    });

    return unsubscribe;
}

// Generate a unique Job ID locally before submission
export function generateJobId(): string {
    const db = firebaseFirestore();
    return doc(collection(db, 'jobs')).id;
}

// Submit a job without waiting (Fire & Forget)
export async function submitJob(action: Job['action'], payload: any, providedJobId?: string): Promise<string> {
    console.log(`[Firebase] submitJob called. Action: ${action}${providedJobId ? ` (ID: ${providedJobId})` : ''}`);
    try {
        const userId = await ensureAuthenticated();
        const db = firebaseFirestore();
        const jobsRef = collection(db, 'jobs');

        const cleanPayload = sanitizePayload({ ...payload, appVersion: APP_VERSION });

        const jobId = providedJobId || doc(jobsRef).id;
        const jobDoc = doc(jobsRef, jobId);

        await setDoc(jobDoc, {
            userId,
            action,
            status: 'queued',
            createdAt: serverTimestamp(),
            payload: cleanPayload
        });

        console.log(`[Firebase] Job submitted. ID: ${jobId}`);
        return jobId;
    } catch (e) {
        console.error('[Firebase] submitJob failed:', e);
        throw e;
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

// Configure Google Sign-In
GoogleSignin.configure({
    scopes: ['https://www.googleapis.com/auth/drive.appdata'],
    webClientId: '901177243529-0vod4amdjigg9bvve0h1ebaa609hpdba.apps.googleusercontent.com',
    offlineAccess: true,
    hostedDomain: '',
    forceCodeForRefreshToken: true,
    accountName: '',
});

// Import GoogleAuthProvider
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
        const user = firebaseAuth().currentUser;

        if (user) {
            try {
                return await linkWithCredential(user, googleCredential);
            } catch (linkError: any) {
                if (linkError.code === 'auth/credential-already-in-use') {
                    // Account already exists — sign in directly with the same credential
                    return await signInWithCredential(firebaseAuth(), googleCredential);
                }
                throw linkError;
            }
        } else {
            throw new Error('No current user to link');
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

// Re-export existing listeners
// Listen to active/recent jobs for the current user
export function listenToActiveJobs(callback: (jobs: Job[]) => void): () => void {
    let unsubscribeFirestore: (() => void) | null = null;

    // Listen to Auth State to set up Firestore listener
    const unsubscribeAuth = onAuthStateChangedModular(firebaseAuth(), (user) => {
        // Cleanup previous listener if user changed
        if (unsubscribeFirestore) {
            unsubscribeFirestore();
            unsubscribeFirestore = null;
        }

        if (user) {
            console.log('[Firebase] listenToActiveJobs: User authenticated, setting up listener.', user.uid);
            const db = firebaseFirestore();
            const jobsRef = collection(db, 'jobs');

            const q = query(
                jobsRef,
                where('userId', '==', user.uid),
                orderBy('createdAt', 'desc'),
                limit(10)
            );

            unsubscribeFirestore = onSnapshot(q, (snapshot) => {
                const jobs: Job[] = [];
                snapshot.forEach((doc: any) => {
                    const data = doc.data();
                    jobs.push({
                        id: doc.id,
                        userId: data.userId,
                        action: data.action,
                        status: data.status,
                        createdAt: data.createdAt,
                        result: data.result,
                        error: data.error,
                        payload: data.payload,
                    });
                });
                console.log(`[Firebase] Active jobs updated: ${jobs.length}`);
                callback(jobs);
            }, (error) => {
                console.error('Firebase: Error listening to jobs:', error);
            });
        } else {
            console.log('[Firebase] listenToActiveJobs: No user, clearing jobs.');
            callback([]);
        }
    });

    // Return a function that unsubscribes both
    return () => {
        unsubscribeAuth();
        if (unsubscribeFirestore) unsubscribeFirestore();
    };
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
