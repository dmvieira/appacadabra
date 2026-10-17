/**
 * Transport layer for appa devices (Appacadabra side).
 *
 * The protocol framing is carrier-agnostic (PROTOCOL.md §1): identical bytes
 * over BLE NUS (production), TCP (host/sim), or WiFi (future). This module
 * defines the carrier interface plus the TCP implementation used by the
 * cross-repo integration tests against `appa-sim`.
 */

export interface TransportConnection {
    connected(): boolean;
    write(data: Uint8Array): boolean;
    onData(cb: (data: Uint8Array) => void): void;
    onDisconnect(cb: () => void): void;
    close(): void;
}

export interface Transport {
    connect(): Promise<TransportConnection>;
}

import * as net from 'net';

/** TCP carrier — mirrors appa::IConnection (one connection at a time, v0.1). */
export class TcpTransport implements Transport {
    private host: string;
    private port: number;
    private timeoutMs: number;

    constructor(host = '127.0.0.1', port = 7788, timeoutMs = 5000) {
        this.host = host;
        this.port = port;
        this.timeoutMs = timeoutMs;
    }

    connect(): Promise<TransportConnection> {
        return new Promise((resolve, reject) => {
            const socket = new net.Socket();
            const finish = (err?: Error) => {
                socket.removeAllListeners('connect');
                socket.removeAllListeners('error');
                if (err) reject(err);
                else resolve(new TcpConnection(socket));
            };
            socket.once('connect', () => finish());
            socket.once('error', (err) => finish(err));
            socket.setTimeout(this.timeoutMs, () => {
                socket.destroy();
                finish(new Error(`tcp connect timeout after ${this.timeoutMs}ms`));
            });
            socket.connect(this.port, this.host);
        });
    }
}

class TcpConnection implements TransportConnection {
    private socket: net.Socket;
    private dataCb: ((data: Uint8Array) => void) | null = null;
    private disconnectCb: (() => void) | null = null;

    constructor(socket: net.Socket) {
        this.socket = socket;
        socket.on('data', (buf: Buffer) => {
            if (this.dataCb) this.dataCb(new Uint8Array(buf));
        });
        socket.on('close', () => {
            if (this.disconnectCb) this.disconnectCb();
        });
        socket.on('error', () => {
            // 'close' always follows 'error'; nothing extra to do.
        });
    }

    connected(): boolean {
        return !this.socket.destroyed && this.socket.readyState === 'open';
    }

    write(data: Uint8Array): boolean {
        if (!this.connected()) return false;
        this.socket.write(Buffer.from(data));
        return true;
    }

    onData(cb: (data: Uint8Array) => void): void {
        this.dataCb = cb;
    }

    onDisconnect(cb: () => void): void {
        this.disconnectCb = cb;
    }

    close(): void {
        this.socket.destroy();
    }
}
