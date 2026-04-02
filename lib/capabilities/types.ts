/**
 * Core types for the capability module system.
 *
 * Each CapabilityModule is the single source of truth for one API group:
 * - docs        → goes into the AI system instructions (Firebase side)
 * - getInjectedJS → the WebView JS implementation (RN app side)
 * - handleMessage → the native message handler (RN app side)
 */

/** Lightweight version of the WebView ref so this file stays free of RN imports. */
export interface WebViewRef {
    current: {
        injectJavaScript: (script: string) => void;
    } | null;
}

export interface HandlerContext {
    webViewRef: WebViewRef;
    viewContainerRef?: { current: any | null };
    appId: number | null;
    callbackName?: string;
    onJobCreated?: (jobId: string) => void;
}

export interface HandlerResult {
    success: boolean;
    result: string;
    handled: boolean;
    deferredCallback?: boolean;
    creditsUsed?: number;
    isFirstAiUse?: boolean;
}

export interface CapabilityModule {
    /** Unique identifier, also used as the generated file name (e.g. "calendar"). */
    id: string;
    /** Human-readable name for display/logging. */
    displayName: string;
    /**
     * Minimum app version that supports this capability (semver).
     * Firebase uses this to gate the docs sent to the AI per user's app version.
     */
    minVersion: string;
    /** AI documentation block — copied to Firebase by the sync script. */
    docs: string;
    /**
     * Returns the JavaScript block to inject into the WebView for this capability.
     * Receives appId and isEditMode so the JS can behave accordingly.
     */
    getInjectedJS: (appId: number, isEditMode: boolean) => string;
    /**
     * Handles a native bridge message for this capability.
     * Returns null if this capability does not own the given message type,
     * allowing the next delegate to handle it.
     */
    handleMessage: (type: string, data: any, ctx: HandlerContext) => Promise<Partial<HandlerResult> | null>;
}
