/**
 * appa protocol mirror (TypeScript) — Appacadabra side.
 *
 * Mirror of `appa/src/core/` + `protocol/PROTOCOL.md` v0.1, which is the
 * canonical contract. Keep byte-level parity with the C++ implementation:
 * - framing: 0xA5 0x5A | len u16 LE | payload | crc u16 LE
 * - CRC-16/CCITT-FALSE over the 2 len bytes followed by the payload
 *   (check value: "123456789" -> 0x29B1)
 * - envelope rules per PROTOCOL.md §2
 *
 * The cross-repo conformance test (`__tests__/devices/protocol.test.ts`)
 * validates these validators against `appa/protocol/schemas/*.json` when the
 * sibling repo is present, so mirror and schema cannot drift silently.
 */

// ============= Version & framing constants =============

export const PROTOCOL_VERSION = 1;

export const FRAME_SYNC1 = 0xa5;
export const FRAME_SYNC2 = 0x5a;
export const FRAME_OVERHEAD = 6; // sync(2) + len(2) + crc(2)

export const DEFAULT_MAX_PAYLOAD = 65535;

// ============= Message types (PROTOCOL.md §3) =============

export const MSG = {
    HELLO: 'HELLO',
    PING: 'PING',
    PONG: 'PONG',
    OK: 'OK',
    ERROR: 'ERROR',
    PAIR_REQUEST: 'PAIR_REQUEST',
    PAIR_ACCEPT: 'PAIR_ACCEPT',
    GRANT_POWER: 'GRANT_POWER',
    REVOKE_POWER: 'REVOKE_POWER',
    SET_CONFIG: 'SET_CONFIG',
    ENCHANT: 'ENCHANT',
    ENCHANT_ACK: 'ENCHANT_ACK',
    UNENCHANT: 'UNENCHANT',
    WRITEBACK: 'WRITEBACK',
    WRITEBACK_ACK: 'WRITEBACK_ACK',
    QUERY_RESULT: 'QUERY_RESULT',
} as const;

export type MessageType = (typeof MSG)[keyof typeof MSG];

// ============= CRC-16/CCITT-FALSE =============

/** CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0. */
export function crc16CcittFalse(data: Uint8Array, init = 0xffff): number {
    let crc = init;
    for (let i = 0; i < data.length; i++) {
        crc ^= data[i] << 8;
        for (let bit = 0; bit < 8; bit++) {
            crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
        }
    }
    return crc;
}

// ============= Framing =============

export function frameEncodedSize(payloadLen: number): number {
    return payloadLen + FRAME_OVERHEAD;
}

/** Encodes `payload` into a frame. Returns null if payload exceeds 0xFFFF. */
export function frameEncode(payload: Uint8Array): Uint8Array | null {
    if (payload.length > 0xffff) return null;
    const out = new Uint8Array(frameEncodedSize(payload.length));
    out[0] = FRAME_SYNC1;
    out[1] = FRAME_SYNC2;
    out[2] = payload.length & 0xff;
    out[3] = (payload.length >> 8) & 0xff;
    const crc = crc16CcittFalse(out.subarray(2, 4));
    const crc2 = crc16CcittFalse(payload, crc);
    out.set(payload, 4);
    out[4 + payload.length] = crc2 & 0xff;
    out[5 + payload.length] = (crc2 >> 8) & 0xff;
    return out;
}

export type FrameHandler = (payload: Uint8Array) => void;

/**
 * Streaming frame decoder — mirrors `appa::FrameDecoder`.
 * Resync semantics (PROTOCOL.md §1): on CRC or length error the frame is
 * discarded and the decoder goes back to hunting for 0xA5 0x5A; bytes of the
 * discarded frame are NOT re-scanned (documented v0.1 tradeoff).
 */
export class FrameDecoder {
    private maxPayload: number;
    private state: 'SYNC1' | 'SYNC2' | 'LEN' | 'PAYLOAD' | 'CRC' = 'SYNC1';
    private lenBytes = new Uint8Array(2);
    private lenIdx = 0;
    private payloadLen = 0;
    private payloadIdx = 0;
    private payloadBuf: Uint8Array | null = null;
    private crcBytes = new Uint8Array(2);
    private crcIdx = 0;
    private framesOk = 0;
    private crcErrors = 0;
    private lengthErrors = 0;
    private handler: FrameHandler | null = null;

    constructor(maxPayload = DEFAULT_MAX_PAYLOAD) {
        this.maxPayload = maxPayload;
    }

    setHandler(handler: FrameHandler): void {
        this.handler = handler;
    }

    feed(data: Uint8Array): void {
        for (let i = 0; i < data.length; i++) this.putByte(data[i]);
    }

    reset(): void {
        this.state = 'SYNC1';
        this.lenIdx = 0;
        this.payloadIdx = 0;
        this.crcIdx = 0;
    }

    getFramesOk(): number {
        return this.framesOk;
    }

    getCrcErrors(): number {
        return this.crcErrors;
    }

    getLengthErrors(): number {
        return this.lengthErrors;
    }

    private putByte(b: number): void {
        switch (this.state) {
            case 'SYNC1':
                if (b === FRAME_SYNC1) this.state = 'SYNC2';
                break;

            case 'SYNC2':
                if (b === FRAME_SYNC2) {
                    this.state = 'LEN';
                    this.lenIdx = 0;
                } else if (b !== FRAME_SYNC1) {
                    // 0xA5 0xA5 ... stays in SYNC2, like the C++ decoder.
                    this.state = 'SYNC1';
                }
                break;

            case 'LEN':
                this.lenBytes[this.lenIdx++] = b;
                if (this.lenIdx === 2) {
                    this.payloadLen = this.lenBytes[0] | (this.lenBytes[1] << 8);
                    if (this.payloadLen > this.maxPayload) {
                        this.lengthErrors++;
                        this.state = 'SYNC1';
                        break;
                    }
                    this.payloadBuf = this.payloadLen > 0 ? new Uint8Array(this.payloadLen) : null;
                    this.payloadIdx = 0;
                    if (this.payloadLen === 0) {
                        this.crcIdx = 0;
                        this.state = 'CRC';
                    } else {
                        this.state = 'PAYLOAD';
                    }
                }
                break;

            case 'PAYLOAD': {
                if (!this.payloadBuf) break;
                this.payloadBuf[this.payloadIdx++] = b;
                if (this.payloadIdx === this.payloadLen) {
                    this.crcIdx = 0;
                    this.state = 'CRC';
                }
                break;
            }

            case 'CRC':
                this.crcBytes[this.crcIdx++] = b;
                if (this.crcIdx === 2) {
                    const recv = this.crcBytes[0] | (this.crcBytes[1] << 8);
                    let calc = crc16CcittFalse(this.lenBytes);
                    if (this.payloadBuf && this.payloadLen > 0) {
                        calc = crc16CcittFalse(this.payloadBuf, calc);
                    }
                    if (calc === recv) {
                        this.framesOk++;
                        if (this.handler && this.payloadBuf) {
                            this.handler(this.payloadBuf);
                        } else if (this.handler) {
                            this.handler(new Uint8Array(0));
                        }
                    } else {
                        this.crcErrors++;
                    }
                    this.state = 'SYNC1';
                }
                break;
        }
    }
}

// ============= Envelope (PROTOCOL.md §2) =============

export interface Message {
    v: number;
    id: string;
    type: MessageType;
    /** id of the message this replies to; empty when absent. */
    ackOf?: string;
    /** payload object; `{}` when absent. */
    payload: Record<string, unknown>;
}

const ID_RE = /^[a-zA-Z0-9_-]{1,16}$/;
const TYPE_RE = /^[A-Z][A-Z0-9_]{0,22}$/;
const ENC_ID_RE = /^enc_[a-z0-9]{6,12}$/;
const POWER_RE = /^[a-z0-9_]{1,15}$/;

export function validMessageId(id: string): boolean {
    return ID_RE.test(id);
}

export function validMessageType(type: string): type is MessageType {
    return TYPE_RE.test(type);
}

export function validEncantamentoId(id: string): boolean {
    return ENC_ID_RE.test(id);
}

export function validPowerName(power: string): boolean {
    return POWER_RE.test(power);
}

export type ProtocolError = 'BAD_JSON' | 'BAD_VERSION' | 'BAD_ID' | 'BAD_TYPE' | 'BAD_ACKOF' | 'BAD_PAYLOAD';

export interface ParseResult {
    ok: boolean;
    message?: Message;
    error?: string;
}

/**
 * Parses an envelope JSON string. Mirrors `appa::parse_message`: payload is
 * re-serialized (semantically equivalent, not byte-identical), `payload`
 * absent/null is equivalent to `{}`, and errors carry a code prefix.
 */
export function parseMessage(json: string | Uint8Array): ParseResult {
    let doc: unknown;
    try {
        const text = typeof json === 'string' ? json : new TextDecoder().decode(json);
        doc = JSON.parse(text);
    } catch {
        return { ok: false, error: 'BAD_JSON' };
    }
    if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
        return { ok: false, error: 'BAD_JSON: raiz nao e objeto' };
    }
    const obj = doc as Record<string, unknown>;

    const v = obj.v;
    if (typeof v !== 'number' || !Number.isInteger(v) || v !== PROTOCOL_VERSION) {
        return { ok: false, error: 'BAD_VERSION' };
    }

    const id = typeof obj.id === 'string' ? obj.id : '';
    if (!validMessageId(id)) return { ok: false, error: 'BAD_ID' };

    const type = typeof obj.type === 'string' ? obj.type : '';
    if (!validMessageType(type)) return { ok: false, error: 'BAD_TYPE' };

    let ackOf = '';
    if (obj.ackOf !== undefined && obj.ackOf !== null) {
        ackOf = typeof obj.ackOf === 'string' ? obj.ackOf : '';
        if (!validMessageId(ackOf)) return { ok: false, error: 'BAD_ACKOF' };
    }

    let payload: Record<string, unknown> = {};
    if (obj.payload !== undefined && obj.payload !== null) {
        const p = obj.payload;
        if (typeof p !== 'object' || p === null || Array.isArray(p)) {
            return { ok: false, error: 'BAD_PAYLOAD: payload deve ser objeto' };
        }
        // Round-trip so the payload is semantically equivalent JSON (mirrors
        // the C++ re-serialization).
        payload = JSON.parse(JSON.stringify(p)) as Record<string, unknown>;
    }

    return { ok: true, message: { v, id, type, ackOf, payload } };
}

/** Serializes an envelope. Returns null (and sets nothing) if invalid. */
export function buildMessage(m: {
    id: string;
    type: MessageType;
    ackOf?: string;
    payload?: Record<string, unknown> | null;
}): string | null {
    if (!validMessageId(m.id)) return null;
    if (!validMessageType(m.type)) return null;
    if (m.ackOf !== undefined && m.ackOf !== '' && !validMessageId(m.ackOf)) return null;
    const payload = m.payload ?? {};
    if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
    const envelope: Record<string, unknown> = {
        v: PROTOCOL_VERSION,
        id: m.id,
        type: m.type,
    };
    if (m.ackOf) envelope.ackOf = m.ackOf;
    envelope.payload = payload;
    return JSON.stringify(envelope);
}

/** Message id for the APP side: 8 hex chars (PROTOCOL.md §2). */
export function generateMessageId(): string {
    let id = '';
    for (let i = 0; i < 8; i++) id += Math.floor(Math.random() * 16).toString(16);
    return id;
}

/** Encantamento id: `enc_` + 10 chars [a-z0-9] (schema allows 6-12). */
export function generateEncantamentoId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let suffix = '';
    for (let i = 0; i < 10; i++) suffix += chars[Math.floor(Math.random() * chars.length)];
    return `enc_${suffix}`;
}

/**
 * id DETERMINÍSTICO do encantamento a partir do feitiço: 1 encantamento por
 * feitiço por device. Reencantar reusa este id → o device ATUALIZA a versão
 * (upsert) em vez de duplicar. `enc_` + base36(appId) com 6 chars.
 */
export function encIdForSpell(appId: number): string {
    return `enc_${appId.toString(36).padStart(6, '0')}`;
}

/**
 * appId a partir do encId determinístico. Só decodifica o formato de 6 chars
 * (`encIdForSpell`); ids aleatórios legados (10 chars) retornam null e são
 * resolvidos pelo índice legado.
 */
export function encIdToAppId(encId: string): number | null {
    const m = /^enc_([0-9a-z]{6})$/.exec(encId);
    if (!m) return null;
    const n = parseInt(m[1], 36);
    return Number.isFinite(n) && n > 0 ? n : null;
}

// ============= Payload types (PROTOCOL.md §3-§4) =============

export interface HelloPortrait {
    name: string;
    proto: number;
    fw: string;
    device: {
        model: string;
        powers: string[];
        /** Capability ids que o firmware sabe servir (v0.2). */
        capabilities?: string[];
        /** Recursos físicos presentes no dispositivo (v0.2). */
        requires?: DeviceRequirement[];
        /** Estado de rede (v0.2, opcional): SSID/IP/status quando há Wi-Fi. */
        net?: { ssid?: string; status?: number; ip?: string };
    };
    storage: { freeKb: number };
    wake: {
        modes: string[];
        active: string;
        phrase: string;
        threshold: number;
    };
    encantamentos: Array<{ id: string; version: number }>;
    [key: string]: unknown;
}

export interface EnchantAck {
    id: string;
    version: number;
    stored: boolean;
}

export interface ErrorPayload {
    code: string;
    message: string;
    inReplyTo?: string;
}

export interface Mutation {
    id: string;
    enc: string;
    key: string;
    op: 'merge' | 'set';
    /** JSON-string value, mirroring app_storage TEXT columns. */
    value: string;
    ts: number;
}

export interface BundleManifest {
    id: string;
    spellId: string;
    name: string;
    version: number;
    requiredPowers: string[];
    createdAt: number;
    /** Permissionamento que viaja com o encantamento (v0.2, opcional). */
    capabilities?: CapabilityEntry[];
    /**
     * Palavras/frases de exemplo para o roteador de voz do device decidir
     * quando usar este encantamento (ex.: ["tarefas","o que falta","hoje"]).
     * Opcional (v0.2).
     */
    keywords?: string[];
}

export type DeviceRequirement = 'mic' | 'speaker' | 'net' | 'storage' | 'camera';

export interface CapabilityEntry {
    /** Capability id do Appacadabra (ex.: "sheets", "ai"). */
    id: string;
    status: 'granted' | 'not-supported';
    /** Poderes do Cofre que esta capability exige (ex.: ["openrouter"]). */
    powers: string[];
    /** Recursos físicos do Familiar (ex.: ["net", "mic"]). */
    requires: DeviceRequirement[];
}

export interface Bundle {
    manifest: BundleManifest;
    prompt: string;
    /** key -> JSON-string values (like app_storage TEXT). */
    data: Record<string, string>;
    config: { refreshPolicy: 'manual' | 'onconnect' };
}
