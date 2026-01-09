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

export function checkShareIntent(): void {
    ShareIntentModule.checkShareIntent();
}

export function markAsProcessed(): void {
    ShareIntentModule.markAsProcessed();
}

export async function startRunnerActivity(appId: number): Promise<boolean> {
    return ShareIntentModule.startRunnerActivity(appId);
}

// Open app in NEW window - used by Play button
export async function openRunnerWindow(appId: number): Promise<boolean> {
    return ShareIntentModule.openRunnerWindow(appId);
}

export async function finishRunnerActivity(appId: number): Promise<boolean> {
    return ShareIntentModule.finishRunnerActivity(appId);
}

export function addShareListener(listener: (event: SharedContent) => void) {
    return emitter.addListener('onShareReceived', listener);
}

