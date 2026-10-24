/**
 * Ritual de cadastro da wakeword por voz — device FAKE TCP (sem sim, roda em
 * qualquer ambiente). Cobre: fluxo feliz 3+2, abort por amostras ruins,
 * falha de margem no commit e cancelamento.
 */

import * as net from 'net';

import { deviceManager } from '../../lib/devices/deviceManager';
import { createFrameSplitter, frameEncode } from '../../lib/devices/protocol';

const encoder = new TextEncoder();

interface SampleScript {
    ok: boolean;
    reason?: string;
    dist?: number;
}

interface Script {
    samples: SampleScript[];
    calibrate: { ok: boolean; reason?: string; dist?: number };
    commit: { enrolled: boolean; reason?: string; threshold?: number; templates?: number };
}

function startFakeDevice(script: Script): Promise<{ port: number; sent: string[]; close: () => void }> {
    const sent: string[] = [];
    let sampleIdx = 0;
    let calibIdx = 0;
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            const send = (type: string, payload: Record<string, unknown>, ackOf: string) => {
                const msg = { v: 1, id: `d${Math.random().toString(16).slice(2, 9)}`, type, payload, ackOf };
                socket.write(Buffer.from(frameEncode(encoder.encode(JSON.stringify(msg))) as Uint8Array));
            };
            const hello = {
                v: 1, id: 'd0', type: 'HELLO',
                payload: { name: 'Appa', proto: 1, device: { model: 'fake', powers: [], capabilities: ['ai'] }, encantamentos: [], wake: { modes: ['enrolled', 'flex'], active: 'flex', phrase: 'Appa', threshold: 0.8, enrolled: false } },
            };
            socket.write(Buffer.from(frameEncode(encoder.encode(JSON.stringify(hello))) as Uint8Array));
            const splitter = createFrameSplitter((payload) => {
                const text = Buffer.from(payload).toString();
                sent.push(text);
                const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
                const ackOf = json.id ?? '';
                switch (json.type) {
                    case 'PING':
                        send('PONG', {}, ackOf);
                        break;
                    case 'ENROLL_START':
                        sampleIdx = 0;
                        send('ENROLL_ACK', { stage: 'start' }, ackOf);
                        break;
                    case 'ENROLL_SAMPLE': {
                        const s = script.samples[Math.min(sampleIdx, script.samples.length - 1)];
                        sampleIdx += 1;
                        send('ENROLL_SAMPLE_RESULT', { index: sampleIdx, ...s }, ackOf);
                        break;
                    }
                    case 'ENROLL_CALIBRATE': {
                        const c = script.calibrate;
                        calibIdx += 1;
                        send('ENROLL_SAMPLE_RESULT', { stage: 'calibrate', ...c }, ackOf);
                        break;
                    }
                    case 'ENROLL_COMMIT':
                        send('ENROLL_ACK', { stage: 'commit', ...script.commit }, ackOf);
                        break;
                    case 'ENROLL_CANCEL':
                        send('OK', {}, ackOf);
                        break;
                    default:
                        send('OK', {}, ackOf);
                }
            });
            socket.on('data', (buf) => splitter.feed(new Uint8Array(buf)));
        });
        server.listen(0, '127.0.0.1', () => {
            const port = (server.address() as net.AddressInfo).port;
            resolve({ port, sent, close: () => server.close() });
        });
    });
}

const transportFor = (port: number) => ({
    connect: async () => {
        const s = net.connect(port, '127.0.0.1');
        await new Promise<void>((r) => s.once('connect', r));
        return {
            connected: () => !s.destroyed,
            write: (d: Uint8Array) => (s.write(Buffer.from(d)), true),
            onData: (cb: (d: Uint8Array) => void) => s.on('data', (b: Buffer) => cb(new Uint8Array(b))),
            onDisconnect: () => {},
            close: () => s.destroy(),
        };
    },
});

describe('deviceManager.enrollWakeWord (device fake)', () => {
    afterEach(() => {
        deviceManager.disconnect();
    });

    test('fluxo feliz: 3 obrigatorias + 2 opcionais + calibrar + commit', async () => {
        const fake = await startFakeDevice({
            samples: [
                { ok: true, dist: 40 },
                { ok: true, dist: 42 },
                { ok: true, dist: 39 },
                { ok: true, dist: 41 },
                { ok: true, dist: 43 },
            ],
            calibrate: { ok: true, dist: 240 },
            commit: { enrolled: true, threshold: 91, templates: 5 },
        });
        const portrait = await deviceManager.connect(transportFor(fake.port), 'enr1');
        expect(portrait.wake?.enrolled).toBe(false);

        const started: number[] = [];
        const ack = await deviceManager.enrollWakeWord({}, {
            onSampleStart: async (index, total) => {
                started.push(index);
                expect(total).toBe(5);
            },
        });

        expect(ack.enrolled).toBe(true);
        expect(ack.threshold).toBe(91);
        expect(ack.samples).toBe(5);
        expect(started).toEqual([1, 2, 3, 4, 5]);
        // o retrato local reflete o cadastro
        expect(deviceManager.wakeEnrolled()).toBe(true);
        expect(deviceManager.refreshPortrait()?.wake?.active).toBe('enrolled');
        fake.close();
    }, 20_000);

    test('amostras ruins: aborta apos 3 tentativas por amostra e cancela', async () => {
        const fake = await startFakeDevice({
            samples: [{ ok: false, reason: 'curta' }],
            calibrate: { ok: true },
            commit: { enrolled: true },
        });
        await deviceManager.connect(transportFor(fake.port), 'enr2');

        const ack = await deviceManager.enrollWakeWord({}, {});
        expect(ack.enrolled).toBe(false);
        expect(ack.reason).toBe('samples');
        expect(ack.samples).toBe(0);
        expect(fake.sent.join('\n')).toContain('ENROLL_CANCEL');
        fake.close();
    }, 20_000);

    test('margem conflitante: commit falha e devolve o motivo sem cancelar o device', async () => {
        const fake = await startFakeDevice({
            samples: [{ ok: true }, { ok: true }, { ok: true }, { ok: true }, { ok: true }],
            calibrate: { ok: true, dist: 5 },
            commit: { enrolled: false, reason: 'margem' },
        });
        await deviceManager.connect(transportFor(fake.port), 'enr3');

        const onCommitFail = jest.fn();
        const ack = await deviceManager.enrollWakeWord({ onCommitFail }, {});
        expect(ack.enrolled).toBe(false);
        expect(ack.reason).toBe('margem');
        expect(onCommitFail).toHaveBeenCalled();
        // NAO cancela: o usuario pode recalibrar em cima do mesmo cadastro
        expect(fake.sent.join('\n')).not.toContain('ENROLL_CANCEL');
        expect(deviceManager.wakeEnrolled()).toBe(false);
        fake.close();
    }, 20_000);

    test('calibracao falha: retry 1x e depois cancela', async () => {
        const fake = await startFakeDevice({
            samples: [{ ok: true }, { ok: true }, { ok: true }],
            calibrate: { ok: false, reason: 'silencio' },
            commit: { enrolled: true },
        });
        await deviceManager.connect(transportFor(fake.port), 'enr4');

        const ack = await deviceManager.enrollWakeWord({ optional: 0 }, {});
        expect(ack.enrolled).toBe(false);
        expect(ack.reason).toBe('calibrate');
        expect(fake.sent.join('\n')).toContain('ENROLL_CANCEL');
        fake.close();
    }, 20_000);
});
