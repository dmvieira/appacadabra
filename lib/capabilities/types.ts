/**
 * Core types for the capability module system.
 *
 * Each CapabilityModule is the single source of truth for one API group:
 * - docs        → goes into the AI system instructions (Firebase side)
 * - getInjectedJS → the WebView JS implementation (RN app side)
 * - handleMessage → the native message handler (RN app side)
 */

export interface ManifestBlock {
    /** Anchor comment placeholder, e.g. <!-- CAPABILITY:health:queries:anchor --> */
    anchor: string;
    /** XML content to expand in place of the anchor when capability is enabled. */
    xml: string;
}

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
    isEditMode?: boolean;
}

export interface HandlerResult {
    success: boolean;
    result: any;
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
    /**
     * Android permissions required by this capability.
     * Synced to app.json and AndroidManifest.xml by `npm run sync-capabilities`.
     * Full permission string, e.g. "android.permission.CAMERA"
     */
    androidPermissions?: string[];
    /**
     * Android manifest blocks required by this capability.
     * Synced to AndroidManifest.xml by `npm run sync-capabilities`.
     * Each block is a pair of anchor (placeholder) and XML content.
     */
    manifestBlocks?: ManifestBlock[];
    /** One-sentence summary used by the planner to select this capability. Copied to Firebase by the sync script. */
    description: string;
    /** AI documentation block — copied to Firebase by the sync script. */
    docs: string;
    /** JS snippet injected into the JSDOM validation sandbox — copied to Firebase by the sync script. */
    validationMock: string;
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
    /**
     * Optional cleanup method called when the app minimizes or the WebView unmounts.
     * Use this to stop active media, sensors, or timers.
     */
    cleanup?: () => Promise<void>;
}
