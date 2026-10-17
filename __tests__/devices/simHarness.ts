/**
 * Shared harness for tests that need the real C++ appa-sim running.
 * Not a test file (no .test suffix) — imported by the L2 and L2-live suites.
 */

import { ChildProcess, execSync, spawn } from 'child_process';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';

export const APPA_ROOT = path.resolve(__dirname, '..', '..', '..', 'appa');
export const SIM_BIN = path.join(APPA_ROOT, 'build', 'appa-sim');
export const hasAppaRepo = fs.existsSync(path.join(APPA_ROOT, 'protocol', 'PROTOCOL.md'));

export async function freePort(): Promise<number> {
    return new Promise((resolve, reject) => {
        const srv = net.createServer();
        srv.listen(0, '127.0.0.1', () => {
            const addr = srv.address() as net.AddressInfo;
            const port = addr.port;
            srv.close(() => resolve(port));
        });
        srv.on('error', reject);
    });
}

export interface SimHandle {
    port: number;
    /** Envia um comando ao stdin do sim (ASK/MUTATE/HELLO). */
    write(line: string): void;
    stop(): void;
}

/**
 * Ensures the sim binary exists (builds the ../appa host target once — the
 * zig toolchain is cached under ../appa/.toolchain) and starts it on a free
 * port with a throwaway storage dir.
 */
export async function startSim(name = 'fofura-sim'): Promise<SimHandle> {
    if (!fs.existsSync(SIM_BIN)) {
        execSync('bash scripts/build_host.sh', { cwd: APPA_ROOT, stdio: 'pipe', timeout: 170_000 });
    }
    const port = await freePort();
    const storage = fs.mkdtempSync(path.join(os.tmpdir(), 'appa-sim-test-'));
    const proc = spawn(SIM_BIN, ['--port', String(port), '--storage', storage, '--name', name], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    // stdout do C++ e block-buffered em pipe — nao confie no banner;
    // considera "pronto" quando a porta aceita TCP (poll).
    await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('appa-sim did not start in 15s')), 15_000);
        proc.on('exit', (code) => {
            clearTimeout(timeout);
            reject(new Error(`appa-sim exited early with code ${code}`));
        });
        const started = Date.now();
        const tryConnect = () => {
            const probe = new net.Socket();
            probe.once('connect', () => {
                probe.destroy();
                clearTimeout(timeout);
                resolve();
            });
            probe.once('error', () => {
                probe.destroy();
                if (Date.now() - started > 15_000) return;
                setTimeout(tryConnect, 150);
            });
            probe.connect(port, '127.0.0.1');
        };
        tryConnect();
    });
    return {
        port,
        write(line: string) {
            proc.stdin!.write(`${line}\n`);
        },
        stop() {
            proc.kill('SIGTERM');
            if (fs.existsSync(storage)) fs.rmSync(storage, { recursive: true, force: true });
        },
    };
}
