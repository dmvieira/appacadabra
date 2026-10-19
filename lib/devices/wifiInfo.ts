/**
 * Info de rede do celular via AppaNetModule (nativo). Usado para sugerir o
 * Wi-Fi ATUAL no ritual, em vez da rede antiga lembrada.
 *
 * Requer permissão: NEARBY_WIFI_DEVICES (Android 13+) ou ACCESS_FINE_LOCATION
 * (<=12). Sem permissão/modulo, resolve null (o usuário digita o SSID).
 */

import { NativeModules, PermissionsAndroid, Platform } from 'react-native';

const MOD = 'AppaNetModule';

const NEARBY_WIFI = 'android.permission.NEARBY_WIFI_DEVICES';

export async function getCurrentWifiSsid(): Promise<string | null> {
    if (Platform.OS !== 'android') return null;
    const mod = (NativeModules as Record<string, unknown>)[MOD] as
        | { getWifiSsid(): Promise<string | null> }
        | undefined;
    if (!mod) return null;
    try {
        const perm =
            Platform.Version >= 33
                ? (PermissionsAndroid.PERMISSIONS as Record<string, string>).NEARBY_WIFI_DEVICES ?? NEARBY_WIFI
                : PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION;
        const already = await PermissionsAndroid.check(perm as never);
        if (!already) {
            const granted = await PermissionsAndroid.request(perm as never);
            if (granted !== PermissionsAndroid.RESULTS.GRANTED) return null;
        }
        return await mod.getWifiSsid();
    } catch {
        return null;
    }
}
