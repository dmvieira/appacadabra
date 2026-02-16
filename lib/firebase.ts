import { getAuth, signInAnonymously, onAuthStateChanged as onAuthStateChangedModular, getIdToken } from '@react-native-firebase/auth';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import { getFirestore, doc, collection, onSnapshot, addDoc, serverTimestamp, query, where, orderBy, limit } from '@react-native-firebase/firestore';
import { getApp } from '@react-native-firebase/app';
// @ts-ignore - Index.d.ts exports class as type, but it is a value in runtime. Import from root to ensure module registration.
import { initializeAppCheck, ReactNativeFirebaseAppCheckProvider } from '@react-native-firebase/app-check';
import Constants from 'expo-constants';
import pako from 'pako';

const APP_VERSION = Constants.expoConfig?.version || '1.0.0';

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
    action: 'create' | 'edit';
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
    const auth = getAuth();
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
        // Activate App Check with Debug provider
        // Using the injected CI token from MainApplication.kt
        // @ts-ignore - Class is exported as type only in d.ts, but is a value at runtime
        const provider = new ReactNativeFirebaseAppCheckProvider();
        provider.configure({
            android: {
                provider: 'debug',
            },
            apple: {
                provider: 'debug',
            },
            web: {
                provider: 'reCaptchaV3',
                siteKey: 'none',
            },
        });

        await initializeAppCheck(getApp(), {
            provider,
            isTokenAutoRefreshEnabled: true,
        });
        console.log('Firebase: App Check activated (Debug Mode with CI Token)');
    } catch (e) {
        console.error('Firebase: App Check activation failed', e);
    }
}

// Call initialization immediately
initializeAppCheckWrapper();

// Get current user ID (null if not authenticated)
export function getCurrentUserId(): string | null {
    return getAuth().currentUser?.uid || null;
}

// Listen to auth state changes
export function onAuthStateChanged(callback: (userId: string | null) => void): () => void {
    const auth = getAuth();
    return onAuthStateChangedModular(auth, (user) => {
        callback(user?.uid || null);
    });
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
async function submitJobAndWait(action: 'create' | 'edit', payload: any): Promise<GenerationResult> {
    console.error(`[DEBUG] submitJobAndWait called. Action: ${action}`);
    try {
        const userId = await ensureAuthenticated();
        console.error(`[DEBUG] UserId: ${userId}`);

        const db = getFirestore();
        const jobsRef = collection(db, 'jobs');

        const cleanPayload = sanitizePayload({ ...payload, appVersion: APP_VERSION });
        console.error(`[DEBUG] Adding doc to jobs collection with payload:`, JSON.stringify(cleanPayload));

        // Create a new job document
        const jobDoc = await addDoc(jobsRef, {
            userId,
            action,
            status: 'queued',
            createdAt: serverTimestamp(),
            payload: cleanPayload
        });

        console.error(`[DEBUG] Job submitted. ID: ${jobDoc.id}. Listening...`);

        // Poll/Listen for completion
        return new Promise<GenerationResult>((resolve, reject) => {
            console.error(`[DEBUG] Setting up onSnapshot for ${jobDoc.id}`);
            const unsubscribe = onSnapshot(jobDoc, (snapshot) => {
                console.error(`[DEBUG] Snapshot update for ${jobDoc.id}. Exists? ${snapshot.exists()}`);
                const data = snapshot.data() as Job | undefined;
                if (!data) {
                    console.error(`[DEBUG] No data in snapshot.`);
                    return;
                }

                console.error(`[DEBUG] Job Status: ${data.status}`);

                if (data.status === 'completed' && data.result) {
                    console.error(`[DEBUG] Job completed!`);
                    unsubscribe();

                    // Process result
                    const finalText = decompressContent(data.result.text);
                    resolve({
                        text: finalText,
                        usage: data.result.usage || { promptTokens: 0, responseTokens: 0, totalTokens: 0 },
                        creditsUsed: data.result.creditsUsed || 0,
                        creditsRemaining: data.result.creditsRemaining || 0
                    });
                } else if (data.status === 'failed') {
                    console.error(`[DEBUG] Job failed: ${data.error}`);
                    unsubscribe();
                    reject(new Error(data.error || 'Job failed unknown error'));
                }
            }, (error) => {
                console.error('[DEBUG] Job listener error:', error);
                reject(error);
            });
        });
    } catch (e) {
        console.error('[DEBUG] submitJobAndWait CRITICAL ERROR:', e);
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
    await ensureAuthenticated();

    const generateSpell = httpsCallable<any, GenerationResult>(getFunctionsInstance(), 'generateSpell');
    const result = await generateSpell({
        action: 'convert',
        sourceCode: compressContent(sourceCode), // Compress source (zip base64 or huge text)
        frameworkHint,
        appVersion: APP_VERSION,
    });

    if (result.data && result.data.text) {
        result.data.text = decompressContent(result.data.text);
    }
    return result.data;
}

// WebView AI
export async function generateSpellWebviewAI(
    prompt: string,
    options?: {
        schema?: object;
        imageBase64?: string;
        audioBase64?: string;
        useSearch?: boolean;
    }
): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = httpsCallable<any, GenerationResult>(getFunctionsInstance(), 'generateSpell');
    const result = await generateSpell({
        action: 'webview_ai',
        prompt: compressContent(prompt),
        appVersion: APP_VERSION,
        ...options,
    });

    if (result.data && result.data.text) {
        result.data.text = decompressContent(result.data.text);
    }
    return result.data;
}

// Image Generation via Gemini
export async function generateSpellImageGen(
    prompt: string
): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = httpsCallable<any, GenerationResult>(getFunctionsInstance(), 'generateSpell');
    const result = await generateSpell({
        action: 'webview_ai_image',
        prompt: compressContent(prompt),
        appVersion: APP_VERSION,
    });

    if (result.data && result.data.text) {
        result.data.text = decompressContent(result.data.text);
    }
    return result.data;
}

// Credits
export async function getCredits(): Promise<number> {
    await ensureAuthenticated();

    const getCreditsFunc = httpsCallable<void, CreditsResult>(getFunctionsInstance(), 'getCredits');
    const result = await getCreditsFunc();

    return result.data.credits;
}

export async function addCredits(amount: number, source: string): Promise<AddCreditsResult> {
    await ensureAuthenticated();

    console.log('[Firebase] Calling addCredits...', amount, source);
    try {
        const addCreditsFunc = httpsCallable<{ amount: number; source: string }, AddCreditsResult>(getFunctionsInstance(), 'addCredits');
        const result = await addCreditsFunc({ amount, source });
        console.log('[Firebase] addCredits success');
        return result.data;
    } catch (e: any) {
        console.error('[Firebase] addCredits ERROR:', e.code, e.message, e.details);
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

    const db = getFirestore();
    const userDocRef = doc(collection(db, 'users'), userId);

    // In modular SDK, onSnapshot is a top-level function that takes the reference
    const unsubscribe = onSnapshot(userDocRef, (docSnapshot) => {
        const credits = docSnapshot.data()?.credits || 0;
        console.log('Firebase: Real-time credit update:', credits);
        callback(credits);
    }, (error) => {
        console.error('Firebase: Error listening to credits:', error);
    });

    return unsubscribe;
}

// Submit a job without waiting (Fire & Forget)
export async function submitJob(action: 'create' | 'edit', payload: any): Promise<string> {
    console.log(`[Firebase] submitJob called. Action: ${action}`);
    try {
        const userId = await ensureAuthenticated();
        const db = getFirestore();
        const jobsRef = collection(db, 'jobs');

        const cleanPayload = sanitizePayload({ ...payload, appVersion: APP_VERSION });

        const jobDoc = await addDoc(jobsRef, {
            userId,
            action,
            status: 'queued',
            createdAt: serverTimestamp(),
            payload: cleanPayload
        });

        console.log(`[Firebase] Job submitted. ID: ${jobDoc.id}`);
        return jobDoc.id;
    } catch (e) {
        console.error('[Firebase] submitJob failed:', e);
        throw e;
    }
}

import { GoogleSignin, statusCodes } from '@react-native-google-signin/google-signin';

// Configure Google Sign-In
GoogleSignin.configure({
    // scopes: ['https://www.googleapis.com/auth/drive.readonly'], // what API you want to access on behalf of the user, default is email and profile
    webClientId: '225682663252-klc02t354256225 56252.apps.googleusercontent.com', // client ID of type WEB for your server (needed to verify user ID and offline access)
    offlineAccess: true, // if you want to access Google API on behalf of the user FROM YOUR SERVER
    hostedDomain: '', // specifies a hosted domain restriction
    forceCodeForRefreshToken: true, // [Android] related to offlineAccess
    accountName: '', // [Android] specifies an account name on the device that should be used
    // iosClientId: '<FROM DEVELOPER CONSOLE>', // [iOS] if you want to specify the client ID of type iOS (otherwise, it is taken from GoogleService-Info.plist)
    // googleServicePlistPath: '', // [iOS] if you renamed your GoogleService-Info file, new name here, e.g. GoogleService-Info-Staging
    // openIdRealm: '', // [iOS] The OpenID2 realm of the home web server. This allows Google to include the user's OpenID Identifier in the OpenID Connect ID token.
    // profileImageSize: 120, // [iOS] The desired height (and width) of the profile image. Defaults to 120px
});

// Import GoogleAuthProvider
import { GoogleAuthProvider, linkWithCredential, signInWithCredential } from '@react-native-firebase/auth';

export async function signInWithGoogle() {
    try {
        await GoogleSignin.hasPlayServices();
        const userInfo = await GoogleSignin.signIn();
        const { idToken } = await GoogleSignin.getTokens(); // Fix: use getTokens() or userInfo.idToken depending on version. 
        // Note: userInfo might not contain idToken in newer versions or without webClientId configured properly.
        // It's safer to use getTokens() if available, or userInfo.idToken.
        // Actually, userInfo usually has idToken if webClientId is correct.

        if (!idToken) throw new Error('No ID token found');

        const googleCredential = GoogleAuthProvider.credential(idToken);
        return getAuth().signInWithCredential(googleCredential);
    } catch (error) {
        console.error('Google Sign-In Error', error);
        throw error;
    }
}

export async function linkWithGoogle() {
    try {
        await GoogleSignin.hasPlayServices();
        const userInfo = await GoogleSignin.signIn();
        const { idToken } = await GoogleSignin.getTokens(); // Try getTokens first

        if (!idToken) throw new Error('No ID token found from Google Sign-In');

        const googleCredential = GoogleAuthProvider.credential(idToken);
        const user = getAuth().currentUser;

        if (user) {
            return await linkWithCredential(user, googleCredential);
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
        await GoogleSignin.signOut();
        await getAuth().signOut();
    } catch (error) {
        console.error('Sign Out Error', error);
    }
}

export function getCurrentUser() {
    return getAuth().currentUser;
}

// Re-export existing listeners
// Listen to active/recent jobs for the current user
export function listenToActiveJobs(callback: (jobs: Job[]) => void): () => void {
    let unsubscribeFirestore: (() => void) | null = null;

    // Listen to Auth State to set up Firestore listener
    const unsubscribeAuth = onAuthStateChangedModular(getAuth(), (user) => {
        // Cleanup previous listener if user changed
        if (unsubscribeFirestore) {
            unsubscribeFirestore();
            unsubscribeFirestore = null;
        }

        if (user) {
            console.log('[Firebase] listenToActiveJobs: User authenticated, setting up listener.', user.uid);
            const db = getFirestore();
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
