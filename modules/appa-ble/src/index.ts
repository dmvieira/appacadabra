import { requireNativeModule } from 'expo-modules-core';

/**
 * iOS native module (CoreBluetooth). On Android the same JS contract is served
 * by the app-target `AppaBleModule` (Kotlin) via `NativeModules`, so this local
 * module only exists on iOS. `getAppaBleNative()` returns null when unavailable
 * (Android / web / tests) so callers fall back to `NativeModules`.
 */
export function getAppaBleNative(): any | null {
    try {
        return requireNativeModule('AppaBleModule');
    } catch {
        return null;
    }
}
