import { requireNativeModule, EventEmitter } from 'expo-modules-core';

export type SharedContent = {
    mimeType: string;
    uri?: string;
    text?: string;
    fileName?: string;
    isMultiple?: boolean; // For future support
};

// It loads the native module object from the JSI or falls back to
// the bridge module (from NativeModulesProxy) if the remote debugger is on.
const ShareIntentModule = requireNativeModule('ShareIntent');

const emitter = new EventEmitter<{
    onShareReceived: (event: SharedContent) => void;
}>(ShareIntentModule);

export function getSharedContent(): SharedContent | null {
    return ShareIntentModule.getSharedContent();
}

export function clearSharedContent(): void {
    ShareIntentModule.clearSharedContent();
}

export function addShareListener(listener: (event: SharedContent) => void) {
    return emitter.addListener('onShareReceived', listener);
}
