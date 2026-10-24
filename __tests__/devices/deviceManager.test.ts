/**
 * deviceManager — session wiring: WRITEBACK do device resolve para a spell de
 * origem (índice enc→app persistido) e aplica no app_storage; imbueSpell
 * transmuta, checa cobertura de capabilities e enfeitiça.
 */

import * as net from 'net';

import { deviceManager, spellIdToAppId } from '../../lib/devices/deviceManager';
import { createFrameSplitter, frameEncode } from '../../lib/devices/protocol';
import type { TransmuteAppResult } from '../../lib/devices/transmute';

const encoder = new TextEncoder();

// db mockado: storage por app + app_settings
const mockStorageByApp = new Map<string, string>();
const mockSettings = new Map<string, string>();
jest.mock('../../lib/database/db', () => ({
    getStorageForApp: async (appId: number) => {
        const out: Array<{ id: number; appId: number; key: string; value: string }> = [];
        for (const [k, v] of mockStorageByApp.entries()) {
            if (k.startsWith(`${appId}:`)) out.push({ id: out.length, appId, key: k.split(':')[1], value: v });
        }
        return out;
    },
    getSetting: async (k: string) => mockSettings.get(k) ?? null,
    setSetting: async (k: string, v: string) => {
        mockSettings.set(k, v);
    },
    getDataSchemas: async () => null,
    saveDataSchemas: async () => {},
}));

describe('deviceManager', () => {
    let server: net.Server;
    let port: number;
    const sentFrames: string[] = [];
    let lastWritebackAck: { accepted: string[]; rejected: string[] } | null = null;
    let helloEncantamentos: Array<{ id: string; version: number; spellId?: string }> = [];
    let lastSetConfig: Record<string, unknown> | null = null;
    // empurra uma mensagem do "device" para o app (ex.: WRITEBACK espontâneo)
    let serverPush: ((obj: unknown) => void) | null = null;

    beforeAll(async () => {
        server = net.createServer();
        port = await new Promise<number>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
        server.on('connection', (socket) => {
            const hello = { v: 1, id: 'd1', type: 'HELLO', payload: { name: 'fam', proto: 1, device: { model: 'm', powers: [], capabilities: ['ai', 'sheets'] }, encantamentos: helloEncantamentos } };
            const send = (obj: unknown) => socket.write(Buffer.from(frameEncode(encoder.encode(JSON.stringify(obj))) as Uint8Array));
            serverPush = send;
            send(hello);
            const splitter = createFrameSplitter((payload) => {
                sentFrames.push(Buffer.from(payload).toString());
                const text = Buffer.from(payload).toString();
                if (text.includes('ENCHANT')) {
                    send({ v: 1, id: 'd2', type: 'ENCHANT_ACK', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: { id: 'enc_mgr01', version: 1, stored: true } });
                } else if (text.includes('UNENCHANT')) {
                    send({ v: 1, id: 'd4', type: 'OK', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: {} });
                } else if (text.includes('SET_CONFIG')) {
                    lastSetConfig = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).payload;
                    send({ v: 1, id: 'd6', type: 'OK', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: {} });
                } else if (text.includes('WRITEBACK_ACK')) {
                    // resposta do app às mutações do device
                    const frame = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
                    lastWritebackAck = {
                        accepted: frame.payload?.accepted ?? [],
                        rejected: frame.payload?.rejected ?? [],
                    };
                } else if (text.includes('PING')) {
                    send({ v: 1, id: 'd3', type: 'PONG', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: {} });
                }
            });
            socket.on('data', (buf) => splitter.feed(new Uint8Array(buf)));
        });
    });

    afterAll(() => {
        deviceManager.disconnect();
        server.close();
    });

    test('spellIdToAppId parseia o formato app_<id>', () => {
        expect(spellIdToAppId('app_42')).toBe(42);
        expect(spellIdToAppId('enc_x')).toBeNull();
    });

    test('connect entrega retrato e imbueSpell encanta com permissionamento', async () => {
        mockStorageByApp.set('42:tarefas', '[{"t":"lavar"}]');
        const transport = {
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
        };
        const portrait = await deviceManager.connect(transport);
        expect(portrait.name).toBe('fam');
        expect(portrait.device.capabilities).toContain('ai');

        const result: TransmuteAppResult & { ack: { id: string; version: number; stored: boolean } } =
            await deviceManager.imbueSpell({ id: 42, name: 'Casa', requiredCapabilities: ['AI'] });
        expect(result.ack.stored).toBe(true);
        expect(result.mapping.powersToGrant).toEqual(['openrouter']);
        // relíquia viajou no bundle
        expect(result.bundle.data.tarefas).toBe('[{"t":"lavar"}]');

        // índice enc→app persistido em app_settings (por device; aqui '__default__')
        expect(mockSettings.get('devices.encIndex.__default__')).toContain(result.bundle.manifest.id);
        expect(mockSettings.get('devices.encIndex.__default__')).toContain(':42');
    });

    test('slot do device com OUTRA spell: recusa sem forceReplace, substitui com', async () => {
        helloEncantamentos = [{ id: 'enc_00000z', version: 3, spellId: 'app_999' }];
        // recarrega a sessão para o retrato ter o slot conflitante
        deviceManager.disconnect();
        const transport = {
            connect: async () => {
                const s2 = net.connect(port, '127.0.0.1');
                await new Promise<void>((r) => s2.once('connect', r));
                return {
                    connected: () => !s2.destroyed,
                    write: (d: Uint8Array) => (s2.write(Buffer.from(d)), true),
                    onData: (cb: (d: Uint8Array) => void) => s2.on('data', (b: Buffer) => cb(new Uint8Array(b))),
                    onDisconnect: () => {},
                    close: () => s2.destroy(),
                };
            },
        };
        await deviceManager.connect(transport);

        // encIdForSpell(90) = enc_00000z (90 em base36 = '2k'? use app cujo base36 bate)
        // 90.toString(36) = '2k' — não é '00000z'. Escolhemos appId cujo base36 = '00000z'
        // -> impossível ('z' > dígitos de 36? z=35 é válido!). 'z' sozinho = 35; 6 chars
        // '00000z' = 35. Então app 35 gera enc_00000z.
        await expect(
            deviceManager.imbueSpell({ id: 35, name: 'Nova', requiredCapabilities: [] }),
        ).rejects.toThrow('devicesEncSlotConflict:enc_00000z:app_999');

        // forceReplace: UNENCHANT + ENCHANT
        const r = await deviceManager.imbueSpell(
            { id: 35, name: 'Nova', requiredCapabilities: [] },
            { forceReplace: true },
        );
        expect(r.ack.stored).toBe(true);
        expect(sentFrames.some((f) => f.includes('UNENCHANT'))).toBe(true);
        helloEncantamentos = [];
    });

    test('writeback com enc sem destino é rejeitado no ack', async () => {
        deviceManager.disconnect();
        const transport = {
            connect: async () => {
                const s2 = net.connect(port, '127.0.0.1');
                await new Promise<void>((r) => s2.once('connect', r));
                return {
                    connected: () => !s2.destroyed,
                    write: (d: Uint8Array) => (s2.write(Buffer.from(d)), true),
                    onData: (cb: (d: Uint8Array) => void) => s2.on('data', (b: Buffer) => cb(new Uint8Array(b))),
                    onDisconnect: () => {},
                    close: () => s2.destroy(),
                };
            },
        };
        await deviceManager.connect(transport);
        // o "device" entrega mutação com enc sem destino conhecido
        serverPush?.({
            v: 1, id: 'wb1', type: 'WRITEBACK',
            payload: { mutations: [{ id: 'm1', enc: 'enc_999999', key: 'x', op: 'set', value: '1', ts: 0 }] },
        });
        await new Promise((r) => setTimeout(r, 400));
        expect(lastWritebackAck?.rejected).toContain('m1');
        serverPush = null;
    });

    test('imbue reafirma modelo do WebView e hora do celular (SET_CONFIG)', async () => {
        deviceManager.disconnect();
        const transport = {
            connect: async () => {
                const s2 = net.connect(port, '127.0.0.1');
                await new Promise<void>((r) => s2.once('connect', r));
                return {
                    connected: () => !s2.destroyed,
                    write: (d: Uint8Array) => (s2.write(Buffer.from(d)), true),
                    onData: (cb: (d: Uint8Array) => void) => s2.on('data', (b: Buffer) => cb(new Uint8Array(b))),
                    onDisconnect: () => {},
                    close: () => s2.destroy(),
                };
            },
        };
        await deviceManager.connect(transport);
        await deviceManager.imbueSpell({ id: 50, name: 'M', requiredCapabilities: [] });
        // syncClockAndModel roda no imbue: modelo atual + hora + fuso
        expect(lastSetConfig).toBeTruthy();
        expect(typeof lastSetConfig!.model).toBe('string');
        expect((lastSetConfig!.model as string).length).toBeGreaterThan(3);
        expect((lastSetConfig!.time as number)).toBeGreaterThan(1577836800);
        expect(typeof lastSetConfig!.tzOffset).toBe('number');
    });

    test('imbueSpell recusa quando o device não cobre a capability', async () => {
        await expect(
            deviceManager.imbueSpell({ id: 43, name: 'X', requiredCapabilities: ['Health'] }),
        ).resolves.toBeTruthy(); // Health é not-supported no mapa: passa sem exigir device

        // granted mas ausente no retrato do fake (audio não está em capabilities)
        await expect(
            deviceManager.imbueSpell({ id: 44, name: 'Y', requiredCapabilities: ['Audio'] }),
        ).rejects.toThrow('devicesUnsupported:audio');
    });
});
