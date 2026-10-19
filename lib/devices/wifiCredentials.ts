/**
 * Senhas de Wi-Fi dos Familiares, guardadas em expo-secure-store
 * (Android Keystore / EncryptedSharedPreferences), indexadas por SSID.
 *
 * O Android NÃO expõe a senha da rede à qual o celular está conectado (sem
 * root), então a senha é digitada uma única vez por rede e lembrada aqui — ao
 * trocar de rede, o app preenche a senha daquela rede (se já conhecida).
 */

import * as SecureStore from 'expo-secure-store';

const KEY_NAME = 'appa_wifi_passwords';

const OPTIONS: SecureStore.SecureStoreOptions = {
    keychainAccessible: SecureStore.WHEN_UNLOCKED,
};

type PasswordMap = Record<string, string>;

async function readMap(): Promise<PasswordMap> {
    try {
        const raw = await SecureStore.getItemAsync(KEY_NAME, OPTIONS);
        if (!raw) return {};
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            const out: PasswordMap = {};
            for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof v === 'string') out[k] = v;
            }
            return out;
        }
        return {};
    } catch {
        return {};
    }
}

/** Senha lembrada para um SSID ('' quando desconhecida). */
export async function getWifiPassword(ssid: string): Promise<string> {
    const map = await readMap();
    return map[ssid] ?? '';
}

/** Guarda a senha de um SSID (preserva as demais redes). */
export async function rememberWifiPassword(ssid: string, pass: string): Promise<void> {
    const map = await readMap();
    map[ssid] = pass;
    await SecureStore.setItemAsync(KEY_NAME, JSON.stringify(map), OPTIONS);
}

export async function forgetWifiPassword(ssid: string): Promise<void> {
    const map = await readMap();
    delete map[ssid];
    await SecureStore.setItemAsync(KEY_NAME, JSON.stringify(map), OPTIONS);
}
