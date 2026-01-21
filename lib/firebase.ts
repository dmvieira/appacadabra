import auth from '@react-native-firebase/auth';
import { getFunctions, httpsCallable } from '@react-native-firebase/functions';
import firestore from '@react-native-firebase/firestore';
import firebase from '@react-native-firebase/app';
import appCheck from '@react-native-firebase/app-check'; // Import default

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
    return getFunctions(firebase.app(), 'southamerica-east1');
}

export async function ensureAuthenticated(): Promise<string> {
    const currentUser = auth().currentUser;

    if (currentUser) {
        // Force token refresh to ensure Functions SDK picks it up
        try {
            await currentUser.getIdToken(true);
        } catch (e) {
            console.log('Firebase: Failed to refresh token, proceeding anyway', e);
        }
        return currentUser.uid;
    }

    // Sign in anonymously if not authenticated
    const result = await auth().signInAnonymously();
    console.log('Firebase: Signed in anonymously as', result.user.uid);
    return result.user.uid;
}

// Initialize App Check
async function initializeAppCheck() {
    try {
        // Activate App Check with Debug provider
        // Using the injected CI token from MainApplication.kt
        await appCheck().activate('debug', true);
        console.log('Firebase: App Check activated (Debug Mode with CI Token)');
    } catch (e) {
        console.error('Firebase: App Check activation failed', e);
    }
}

// Call initialization immediately
initializeAppCheck();

// Get current user ID (null if not authenticated)
export function getCurrentUserId(): string | null {
    return auth().currentUser?.uid || null;
}

// Listen to auth state changes
export function onAuthStateChanged(callback: (userId: string | null) => void): () => void {
    return auth().onAuthStateChanged((user) => {
        callback(user?.uid || null);
    });
}

// Generate a new spell (create app)
export async function generateSpellCreate(prompt: string): Promise<GenerationResult> {
    await ensureAuthenticated();

    console.log('[Firebase] Calling generateSpellCreate...');
    try {
        const generateSpell = httpsCallable<any, GenerationResult>(getFunctionsInstance(), 'generateSpell');
        const result = await generateSpell({
            action: 'create',
            prompt,
        });
        console.log('[Firebase] generateSpellCreate success');
        return result.data;
    } catch (e: any) {
        console.error('[Firebase] generateSpellCreate ERROR:', e.code, e.message, e.details);
        throw e;
    }
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
    await ensureAuthenticated();

    const generateSpell = httpsCallable<any, GenerationResult>(getFunctionsInstance(), 'generateSpell');
    const result = await generateSpell({
        action: 'edit',
        currentCode,
        instruction,
        previousEdits: options?.previousEdits,
        selectedContext: options?.selectedContext,
    });

    return result.data;
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
        sourceCode,
        frameworkHint,
    });

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
        prompt,
        ...options,
    });

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

    const unsubscribe = firestore()
        .collection('users')
        .doc(userId)
        .onSnapshot((doc) => {
            const credits = doc.data()?.credits || 0;
            console.log('Firebase: Real-time credit update:', credits);
            callback(credits);
        }, (error) => {
            console.error('Firebase: Error listening to credits:', error);
        });

    return unsubscribe;
}
