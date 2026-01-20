/**
 * Firebase integration for Appacadabra
 * Uses @react-native-firebase for native integration
 */

import auth from '@react-native-firebase/auth';
import functions from '@react-native-firebase/functions';
import firestore from '@react-native-firebase/firestore';

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

// Ensure user is authenticated (anonymous auth)
export async function ensureAuthenticated(): Promise<string> {
    const currentUser = auth().currentUser;

    if (currentUser) {
        return currentUser.uid;
    }

    // Sign in anonymously if not authenticated
    const result = await auth().signInAnonymously();
    console.log('Firebase: Signed in anonymously as', result.user.uid);
    return result.user.uid;
}

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

// ============= AI Functions =============

// Generate a new spell (create app)
export async function generateSpellCreate(prompt: string): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = functions().httpsCallable<any, GenerationResult>('generateSpell');
    const result = await generateSpell({
        action: 'create',
        prompt,
    });

    return result.data;
}

// Edit an existing spell (with history tracking)
export interface PreviousEdit {
    version: number;
    instruction: string;
}

export async function generateSpellEdit(
    currentCode: string,
    instruction: string,
    options?: {
        previousEdits?: PreviousEdit[];
        selectedContext?: string;
    }
): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = functions().httpsCallable<any, GenerationResult>('generateSpell');
    const result = await generateSpell({
        action: 'edit',
        currentCode,
        instruction,
        previousEdits: options?.previousEdits,
        selectedContext: options?.selectedContext,
    });

    return result.data;
}

// Convert a project (Node/React) to standalone HTML
export async function generateSpellConvert(
    sourceCode: string,
    frameworkHint?: string
): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = functions().httpsCallable<any, GenerationResult>('generateSpell');
    const result = await generateSpell({
        action: 'convert',
        sourceCode,
        frameworkHint,
    });

    return result.data;
}

// WebView AI call (basic generation)
export async function generateSpellWebviewAI(
    prompt: string,
    options?: {
        schema?: object;
        imageBase64?: string;
        audioBase64?: string;
    }
): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = functions().httpsCallable<any, GenerationResult>('generateSpell');
    const result = await generateSpell({
        action: 'webview_ai',
        prompt,
        ...options,
    });

    return result.data;
}

// WebView AI call with Google Search
export async function generateSpellWebviewAISearch(prompt: string): Promise<GenerationResult> {
    await ensureAuthenticated();

    const generateSpell = functions().httpsCallable<any, GenerationResult>('generateSpell');
    const result = await generateSpell({
        action: 'webview_ai_search',
        prompt,
    });

    return result.data;
}

// ============= Credits Functions =============

// Get current credits balance
export async function getCredits(): Promise<number> {
    await ensureAuthenticated();

    const getCreditsFunc = functions().httpsCallable<void, CreditsResult>('getCredits');
    const result = await getCreditsFunc();

    return result.data.credits;
}

// Add credits (for ad rewards)
export async function addCredits(amount: number, source: string): Promise<AddCreditsResult> {
    await ensureAuthenticated();

    const addCreditsFunc = functions().httpsCallable<{ amount: number; source: string }, AddCreditsResult>('addCredits');
    const result = await addCreditsFunc({ amount, source });

    return result.data;
}

// Listen to credits changes in real-time
export function onCreditsChanged(callback: (credits: number) => void): () => void {
    const userId = getCurrentUserId();
    if (!userId) {
        console.warn('Firebase: Cannot listen to credits - not authenticated');
        return () => { };
    }

    const unsubscribe = firestore()
        .collection('users')
        .doc(userId)
        .onSnapshot((doc) => {
            const credits = doc.data()?.credits || 0;
            callback(credits);
        }, (error) => {
            console.error('Firebase: Error listening to credits:', error);
        });

    return unsubscribe;
}
