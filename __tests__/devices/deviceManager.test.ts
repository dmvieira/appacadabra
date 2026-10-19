/**
 * deviceManager — session wiring: WRITEBACK do device resolve para a spell de
 * origem (índice enc→app persistido) e aplica no app_storage; imbueSpell
 * transmuta, checa cobertura de capabilities e enfeitiça.
 */

import * as net from 'net';

import { deviceManager, spellIdToAppId } from '../../lib/devices/deviceManager';
import { frameEncode } from '../../lib/devices/protocol';
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
}));

describe('deviceManager', () => {
    let server: net.Server;
    let port: number;
    const sentFrames: string[] = [];

    beforeAll(async () => {
        server = net.createServer();
        port = await new Promise<number>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });
        server.on('connection', (socket) => {
            const hello = { v: 1, id: 'd1', type: 'HELLO', payload: { name: 'fam', proto: 1, device: { model: 'm', powers: [], capabilities: ['ai', 'sheets'] }, encantamentos: [] } };
            const send = (obj: unknown) => socket.write(Buffer.from(frameEncode(encoder.encode(JSON.stringify(obj))) as Uint8Array));
            send(hello);
            socket.on('data', (buf) => {
                sentFrames.push(buf.toString());
                const text = buf.toString();
                if (text.includes('ENCHANT')) {
                    send({ v: 1, id: 'd2', type: 'ENCHANT_ACK', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: { id: 'enc_mgr01', version: 1, stored: true } });
                } else if (text.includes('PING')) {
                    send({ v: 1, id: 'd3', type: 'PONG', ackOf: JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)).id, payload: {} });
                }
            });
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
