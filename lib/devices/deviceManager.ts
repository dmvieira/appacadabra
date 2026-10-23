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
import {
    EnrollAck,
    EnrollSampleResult, Bundle, HelloPortrait, Mutation, encIdForSpell, encIdToAppId } from './protocol';
import { Transport } from './transport';
import { applyMutations, validateAgainstContract } from './writeback';
import { reflectMutation } from './mutationReflection';
import { transmuteApp, validateBundle, type MinimalSpellApp, type TransmuteAppResult } from './transmute';
import { POWER_WIFI } from './capabilityMap';
import { getWifiPassword, rememberWifiPassword } from './wifiCredentials';
import { getSetting, setSetting, getStorageForApp, getDataSchemas, saveDataSchemas } from '../database/db';
import { getPreferredModel } from '../api/modelPreferences';
import { getOpenRouterKey } from '../api/keyStorage';
import { chat } from '../api/openrouter';
import { bleTransport } from './bleTransport';

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

/**
 * Wakeword = nome pelo qual o Familiar é chamado. O nome vai no Complete Local
 * Name do scan response, que já carrega 19 bytes do Service Data do UUID appa
 * (16 UUID + 1 estado + 2 de overhead) — sobram 10 bytes no pacote de 31. Se
 * passar disso, o core BLE descarta o nome silenciosamente (some do picker).
 * Por isso o teto é em BYTES UTF-8 (acento = 2 bytes), não em caracteres.
 */
export const WAKE_MAX_BYTES = 10;
export const DEFAULT_WAKE_WORD = 'Appa';
/**
 * Nomes que o firmware traz de fábrica (não são escolha do usuário). Se a
 * memória do app tiver um desses, tratamos como "não definido" -> DEFAULT.
 */
const LEGACY_WAKE_DEFAULTS = new Set(['fofura']);

/** Comprimento em bytes UTF-8 (sem depender de TextEncoder no Hermes). */
export function utf8len(s: string): number {
    let n = 0;
    for (const ch of s) {
        const c = ch.codePointAt(0) ?? 0;
        n += c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
    }
    return n;
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
        // Snapshot imutável: a UI guarda isso em state; devolver o mesmo ref
        // fazia setSession() bailar e a tela nao re-renderizar apos mutacoes
        // (ex.: remover encantamento parecia "nao funcionar").
        return this.session ? { ...this.session } : null;
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
        // Sessão zumbi: o device rebootando/desaparecendo NÃO disparava limpeza
        // (onDisconnect era no-op) — a UI seguia "conectado" e toda ação falhava
        // com 'not connected' do native. Encerra a sessão na desconexão real.
        const wrapped: Transport = {
            connect: async () => {
                const conn = await transport.connect();
                conn.onDisconnect(() => {
                    if (this.session) {
                        this.session = null;
                        this.lastQuery = null;
                        this.emit();
                    }
                });
                return conn;
            },
        };
        // BLE transmite em chunks de ~20B: bundles grandes (HTML da spell) levam
        // dezenas de segundos -> timeout generoso (antes 5s).
        const client = new AppaClient(wrapped, 120000);
        client.writebackHandler = (mutations) => this.handleWriteback(mutations);
        client.queryResultHandler = (qr) => {
            // Resposta/pergunta do Familiar (voz): a tela mostra a última.
            this.lastQuery = { enc: qr.enc, q: qr.q, a: qr.a };
            this.emit();
        };
        const portrait = await client.connect();
        const session: FamiliarSession = {
            client,
            portrait,
            ...(deviceId ? { deviceId } : {}),
            connectedAt: Date.now(),
            lastWritebackAt: null,
            lastWritebackCount: 0,
        };
        this.session = session;
        if (deviceId) {
            try {
                await this.ensureWakeword(deviceId);
            } catch {
                await this.rememberFamiliar({ id: deviceId, name: portrait.name }).catch(() => {});
            }
        }
        this.emit();
        return session.portrait;
    }

    /**
     * Garante que o firmware desperte pela wakeword exibida. O nome É a wakeword;
     * resolve da memória por device (ou DEFAULT_WAKE_WORD) e envia
     * SET_CONFIG {name, wake:{mode:'flex',phrase}}, re-lendo o HELLO. Assim o
     * default de fábrica do firmware nunca aparece e renomear sempre vale.
     */
    private async ensureWakeword(deviceId: string): Promise<void> {
        const session = this.session;
        if (!session) return;
        const known = await this.knownFamiliars();
        const stored = known.find((f) => f.id === deviceId)?.name?.trim() ?? '';
        let wake =
            !stored || LEGACY_WAKE_DEFAULTS.has(stored.toLowerCase()) ? DEFAULT_WAKE_WORD : stored;
        if (utf8len(wake) > WAKE_MAX_BYTES) wake = DEFAULT_WAKE_WORD;
        await session.client.setConfig({
            name: wake,
            wake: { mode: 'flex', phrase: wake },
            time: Math.floor(Date.now() / 1000),
            tzOffset: new Date().getTimezoneOffset(),
            model: await getPreferredModel('WEBVIEW').catch(() => undefined),
        });
        // Atualiza o retrato localmente: o HELLO do firmware hardcoda wake/mode e
        // o PAIR_REQUEST (pullPortrait) não é confiável neste firmware, então não
        // dependemos dele para refletir o nome na UI.
        this.applyWakewordLocally(wake);
        await this.rememberFamiliar({ id: deviceId, name: wake }).catch(() => {});
    }

    /** Reflete a wakeword no retrato da sessão (nome + wake.phrase) e re-renderiza. */
    private applyWakewordLocally(wake: string): void {
        const p = this.session?.portrait;
        if (!p) return;
        p.name = wake;
        if (p.wake) {
            p.wake.phrase = wake;
            p.wake.active = 'flex';
        }
        this.emit();
    }

    /** Timestamp do último disconnect MANUAL (o auto-reconnect respeita). */
    private manualDisconnectAt = 0;

    /** False por 20s após um disconnect manual (intenção do usuário manda). */
    shouldAutoReconnect(): boolean {
        return Date.now() - this.manualDisconnectAt > 20000;
    }

    disconnect(): void {
        this.manualDisconnectAt = Date.now();
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
        const rejected: string[] = [];
        for (const mu of mutations) {
            // Encantamento determinístico: decode direto do id; fallback ao
            // índice (ids aleatórios legados). Sem destino conhecido a mutação
            // é REJEITADA (volta no ack; o device para de retentar eternamente
            // e o app decide reencantar ou remover).
            const appId = encIdToAppId(mu.enc) ?? idx.get(mu.enc);
            if (appId === undefined) {
                rejected.push(mu.id);
                continue;
            }
            const list = groups.get(appId) ?? [];
            list.push(mu);
            groups.set(appId, list);
        }
        const accepted: string[] = [];
        for (const [appId, list] of groups) {
            // Contrato da spell (quando derivado na transmutação): mutação fora
            // do schema ganha 1 retry com reflection ANTES de virar erro.
            const schemas = (await getDataSchemas(appId).catch(() => null)) as
                | import('./protocol').DataSchemas
                | null;
            const finalList: Mutation[] = [];
            for (const mu of list) {
                const errors = validateAgainstContract(mu, schemas ?? undefined);
                if (errors.length === 0 || !schemas) {
                    finalList.push(mu);
                    continue;
                }
                try {
                    const model = await getPreferredModel('WEBVIEW');
                    const key = (await getOpenRouterKey()) ?? '';
                    if (!key) {
                        finalList.push(mu); // sem chave: porta final rejeita
                        continue;
                    }
                    const fixed = await reflectMutation(model, key, {
                        schemas,
                        key: mu.key,
                        op: mu.op,
                        value: mu.value,
                        utterance: mu.src,
                        errors,
                    });
                    finalList.push(fixed ? { ...mu, value: fixed.value } : mu);
                } catch {
                    finalList.push(mu); // reflection falhou: porta final rejeita
                }
            }
            const r = await applyMutations(appId, finalList, {}, schemas ?? undefined);
            accepted.push(...r.accepted);
            rejected.push(...r.rejected);
        }
        this.session.lastWritebackAt = Date.now();
        this.session.lastWritebackCount += accepted.length;
        this.emit();
        return { accepted, rejected };
    }

    private deviceKey(): string {
        return this.session?.deviceId ?? '__default__';
    }

    /**
     * Hora do CELULAR é a fonte única do device (sem NTP): epoch + fuso vão no
     * SET_CONFIG a cada sincronização. O modelo do WebView também via junto —
     * o device usa O MESMO modelo no chat e no STT.
     */
    private async syncClockAndModel(): Promise<void> {
        if (!this.session) return;
        try {
            const model = await getPreferredModel('WEBVIEW');
            await this.session.client.setConfig({
                model,
                time: Math.floor(Date.now() / 1000),
                tzOffset: new Date().getTimezoneOffset(),
            });
        } catch {
            // best-effort: device segue com a última hora/modelo conhecidos
        }
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

    async registerEncantamento(encId: string, appId: number): Promise<void> {
        // Índice legado (encId -> appId). Com o id determinístico o vínculo é
        // inerente (encIdToAppId); o índice cobre ids aleatórios antigos.
        const idx = await this.loadEncIndex();
        idx.set(encId, appId);
        await this.saveEncIndex();
    }

    /** Mapa encId -> appId (spell de origem), para exibir o nome na UI. */
    async encAppMap(): Promise<Map<string, number>> {
        return new Map(await this.loadEncIndex());
    }

    /** Encantamento existente desta spell neste device (p/ rotular "Atualizar"). */
    async enchantmentForApp(appId: number): Promise<{ encId: string; version: number } | null> {
        const encId = encIdForSpell(appId);
        const e = this.session?.portrait.encantamentos.find((x) => x.id === encId);
        return e ? { encId, version: e.version } : null;
    }

    /** Remove um encantamento do Familiar conectado. */
    async unenchant(encId: string): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.unenchant(encId);
        const idx = await this.loadEncIndex();
        idx.delete(encId);
        await this.saveEncIndex();
        // Remocao otimista: tira do retrato local e re-renderiza na hora (o
        // refresh por HELLO sobre BLE e lento e fazia parecer que "nao removeu").
        const portrait = this.session.portrait;
        if (portrait?.encantamentos) {
            portrait.encantamentos = portrait.encantamentos.filter((e) => e.id !== encId);
            this.emit();
        }
        await this.pullPortrait(3000).catch(() => {});
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
            /** Substitui slot ocupado por OUTRA spell (confirmado na UI). */
            forceReplace?: boolean;
        } = {},
    ): Promise<TransmuteAppResult & { ack: { id: string; version: number; stored: boolean } }> {
        if (!this.session) throw new Error('devicesNoConnection');
        // 1 encantamento por feitiço/device: o id deriva do feitiço, então
        // reencantar ATUALIZA a versão (upsert) — nunca duplica.
        const encId = opts.encId ?? encIdForSpell(app.id);
        // Vínculo explícito: se o slot do device guarda OUTRA spell, não
        // substitui silenciosamente — a UI pergunta antes (forceReplace).
        const storedEnc = this.session.portrait.encantamentos.find((e) => e.id === encId);
        if (storedEnc?.spellId && storedEnc.spellId !== `app_${app.id}` && !opts.forceReplace) {
            throw new Error(`devicesEncSlotConflict:${encId}:${storedEnc.spellId}`);
        }
        if (opts.forceReplace && storedEnc) {
            await this.session.client.unenchant(encId).catch(() => {});
        }
        const version = opts.version ?? (await this.resolveNextVersion(encId, app.id));
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
        let ack = await this.enchantWithRetry(result.bundle);
        // Idempotência: o device tinha versão igual/maior -> sobe e reenvia 1x.
        if (!ack.stored && encId) {
            const next = (ack.version || 0) + 1;
            result = await build(next, encId);
            if (!validateBundle(result.bundle)) ack = await this.enchantWithRetry(result.bundle);
        }
        await this.registerEncantamento(result.bundle.manifest.id, app.id);
        // Contrato de dados: persiste na spell (validação dos writebacks).
        if (result.bundle.dataSchemas) {
            await saveDataSchemas(app.id, result.bundle.dataSchemas).catch(() => {});
        }
        // Vinculação reafirma o modelo do WebView e a hora do celular.
        await this.syncClockAndModel();
        // Mantém o retrato em sync: o próximo update já manda a versão certa de
        // primeira (evita "manda errado -> device recusa -> reenvia o payload").
        this.syncPortraitEnchantment(result.bundle.manifest.id, ack.version);
        this.emit();
        return { ...result, ack };
    }

    /**
     * Versão a usar no ENCHANT (upsert). Se o retrato atual já lista o
     * encantamento, manda stored+1 de primeira. Se temos indício local de que a
     * spell já foi encantada mas o retrato não a lista (retrato possivelmente
     * obsoleto), pergunta o HELLO (barato) antes, em vez de gastar dois envios
     * do payload inteiro.
     */
    private async resolveNextVersion(encId: string, appId: number): Promise<number> {
        const findVer = () => this.session?.portrait.encantamentos.find((e) => e.id === encId)?.version;
        let v = findVer();
        if (v === undefined) {
            const encFor = await this.loadEncFor();
            if (encFor.has(appId)) {
                await this.pullPortrait(3000).catch(() => {});
                v = findVer();
            }
        }
        return (v ?? 0) + 1;
    }

    /** Reflete um encantamento recém-gravado no retrato (id/versão) e re-renderiza. */
    private syncPortraitEnchantment(encId: string, version: number): void {
        const portrait = this.session?.portrait;
        if (!portrait?.encantamentos) return;
        const found = portrait.encantamentos.find((e) => e.id === encId);
        if (found) found.version = version;
        else portrait.encantamentos.push({ id: encId, version });
        this.emit();
    }

    /**
     * Envia o ENCHANT com 1 retry em caso de timeout (BLE instável durante o
     * envio). Outros erros sobem como estão.
     */
    private async enchantWithRetry(bundle: Bundle): Promise<{ id: string; version: number; stored: boolean }> {
        if (!this.session) throw new Error('devicesNoConnection');
        try {
            return await this.session.client.enchant(bundle);
        } catch (e) {
            if (e instanceof Error && /timeout/i.test(e.message)) {
                await this.session.client.ping().catch(() => {});
                return await this.session.client.enchant(bundle);
            }
            throw e;
        }
    }

    /** Concede um poder ao Familiar conectado. */
    async grantPower(power: string, token: string, meta?: Record<string, unknown>): Promise<void> {
        if (!this.session) throw new Error('devicesNoConnection');
        await this.session.client.grantPower(power, token, meta);
        // Reflete no retrato local: o device nao reenvia HELLO apos GRANT,
        // e a UI (botao Ativar IA) derivaria 'ja ativo' de uma lista velha.
        const session = this.session as FamiliarSession & {
            portrait: { device: { powers: string[] } };
        };
        const powers = session.portrait.device.powers;
        if (!powers.includes(power)) {
            powers.push(power);
            this.emit();
        }
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
        try {
            await this.session.client.grantPower(POWER_WIFI, JSON.stringify({ ssid: name, pass: password }));
        } catch (e) {
            // Coexistência de rádio: o ciclo de WiFi no device pode derrubar o
            // link BLE (o GRANT geralmente CHEGA — o device provisiona mesmo
            // com o app caído). Reconecta e verifica o estado REAL antes de
            // falhar; 'connection closed' deixa de ser erro mortal.
            const msg = e instanceof Error ? e.message : String(e);
            if (!/connection closed/i.test(msg)) throw e;
            await this.recoverAfterLinkDrop();
            const p = this.session?.portrait;
            const net = p?.device?.net;
            if (net?.status === 3 && (net?.ssid ?? '') === name) {
                return; // provisionou mesmo com o link caindo
            }
            throw e;
        }
        await this.rememberWifiSsid(name);
    }

    /**
     * Reconecta ao último Familiar após queda de link (não-manual): espera o
     * device terminar o ciclo de WiFi, tenta 2x e re-sincroniza o retrato.
     */
    private async recoverAfterLinkDrop(): Promise<void> {
        const deviceId = this.session?.deviceId;
        this.session = null;
        this.emit();
        if (!deviceId) throw new Error('connection closed');
        await new Promise((r) => setTimeout(r, 2500)); // device termina WiFi.begin
        let last: unknown = null;
        for (let attempt = 1; attempt <= 2; attempt++) {
            try {
                await this.connect(bleTransport(deviceId), deviceId);
                await this.pullPortrait(8000).catch(() => {});
                return;
            } catch (e) {
                last = e;
                await new Promise((r) => setTimeout(r, 1200));
            }
        }
        throw last ?? new Error('connection closed');
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
     * Renomeia o Familiar: o nome É a wakeword (nome pelo qual ele é chamado).
     * SET_CONFIG {name, wake:{mode:'flex',phrase}} e reemite o HELLO para a UI
     * refletir sem reconectar. O teto de bytes garante o nome no advertising.
     */
    async renameFamiliar(name: string): Promise<HelloPortrait | null> {
        if (!this.session) throw new Error('devicesNoConnection');
        const clean = name.trim();
        if (!clean) throw new Error('devicesNameEmpty');
        if (utf8len(clean) > WAKE_MAX_BYTES) throw new Error('devicesNameTooLong');
        await this.session.client.setConfig({
            name: clean,
            wake: { mode: 'flex', phrase: clean },
        });
        this.applyWakewordLocally(clean);
        if (this.session.deviceId) {
            await this.rememberFamiliar({ id: this.session.deviceId, name: clean }).catch(() => {});
        }
        return this.session.portrait;
    }

    refreshPortrait(): HelloPortrait | null {
        return this.session?.portrait ?? null;
    }

    /** Cancela um cadastro em andamento (best-effort). */
    async cancelEnroll(): Promise<void> {
        if (!this.session) return;
        await this.session.client.enrollCancel().catch(() => {});
    }

    /** A voz para a frase atual ja esta cadastrada no Familiar? */
    wakeEnrolled(): boolean {
        return this.session?.portrait?.wake?.enrolled === true;
    }

    /**
     * Ritual de cadastro da wakeword por voz (PROTOCOL.md 3.6): o device grava
     * com o PROPRIO microfone; este metodo so conduz — pede cada amostra no
     * momento certo, checa o resultado, calibra o ambiente e commita.
     *
     * `cb.onSampleStart` dispara ANTES de cada gravacao: a UI mostra "diga
     * <nome> agora" e SÓ DEPOIS chama voltar; a gravacao comeca imediatamente.
     */
    async enrollWakeWord(
        opts: { required?: number; optional?: number; onCommitFail?: (r: EnrollAck) => void } = {},
        cb: {
            onSampleStart?: (index: number, total: number) => Promise<void> | void;
            onSampleResult?: (index: number, r: EnrollSampleResult) => void;
            onCalibrateStart?: () => Promise<void> | void;
        } = {},
    ): Promise<EnrollAck & { samples: number }> {
        const session = this.session;
        if (!session) throw new Error('devicesNoConnection');
        const required = opts.required ?? 3;
        const optional = opts.optional ?? 2;

        await session.client.enrollStart();

        let okSamples = 0;
        const trySample = async (attempts: number, index: number, total: number): Promise<boolean> => {
            for (let a = 0; a < attempts; a++) {
                await cb.onSampleStart?.(index, total);
                const r = await session.client.enrollSample();
                cb.onSampleResult?.(index, r);
                if (r.ok) {
                    okSamples += 1;
                    return true;
                }
            }
            return false;
        };

        const total = required + optional;
        // 3 obrigatorias: sem as 3, aborta (cancel limpa o device).
        for (let i = 1; i <= required; i++) {
            const ok = await trySample(3, i, total);
            if (!ok) {
                await session.client.enrollCancel().catch(() => {});
                return { stage: 'commit', enrolled: false, reason: 'samples', samples: okSamples };
            }
        }
        // 2 opcionais: melhor-esforco, falha so pula.
        for (let i = required + 1; i <= required + optional; i++) {
            await trySample(1, i, required + optional);
        }

        // Calibracao do ambiente (com 1 retry).
        await cb.onCalibrateStart?.();
        let calib = await session.client.enrollCalibrate();
        if (!calib.ok) calib = await session.client.enrollCalibrate();
        if (!calib.ok) {
            await session.client.enrollCancel().catch(() => {});
            return { stage: 'commit', enrolled: false, reason: 'calibrate', samples: okSamples };
        }

        const ack = await session.client.enrollCommit();
        if (!ack.enrolled) {
            opts.onCommitFail?.(ack);
            return { ...ack, samples: okSamples };
        }
        // Retrato local: o proximo HELLO confirma, mas refletimos ja.
        const p = session.portrait;
        if (p?.wake) {
            p.wake.enrolled = true;
            p.wake.active = 'enrolled';
        }
        this.emit();
        return { ...ack, samples: okSamples };
    }

    /** Reemite o HELLO e atualiza o retrato da sessão (ex.: pós-provisionamento). */
    async pullPortrait(timeoutMs?: number): Promise<HelloPortrait | null> {
        if (!this.session) return null;
        const portrait = await this.session.client.pullPortrait(timeoutMs);
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
 * Mapeia mensagens técnicas de erro do device para chaves i18n amigáveis.
 * Retorna null quando não há tradução (a UI mostra a mensagem crua).
 */
export function deviceErrorKey(message: string): string | null {
    if (/timeout waiting for ENCHANT_ACK|waiting for OK/i.test(message)) return 'devicesEnchantTimeout';
    if (/timeout waiting for HELLO|timeout waiting/i.test(message)) return 'devicesConnectTimeout';
    if (/E_NO_NUS|does not expose NUS/i.test(message)) return 'devicesBleNoService';
    if (/E_DISCONNECTED|connection closed/i.test(message)) return 'devicesDisconnected';
    return null;
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
                write: async (data: Uint8Array) => {
                    await mod.write(bytesToBase64(data));
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
