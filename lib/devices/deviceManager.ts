/**
 * Familiar session manager — the UI-facing layer over AppaClient.
 *
 * Holds at most one active Familiar connection (v0.1), wires the device's
 * WRITEBACK stream into the real app_storage (applyMutations on the spell of
 * origin), and exposes imbueSpell() — the full forja: requirements →
 * capability permissionamento → BYOK voice prompt → ENCHANT.
 *
 * Transport is injectable for tests; in the app it uses the native TCP
 * module (dev/QA vs appa-sim) or the native BLE module (production).
 */

import { NativeModules } from 'react-native';

import { AppaClient } from './appaClient';
import { Bundle, HelloPortrait, Mutation } from './protocol';
import { Transport } from './transport';
import { applyMutations } from './writeback';
import { transmuteApp, validateBundle, type MinimalSpellApp, type TransmuteAppResult } from './transmute';
import { POWER_WIFI } from './capabilityMap';
import { getWifiPassword, rememberWifiPassword } from './wifiCredentials';
import { getSetting, setSetting, getStorageForApp } from '../database/db';

export interface FamiliarSession {
    client: AppaClient;
    portrait: HelloPortrait;
    connectedAt: number;
    lastWritebackAt: number | null;
    lastWritebackCount: number;
}

type Listener = () => void;

class DeviceManager {
    private session: FamiliarSession | null = null;
    private listeners = new Set<Listener>();

    getSession(): FamiliarSession | null {
        return this.session;
    }

    subscribe(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    private emit(): void {
        for (const fn of this.listeners) fn();
    }

    /**
     * Connects to a Familiar. The WRITEBACK stream is wired to the spells'
     * app_storage of origin (manifest.spellId = "app_<id>").
     */
    async connect(transport: Transport): Promise<HelloPortrait> {
        this.disconnect();
        const client = new AppaClient(transport);
        client.writebackHandler = (mutations) => this.handleWriteback(mutations);
        const portrait = await client.connect();
        this.session = {
            client,
            portrait,
            connectedAt: Date.now(),
            lastWritebackAt: null,
            lastWritebackCount: 0,
        };
        this.emit();
        return portrait;
    }

    disconnect(): void {
        if (this.session) {
            this.session.client.close();
            this.session = null;
            this.emit();
        }
    }

    private async handleWriteback(mutations: Mutation[]): Promise<{ accepted: string[]; rejected: string[] }> {
        if (!this.session) return { accepted: [], rejected: mutations.map((m) => m.id) };
        // mutation traz "enc" (id do encantamento); resolvemos para a spell de
        // origem via indice de imbuições (persistido em app_settings).
        await this.loadEncIndex();
        const groups = new Map<number, Mutation[]>();
        for (const mu of mutations) {
            const appId = this.encToApp.get(mu.enc);
            if (appId === undefined) continue;
            const list = groups.get(appId) ?? [];
            list.push(mu);
            groups.set(appId, list);
        }
        let accepted: string[] = [];
        let rejected: string[] = [];
        for (const [appId, list] of groups) {
            const r = await applyMutations(appId, list);
            accepted = [...accepted, ...r.accepted];
            rejected = [...rejected, ...r.rejected];
        }
        this.session.lastWritebackAt = Date.now();
        this.session.lastWritebackCount += accepted.length;
        this.emit();
        return { accepted, rejected };
    }

    /** Índice encId -> appId, persistido em app_settings (devices.encIndex). */
    private encToApp = new Map<string, number>();
    private encIndexLoaded = false;

    private async loadEncIndex(): Promise<void> {
        if (this.encIndexLoaded) return;
        this.encIndexLoaded = true;
        try {
            const raw = await getSetting('devices.encIndex');
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, number>;
                this.encToApp = new Map(Object.entries(parsed).map(([k, v]) => [k, v as number]));
            }
        } catch {
            // indice corrompido: recomeca vazio
        }
    }

    private async saveEncIndex(): Promise<void> {
        try {
            await setSetting('devices.encIndex', JSON.stringify(Object.fromEntries(this.encToApp)));
        } catch {
            // best-effort
        }
    }

    async registerEncantamento(encId: string, appId: number): Promise<void> {
        await this.loadEncIndex();
        this.encToApp.set(encId, appId);
        await this.saveEncIndex();
    }

    /**
     * The full forja: transmutes the spell and enchants the connected
     * Familiar. Returns the bundle review for the UI.
     */
    async imbueSpell(app: MinimalSpellApp & { requiredCapabilities?: string[] | null }, opts: { generatePrompt?: (app: MinimalSpellApp, keys: string[]) => Promise<string> } = {}): Promise<TransmuteAppResult & { ack: { id: string; version: number; stored: boolean } }> {
        if (!this.session) throw new Error('devicesNoConnection');
        const result = await transmuteApp(app, {
            getStorage: (appId) => getStorageForApp(appId),
            ...(opts.generatePrompt ? { generatePrompt: opts.generatePrompt } : {}),
        });
        if (validateBundle(result.bundle)) throw new Error('devicesInvalidBundle');
        // Permissionamento: o Familiar precisa cobrir as capabilities granted
        const deviceCaps = new Set(this.session.portrait.device.capabilities ?? []);
        const missing = result.mapping.entries.filter((e) => e.status === 'granted' && !deviceCaps.has(e.id));
        if (missing.length > 0) {
            throw new Error(`devicesUnsupported:${missing.map((m) => m.id).join(',')}`);
        }
        const ack = await this.session.client.enchant(result.bundle);
        await this.registerEncantamento(result.bundle.manifest.id, app.id);
        this.emit();
        return { ...result, ack };
    }

    /** Concede um poder ao Familiar conectado. */
    async grantPower(power: string, token: string, meta?: Record<string, unknown>): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.grantPower(power, token, meta);
    }

    /**
     * Provisiona Wi-Fi no Familiar (poder `wifi`, token `{ssid, pass}` — ver
     * PROTOCOL.md). O SSID é lembrado em app_settings; a senha NÃO é persistida
     * aqui — só depois que a conexão é confirmada (ver rememberWifi).
     */
    async provisionWifi(ssid: string, password: string): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        const name = ssid.trim();
        if (!name) throw new Error('devicesWifiNeedsSsid');
        await this.session.client.grantPower(POWER_WIFI, JSON.stringify({ ssid: name, pass: password }));
        await this.rememberWifiSsid(name);
    }

    /** Guarda a senha de um SSID só depois de confirmada (ver grantWifi na UI). */
    async rememberWifi(ssid: string, password: string): Promise<void> {
        await rememberWifiPassword(ssid.trim(), password).catch(() => {});
    }

    /** Último SSID provisionado (conveniência de UI). */
    async lastWifiSsid(): Promise<string> {
        try {
            return (await getSetting('devices.wifiSsid')) ?? '';
        } catch {
            return '';
        }
    }

    /** Senha lembrada para um SSID ('' quando desconhecida) — ver wifiCredentials.ts. */
    async wifiPasswordFor(ssid: string): Promise<string> {
        return getWifiPassword(ssid);
    }

    private async rememberWifiSsid(ssid: string): Promise<void> {
        try {
            await setSetting('devices.wifiSsid', ssid);
        } catch {
            // best-effort
        }
    }

    async revokePower(power: string): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.revokePower(power);
    }

    async setConfig(config: Parameters<AppaClient['setConfig']>[0]): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.setConfig(config);
    }

    /**
     * Renomeia o Familiar (nome pelo qual ele é chamado). SET_CONFIG {name} e
     * reemite o HELLO para a UI refletir o novo nome sem reconectar.
     */
    async renameFamiliar(name: string): Promise<HelloPortrait | null> {
        if (!this.session) throw new Error('devicesNoConnection');
        const clean = name.trim();
        if (!clean) throw new Error('devicesNameEmpty');
        await this.session.client.setConfig({ name: clean });
        return this.pullPortrait();
    }

    refreshPortrait(): HelloPortrait | null {
        return this.session?.portrait ?? null;
    }

    /** Reemite o HELLO e atualiza o retrato da sessão (ex.: pós-provisionamento). */
    async pullPortrait(): Promise<HelloPortrait | null> {
        if (!this.session) return null;
        const portrait = await this.session.client.pullPortrait();
        this.session.portrait = portrait;
        this.emit();
        return portrait;
    }
}

export const deviceManager = new DeviceManager();

/** app_<id> -> id (schema do manifest.spellId). */
export function spellIdToAppId(spellId: string): number | null {
    const m = /^app_(\d+)$/.exec(spellId);
    return m ? parseInt(m[1], 10) : null;
}

/**
 * Dev/QA transport factory: native TCP module (android). Throws a clear
 * error when the module isn't registered (e.g. Jest or old build).
 */
export function nativeTcpTransport(host: string, port: number): Transport {
    const mod = (NativeModules as Record<string, unknown>).AppaTcpModule as
        | { connect(h: string, p: number): Promise<void>; write(b64: string): void; disconnect(): void }
        | undefined;
    if (!mod) {
        throw new Error('devicesNoNativeTcp');
    }
    const listeners: Array<(data: Uint8Array) => void> = [];
    return {
        async connect() {
            await mod.connect(host, port);
            const { DeviceEventEmitter } = require('react-native') as typeof import('react-native');
            DeviceEventEmitter.addListener('AppaTcpData', (e: { base64: string }) => {
                for (const l of listeners) l(base64ToBytes(e.base64));
            });
            return {
                connected: () => true,
                write: (data: Uint8Array) => {
                    mod.write(bytesToBase64(data));
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

// base64 helpers (Uint8Array <-> base64) sem Buffer em RN
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
