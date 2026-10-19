/**
 * BLE NUS transport (production) — RN side of AppaBleModule.
 * Mirrors the TcpTransport interface; the iOS twin implements the same JS
 * contract over CoreBluetooth.
 */

import { DeviceEventEmitter, NativeModules, PermissionsAndroid, Platform } from 'react-native';

import { getAppaBleNative } from 'appa-ble';

import type { Transport } from './transport';

export interface BleDevice {
    id: string;
    name: string;
    rssi: number;
    /** Estado de setup anunciado pelo Familiar (0 = novo, 1 = configurado, -1 = desconhecido). */
    state?: number;
}

interface AppaBleModuleShape {
    scan(timeoutMs: number): Promise<BleDevice[]>;
    stopScan(): void;
    connect(deviceId: string): Promise<void>;
    write(b64: string): Promise<boolean>;
    disconnect(): void;
}

/**
 * Contrato de descoberta appa: um Familiar anuncia este UUID de serviço (com
 * 1 byte de estado em Service Data). É o que distingue "Familiares a
 * configurar" do resto dos dispositivos BLE. Ver PROTOCOL.md (§ Descoberta).
 */
export const APPA_SERVICE_UUID = '61707061-0000-1000-8000-00805f9b34fb';

/** state: 0 = novo (precisa de setup), 1 = já configurado. */
export const APPA_STATE_NEW = 0;
export const APPA_STATE_CONFIGURED = 1;

export function bleModule(): AppaBleModuleShape | null {
    // iOS: local Expo module (CoreBluetooth). Android: app-target RCT module.
    if (Platform.OS === 'ios') {
        return (getAppaBleNative() as AppaBleModuleShape | null) ?? null;
    }
    const mod = (NativeModules as Record<string, unknown>).AppaBleModule;
    return mod ? (mod as AppaBleModuleShape) : null;
}

type BleSub = { remove: () => void };

/** Subscribes to a BLE event on both platforms (Expo module vs DeviceEventEmitter). */
function addBleListener(event: string, cb: (payload: { base64: string }) => void): BleSub {
    if (Platform.OS === 'ios') {
        const mod = getAppaBleNative() as { addListener?: (e: string, c: (p: { base64: string }) => void) => BleSub } | null;
        if (mod?.addListener) return mod.addListener(event, cb);
    }
    return DeviceEventEmitter.addListener(event, cb) as BleSub;
}

/** Requests BLUETOOTH_SCAN/CONNECT on Android 12+. No-op elsewhere. */
export async function ensureBlePermissions(): Promise<boolean> {
    if (Platform.OS !== 'android' || Platform.Version < 31) return true;
    const res = await PermissionsAndroid.requestMultiple([
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
        PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return (
        res['android.permission.BLUETOOTH_SCAN'] === PermissionsAndroid.RESULTS.GRANTED &&
        res['android.permission.BLUETOOTH_CONNECT'] === PermissionsAndroid.RESULTS.GRANTED
    );
}

export async function bleScan(timeoutMs = 6000): Promise<BleDevice[]> {
    const mod = bleModule();
    if (!mod) throw new Error('devicesNoNativeBle');
    if (!(await ensureBlePermissions())) throw new Error('devicesBlePermission');
    return mod.scan(timeoutMs);
}

/** Connects to a Familiar over BLE NUS. */
export function bleTransport(deviceId: string): Transport {
    const mod = bleModule();
    if (!mod) {
        throw new Error('devicesNoNativeBle');
    }
    const listeners: Array<(data: Uint8Array) => void> = [];
    return {
        async connect() {
            await ensureBlePermissions();
            await mod.connect(deviceId);
            const sub = addBleListener('AppaBleData', (e: { base64: string }) => {
                const bytes = base64ToBytes(e.base64);
                for (const l of listeners) l(bytes);
            });
            addBleListener('AppaBleDisconnect', () => sub.remove());
            return {
                connected: () => true,
                write: (data: Uint8Array) => {
                    void mod.write(bytesToBase64(data));
                    return true;
                },
                onData: (cb) => {
                    listeners.push(cb);
                },
                onDisconnect: () => {},
                close: () => {
                    mod.disconnect();
                },
            };
        },
    };
}

function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
        binary += String.fromCharCode(...Array.from(bytes.subarray(i, i + chunk)));
    }
    return globalThis.btoa ? globalThis.btoa(binary) : Buffer.from(bytes).toString('base64');
}

function base64ToBytes(b64: string): Uint8Array {
    if (globalThis.atob) {
        const binary = globalThis.atob(b64);
        const out = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
        return out;
    }
    return new Uint8Array(Buffer.from(b64, 'base64'));
}
