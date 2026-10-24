/**
 * APP-side client for the appa protocol — the "forja" talking to a Familiar.
 *
 * Promise-based request/response correlation via `ackOf`, mirroring the
 * device-side handlers in `appa-sim` (and, later, the ESP32 runtime):
 *   PAIR_REQUEST -> PAIR_ACCEPT (+ HELLO)
 *   PING         -> PONG
 *   ENCHANT      -> ENCHANT_ACK (idempotent for version <= stored)
 *   UNENCHANT    -> OK | ERROR UNKNOWN_ENCHANTMENT
 *   GRANT/REVOKE_POWER, SET_CONFIG -> OK
 *   WRITEBACK (device-initiated)   -> WRITEBACK_ACK emitted by this client
 */

import {
    Bundle,
    EnchantAck,
    EnrollAck,
    EnrollSampleResult,
    ErrorPayload,
    FrameDecoder,
    HelloPortrait,
    MSG,
    Message,
    MessageType,
    Mutation,
    buildMessage,
    frameEncode,
    generateMessageId,
    parseMessage,
} from './protocol';
import { Transport, TransportConnection } from './transport';

export class AppaProtocolError extends Error {
    code: string;

    constructor(code: string, message: string) {
        super(message);
        this.name = 'AppaProtocolError';
        this.code = code;
    }
}

export interface WritebackDecision {
    accepted: string[];
    rejected: string[];
}

export class AppaClient {
    private transport: Transport;
    private conn: TransportConnection | null = null;
    private decoder = new FrameDecoder();
    private pending = new Map<string, { resolve: (m: Message) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
    private helloWaiters: Array<{ resolve: (h: HelloPortrait) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }> = [];
    portrait: HelloPortrait | null = null;
    writebackHandler: ((mutations: Mutation[]) => WritebackDecision | Promise<WritebackDecision>) | null = null;
    /** Relatórios de perguntas/respondidas do dispositivo (QUERY_RESULT). */
    queryResultHandler: ((qr: { enc: string; q: string; a: string; usage?: { costUsd?: number } }) => void) | null = null;
    private requestTimeoutMs: number;

    constructor(transport: Transport, requestTimeoutMs = 5000) {
        this.transport = transport;
        this.requestTimeoutMs = requestTimeoutMs;
        this.decoder.setHandler((payload) => this.onFrame(payload));
    }

    /** Connects and waits for the device HELLO (sent on connection). */
    async connect(): Promise<HelloPortrait> {
        this.conn = await this.transport.connect();
        this.conn.onData((data) => this.decoder.feed(data));
        this.conn.onDisconnect(() => this.rejectAll(new Error('connection closed')));
        return this.waitForHello();
    }

    close(): void {
        this.rejectAll(new Error('client closed'));
        this.conn?.close();
        this.conn = null;
    }

    private rejectAll(err: Error): void {
        for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(err);
        }
        this.pending.clear();
        for (const w of this.helloWaiters) {
            clearTimeout(w.timer);
            w.reject(err);
        }
        this.helloWaiters = [];
    }

    private waitForHello(timeoutMs = this.requestTimeoutMs): Promise<HelloPortrait> {
        if (this.portrait) return Promise.resolve(this.portrait);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.helloWaiters.findIndex((w) => w.timer === timer);
                if (idx >= 0) this.helloWaiters.splice(idx, 1);
                reject(new Error('timeout waiting for HELLO'));
            }, timeoutMs);
            this.helloWaiters.push({ resolve, reject, timer });
        });
    }

    private onFrame(payload: Uint8Array): void {
        const res = parseMessage(payload);
        if (!res.ok || !res.message) return;
        const msg = res.message;

        if (msg.type === MSG.HELLO) {
            this.portrait = msg.payload as unknown as HelloPortrait;
            const waiters = this.helloWaiters.splice(0);
            for (const w of waiters) {
                clearTimeout(w.timer);
                w.resolve(this.portrait);
            }
            return;
        }

        if (msg.type === MSG.QUERY_RESULT) {
            this.queryResultHandler?.(msg.payload as unknown as { enc: string; q: string; a: string });
            return;
        }

        if (msg.type === MSG.WRITEBACK) {
            void this.handleWriteback(msg);
            return;
        }

        if (msg.ackOf) {
            const p = this.pending.get(msg.ackOf);
            if (p) {
                this.pending.delete(msg.ackOf);
                clearTimeout(p.timer);
                if (msg.type === MSG.ERROR) {
                    const err = msg.payload as unknown as ErrorPayload;
                    p.reject(new AppaProtocolError(err.code ?? 'INTERNAL', err.message ?? 'device error'));
                } else {
                    p.resolve(msg);
                }
            }
        }
    }

    private async handleWriteback(msg: Message): Promise<void> {
        const mutations = (msg.payload.mutations as Mutation[] | undefined) ?? [];
        let decision: WritebackDecision;
        if (this.writebackHandler) {
            decision = await this.writebackHandler(mutations);
        } else {
            // Default policy: accept everything (device drops the queue on ACK).
            decision = { accepted: mutations.map((m) => m.id), rejected: [] };
        }
        this.send(MSG.WRITEBACK_ACK, {
            accepted: decision.accepted,
            rejected: decision.rejected,
        }, msg.id);
    }

    /** Envia o envelope pelo transporte; aguarda quando o write é assíncrono. */
    private async sendAsync(type: MessageType, payload: Record<string, unknown>, ackOf?: string): Promise<string> {
        const id = generateMessageId();
        const json = buildMessage({ id, type, payload, ackOf });
        if (!json) throw new Error(`invalid envelope: ${type}`);
        const frame = frameEncodeChecked(json);
        if (!this.conn) throw new Error('transport not connected');
        const wr = this.conn.write(frame);
        if (wr && typeof (wr as Promise<boolean>).then === 'function') await wr;
        return id;
    }

    /** Envia sem aguardar transporte async (fire-and-forget, ex.: ACKs internos). */
    private send(type: MessageType, payload: Record<string, unknown>, ackOf?: string): string {
        const id = generateMessageId();
        const json = buildMessage({ id, type, payload, ackOf });
        if (!json) throw new Error(`invalid envelope: ${type}`);
        const frame = frameEncodeChecked(json);
        if (!this.conn) throw new Error('transport not connected');
        this.conn.write(frame);
        return id;
    }

    private request(type: MessageType, payload: Record<string, unknown>, expect: MessageType, timeoutMs = this.requestTimeoutMs): Promise<Message> {
        return new Promise((resolve, reject) => {
            void (async () => {
                let id: string;
                try {
                    id = await this.sendAsync(type, payload);
                } catch (e) {
                    reject(e as Error);
                    return;
                }
                const timer = setTimeout(() => {
                    this.pending.delete(id);
                    reject(new Error(`timeout waiting for ${expect} (sent ${type} id=${id})`));
                }, timeoutMs);
                this.pending.set(id, { resolve, reject, timer });
            })();
        });
    }

    async ping(timeoutMs = 6000): Promise<void> {
        await this.request(MSG.PING, {}, MSG.PONG, timeoutMs);
    }

    /** Transporte vivo? (sem isso sessão zumbi passa por conectada) */
    isConnected(): boolean {
        return !!this.conn?.connected();
    }

    async pair(pin?: string): Promise<void> {
        await this.request(MSG.PAIR_REQUEST, pin ? { pin } : {}, MSG.PAIR_ACCEPT);
        // The device follows PAIR_ACCEPT with a fresh HELLO; wait for it so
        // `portrait` reflects the post-pairing state.
        await this.waitForHello();
    }

    /**
     * Reemite o HELLO (o device responde PAIR_REQUEST com PAIR_ACCEPT + HELLO)
     * e atualiza `portrait` — usado após conceder um poder (ex.: wifi) para a
     * UI refletir o novo estado sem reconectar.
     */
    async pullPortrait(timeoutMs = this.requestTimeoutMs): Promise<HelloPortrait> {
        this.portrait = null;
        await this.request(MSG.PAIR_REQUEST, {}, MSG.PAIR_ACCEPT, timeoutMs);
        return this.waitForHello(timeoutMs);
    }

    async enchant(bundle: Bundle): Promise<EnchantAck> {
        const reply = await this.request(MSG.ENCHANT, bundle as unknown as Record<string, unknown>, MSG.ENCHANT_ACK);
        return reply.payload as unknown as EnchantAck;
    }

    /**
     * DATA_UPDATE: o runner gravou no app_storage — o device refresca o
     * snapshot de dados do encantamento (fire-and-forget, sem ACK).
     */
    sendDataUpdate(enc: string, key: string, value: string): void {
        this.send(MSG.DATA_UPDATE, { enc, key, value });
    }

    async unenchant(id: string): Promise<void> {
        await this.request(MSG.UNENCHANT, { id }, MSG.OK);
    }

    async grantPower(power: string, token: string, meta?: Record<string, unknown>): Promise<void> {
        await this.request(MSG.GRANT_POWER, { power, token, ...(meta ? { meta } : {}) }, MSG.OK);
    }

    async revokePower(power: string): Promise<void> {
        await this.request(MSG.REVOKE_POWER, { power }, MSG.OK);
    }

    async setConfig(config: {
        wake?: { mode?: string; phrase?: string; threshold?: number };
        name?: string;
        /** Modelo do WebView (o device passa a usá-lo no chat E no STT). */
        model?: string;
        /** Epoch segundos do CELULAR (fonte única de hora do device). */
        time?: number;
        /** getTimezoneOffset() do celular (minutos, oeste-positivo). */
        tzOffset?: number;
    }): Promise<void> {
        await this.request(MSG.SET_CONFIG, config as Record<string, unknown>, MSG.OK);
    }

    // ---- cadastro da wakeword por voz (PROTOCOL.md 3.6) --------------------
    // O device grava com o PROPRIO microfone; o app so conduz o ritual. As
    // gravacoes sao bloqueantes no device: timeouts generosos.

    /** Suspende o wake no device e abre o cadastro. */
    async enrollStart(): Promise<EnrollAck> {
        const m = await this.request(MSG.ENROLL_START, {}, MSG.ENROLL_ACK, 15000);
        return m.payload as unknown as EnrollAck;
    }

    /** Grava ~1.6s (usuario fala o nome) e devolve o resultado da amostra. */
    async enrollSample(timeoutMs = 20000): Promise<EnrollSampleResult> {
        const m = await this.request(MSG.ENROLL_SAMPLE, {}, MSG.ENROLL_SAMPLE_RESULT, timeoutMs);
        return m.payload as unknown as EnrollSampleResult;
    }

    /** Grava ~6s de ambiente (ninguem fala o nome) para calibrar o limiar. */
    async enrollCalibrate(timeoutMs = 30000): Promise<EnrollSampleResult> {
        const m = await this.request(MSG.ENROLL_CALIBRATE, {}, MSG.ENROLL_SAMPLE_RESULT, timeoutMs);
        return m.payload as unknown as EnrollSampleResult;
    }

    /** Valida margem, calcula limiar, persiste e coloca wake.mode='enrolled'. */
    async enrollCommit(timeoutMs = 20000): Promise<EnrollAck> {
        const m = await this.request(MSG.ENROLL_COMMIT, {}, MSG.ENROLL_ACK, timeoutMs);
        return m.payload as unknown as EnrollAck;
    }

    /** Descarta o cadastro em andamento. */
    async enrollCancel(): Promise<void> {
        await this.request(MSG.ENROLL_CANCEL, {}, MSG.OK, 15000);
    }
}

function frameEncodeChecked(json: string): Uint8Array {
    // buildMessage output for sane payloads is far below 64 KiB; the check
    // exists so a runaway bundle fails loudly instead of silently dropping.
    const encoder = new TextEncoder();
    const payload = encoder.encode(json);
    const frame = frameEncode(payload);
    if (!frame) throw new Error('payload exceeds frame limit');
    return frame;
}
