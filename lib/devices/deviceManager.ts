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
    /** Endereço BLE (id) do Familiar — usado p/ persistir por device. */
    deviceId?: string;
    connectedAt: number;
    lastWritebackAt: number | null;
    lastWritebackCount: number;
}

export interface KnownFamiliar {
    id: string;
    name: string;
    lastSeen: number;
}

type Listener = () => void;

class DeviceManager {
    private session: FamiliarSession | null = null;
    private listeners = new Set<Listener>();
    /** Última resposta do Familiar (QUERY_RESULT de voz). */
    private lastQuery: { enc: string; q: string; a: string } | null = null;
    /** Índices por device (encId -> appId) e (appId -> {encId,version}). */
    private encIndexCache = new Map<string, Map<string, number>>();
    private encForCache = new Map<string, Map<number, { encId: string; version: number }>>();

    getSession(): FamiliarSession | null {
        return this.session;
    }

    getLastQuery(): { enc: string; q: string; a: string } | null {
        return this.lastQuery;
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
    async connect(transport: Transport, deviceId?: string): Promise<HelloPortrait> {
        this.disconnect();
        // BLE transmite em chunks de ~20B: bundles grandes (HTML da spell) levam
        // dezenas de segundos -> timeout generoso (antes 5s).
        const client = new AppaClient(transport, 120000);
        client.writebackHandler = (mutations) => this.handleWriteback(mutations);
        client.queryResultHandler = (qr) => {
            // Resposta/pergunta do Familiar (voz): a tela mostra a última.
            this.lastQuery = { enc: qr.enc, q: qr.q, a: qr.a };
            this.emit();
        };
        const portrait = await client.connect();
        this.session = {
            client,
            portrait,
            ...(deviceId ? { deviceId } : {}),
            connectedAt: Date.now(),
            lastWritebackAt: null,
            lastWritebackCount: 0,
        };
        if (deviceId) await this.rememberFamiliar({ id: deviceId, name: portrait.name }).catch(() => {});
        this.emit();
        return portrait;
    }

    disconnect(): void {
        if (this.session) {
            this.session.client.close();
            this.session = null;
            this.lastQuery = null;
            this.emit();
        }
    }

    private async handleWriteback(mutations: Mutation[]): Promise<{ accepted: string[]; rejected: string[] }> {
        if (!this.session) return { accepted: [], rejected: mutations.map((m) => m.id) };
        // mutation traz "enc" (id do encantamento); resolvemos para a spell de
        // origem via indice de imbuições (persistido em app_settings).
        const idx = await this.loadEncIndex();
        const groups = new Map<number, Mutation[]>();
        for (const mu of mutations) {
            const appId = idx.get(mu.enc);
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

    private deviceKey(): string {
        return this.session?.deviceId ?? '__default__';
    }

    /** Índice encId -> appId (por device), persistido em app_settings. */
    private async loadEncIndex(): Promise<Map<string, number>> {
        const dev = this.deviceKey();
        const cached = this.encIndexCache.get(dev);
        if (cached) return cached;
        let map = new Map<string, number>();
        try {
            // Por device; migra do índice global antigo na primeira vez.
            let raw = await getSetting(`devices.encIndex.${dev}`);
            if (!raw) raw = await getSetting('devices.encIndex');
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, number>;
                map = new Map(Object.entries(parsed).map(([k, v]) => [k, v as number]));
            }
        } catch {
            // indice corrompido: recomeca vazio
        }
        this.encIndexCache.set(dev, map);
        return map;
    }

    private async saveEncIndex(): Promise<void> {
        const dev = this.deviceKey();
        const map = this.encIndexCache.get(dev) ?? new Map<string, number>();
        try {
            await setSetting(`devices.encIndex.${dev}`, JSON.stringify(Object.fromEntries(map)));
        } catch {
            // best-effort
        }
    }

    /** appId -> {encId, version} (por device): permite ATUALIZAR em vez de duplicar. */
    private async loadEncFor(): Promise<Map<number, { encId: string; version: number }>> {
        const dev = this.deviceKey();
        const cached = this.encForCache.get(dev);
        if (cached) return cached;
        const map = new Map<number, { encId: string; version: number }>();
        try {
            const raw = await getSetting(`devices.encFor.${dev}`);
            if (raw) {
                const parsed = JSON.parse(raw) as Record<string, { encId: string; version: number }>;
                for (const [k, v] of Object.entries(parsed)) {
                    if (v && typeof v.encId === 'string') map.set(parseInt(k, 10), v);
                }
            }
        } catch {
            // best-effort
        }
        this.encForCache.set(dev, map);
        return map;
    }

    private async saveEncFor(): Promise<void> {
        const dev = this.deviceKey();
        const map = this.encForCache.get(dev) ?? new Map<number, { encId: string; version: number }>();
        try {
            await setSetting(`devices.encFor.${dev}`, JSON.stringify(Object.fromEntries(map)));
        } catch {
            // best-effort
        }
    }

    async registerEncantamento(encId: string, appId: number, version: number): Promise<void> {
        const idx = await this.loadEncIndex();
        idx.set(encId, appId);
        await this.saveEncIndex();
        const forMap = await this.loadEncFor();
        forMap.set(appId, { encId, version });
        await this.saveEncFor();
    }

    /** Mapa encId -> appId (spell de origem), para exibir o nome na UI. */
    async encAppMap(): Promise<Map<string, number>> {
        return new Map(await this.loadEncIndex());
    }

    /** Remove um encantamento do Familiar conectado. */
    async unenchant(encId: string): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.unenchant(encId);
        const idx = await this.loadEncIndex();
        const appId = idx.get(encId);
        idx.delete(encId);
        await this.saveEncIndex();
        if (appId !== undefined) {
            const forMap = await this.loadEncFor();
            forMap.delete(appId);
            await this.saveEncFor();
        }
        await this.pullPortrait().catch(() => {});
    }

    // ---- Familiares conhecidos (persistidos p/ escolher com status) ----
    async knownFamiliars(): Promise<KnownFamiliar[]> {
        try {
            const raw = await getSetting('devices.known');
            if (!raw) return [];
            const parsed = JSON.parse(raw) as KnownFamiliar[];
            return Array.isArray(parsed) ? parsed.filter((f) => f && typeof f.id === 'string') : [];
        } catch {
            return [];
        }
    }

    async rememberFamiliar(f: { id: string; name: string }): Promise<void> {
        const list = await this.knownFamiliars();
        const entry: KnownFamiliar = { id: f.id, name: f.name, lastSeen: Date.now() };
        const i = list.findIndex((x) => x.id === f.id);
        if (i >= 0) list[i] = { ...list[i], ...entry };
        else list.unshift(entry);
        try {
            await setSetting('devices.known', JSON.stringify(list.slice(0, 20)));
        } catch {
            // best-effort
        }
    }

    async markFamiliarSeen(id: string): Promise<void> {
        const list = await this.knownFamiliars();
        const i = list.findIndex((x) => x.id === id);
        if (i < 0) return;
        list[i].lastSeen = Date.now();
        try {
            await setSetting('devices.known', JSON.stringify(list));
        } catch {
            // best-effort
        }
    }

    /** Hash (ou vazio) da última chave de IA concedida — p/ não reativar à toa. */
    async aiKeyHash(): Promise<string> {
        try {
            return (await getSetting('devices.aiKeyHash')) ?? '';
        } catch {
            return '';
        }
    }

    async rememberAiKeyHash(hash: string): Promise<void> {
        try {
            await setSetting('devices.aiKeyHash', hash);
        } catch {
            // best-effort
        }
    }

    /**
     * The full forja: transmutes the spell and enchants the connected
     * Familiar. Returns the bundle review for the UI.
     */
    async imbueSpell(
        app: MinimalSpellApp & { requiredCapabilities?: string[] | null },
        opts: {
            generatePrompt?: (app: MinimalSpellApp, keys: string[]) => Promise<string>;
            generateEnchantment?: (app: MinimalSpellApp, keys: string[]) => Promise<{ prompt: string; keywords: string[] }>;
            promptOverride?: string;
            keywordsOverride?: string[];
            version?: number;
            encId?: string;
        } = {},
    ): Promise<TransmuteAppResult & { ack: { id: string; version: number; stored: boolean } }> {
        if (!this.session) throw new Error('devicesNoConnection');
        // Atualizar (não duplicar): se a spell já tem encantamento neste device,
        // reusa o mesmo encId e incrementa a versão.
        let encId = opts.encId;
        let version = opts.version;
        if (!encId) {
            const existing = (await this.loadEncFor()).get(app.id);
            if (existing) {
                encId = existing.encId;
                const fromPortrait = this.session.portrait.encantamentos.find((e) => e.id === encId)?.version;
                version = (fromPortrait ?? existing.version) + 1;
            }
        }
        const build = async (v: number | undefined, id: string | undefined) =>
            transmuteApp(app, {
                getStorage: (appId) => getStorageForApp(appId),
                ...(opts.generateEnchantment ? { generateEnchantment: opts.generateEnchantment } : {}),
                ...(opts.generatePrompt ? { generatePrompt: opts.generatePrompt } : {}),
                ...(opts.promptOverride !== undefined ? { promptOverride: opts.promptOverride } : {}),
                ...(opts.keywordsOverride !== undefined ? { keywordsOverride: opts.keywordsOverride } : {}),
                ...(v !== undefined ? { version: v } : {}),
                ...(id !== undefined ? { encId: id } : {}),
            });
        let result = await build(version, encId);
        if (validateBundle(result.bundle)) throw new Error('devicesInvalidBundle');
        // Permissionamento: o Familiar precisa cobrir as capabilities granted
        const deviceCaps = new Set(this.session.portrait.device.capabilities ?? []);
        const missing = result.mapping.entries.filter((e) => e.status === 'granted' && !deviceCaps.has(e.id));
        if (missing.length > 0) {
            throw new Error(`devicesUnsupported:${missing.map((m) => m.id).join(',')}`);
        }
        let ack = await this.session.client.enchant(result.bundle);
        // Idempotência: o device tinha versão igual/maior -> sobe e reenvia 1x.
        if (!ack.stored && encId) {
            const next = (ack.version || 0) + 1;
            result = await build(next, encId);
            if (!validateBundle(result.bundle)) ack = await this.session.client.enchant(result.bundle);
        }
        await this.registerEncantamento(result.bundle.manifest.id, app.id, ack.version || version || 1);
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

/** Hash estável (djb2) de uma chave — para saber se a IA já foi concedida. */
export function hashKey(key: string): string {
    let h = 5381;
    for (let i = 0; i < key.length; i++) h = ((h << 5) + h + key.charCodeAt(i)) | 0;
    return (h >>> 0).toString(16);
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
