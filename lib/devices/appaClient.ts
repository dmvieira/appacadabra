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

    private waitForHello(): Promise<HelloPortrait> {
        if (this.portrait) return Promise.resolve(this.portrait);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                const idx = this.helloWaiters.findIndex((w) => w.timer === timer);
                if (idx >= 0) this.helloWaiters.splice(idx, 1);
                reject(new Error('timeout waiting for HELLO'));
            }, this.requestTimeoutMs);
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

    /** Sends an envelope without waiting for a reply. */
    private send(type: MessageType, payload: Record<string, unknown>, ackOf?: string): string {
        const id = generateMessageId();
        const json = buildMessage({ id, type, payload, ackOf });
        if (!json) throw new Error(`invalid envelope: ${type}`);
        const frame = frameEncodeChecked(json);
        if (!this.conn?.write(frame)) throw new Error('transport not connected');
        return id;
    }

    private request(type: MessageType, payload: Record<string, unknown>, expect: MessageType): Promise<Message> {
        return new Promise((resolve, reject) => {
            const id = (() => {
                try {
                    return this.send(type, payload);
                } catch (e) {
                    reject(e as Error);
                    return null;
                }
            })();
            if (id === null) return;
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new Error(`timeout waiting for ${expect} (sent ${type} id=${id})`));
            }, this.requestTimeoutMs);
            this.pending.set(id, { resolve, reject, timer });
        });
    }

    async ping(): Promise<void> {
        await this.request(MSG.PING, {}, MSG.PONG);
    }

    async pair(pin?: string): Promise<void> {
        await this.request(MSG.PAIR_REQUEST, pin ? { pin } : {}, MSG.PAIR_ACCEPT);
        // The device follows PAIR_ACCEPT with a fresh HELLO; wait for it so
        // `portrait` reflects the post-pairing state.
        await this.waitForHello();
    }

    async enchant(bundle: Bundle): Promise<EnchantAck> {
        const reply = await this.request(MSG.ENCHANT, bundle as unknown as Record<string, unknown>, MSG.ENCHANT_ACK);
        return reply.payload as unknown as EnchantAck;
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

    async setConfig(config: { wake?: { mode?: string; phrase?: string; threshold?: number }; name?: string }): Promise<void> {
        await this.request(MSG.SET_CONFIG, config as Record<string, unknown>, MSG.OK);
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
