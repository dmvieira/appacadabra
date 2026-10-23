/**
 * L2 cross-repo integration: the real Appacadabra client stack
 * (lib/devices/*) against the real C++ device simulator (appa-sim).
 *
 * Auto-validating, zero hardware: the sim binary is built on demand from the
 * sibling ../appa repo (zig toolchain is cached under ../appa/.toolchain).
 * Everything is skipped when ../appa is absent (e.g. CI) so the root suite
 * stays green anywhere.
 */

import * as net from 'net';

import { AppaClient, AppaProtocolError } from '../../lib/devices/appaClient';
import { HelloPortrait, Mutation, frameEncode } from '../../lib/devices/protocol';
import { TcpTransport } from '../../lib/devices/transport';
import { transmuteSpell } from '../../lib/devices/transmute';
import { applyMutations } from '../../lib/devices/writeback';
import { hasAppaRepo, startSim, type SimHandle } from './simHarness';

const encoder = new TextEncoder();

let sim: SimHandle | null = null;

async function waitFor(check: () => void, message: string, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    for (;;) {
        try {
            check();
            return;
        } catch (e) {
            if (Date.now() - started > timeoutMs) throw new Error(`${message} (${timeoutMs}ms)`);
            await new Promise((r) => setTimeout(r, 100));
        }
    }
}

// Acesso tipado aos métodos internos do client nos testes de erro.
type ClientInternals = {
    conn: { write(d: Uint8Array): boolean };
    request: (t: never, p: Record<string, unknown>, e: string) => Promise<{ payload: Record<string, unknown> }>;
};

const describeFn = hasAppaRepo ? describe : describe.skip;

jest.setTimeout(180_000);

describeFn('appa L2 integration — Appacadabra client x appa-sim (C++)', () => {

    let client: AppaClient;

    beforeAll(async () => {
        sim = await startSim('fofura-sim');
        client = new AppaClient(new TcpTransport('127.0.0.1', sim.port));
    });

    afterAll(() => {
        client?.close();
        sim?.stop();
    });

    test('conexao entrega o retrato HELLO do dispositivo (v0.2)', async () => {
        const portrait: HelloPortrait = await client.connect();
        expect(portrait.name).toBe('fofura-sim');
        expect(portrait.proto).toBe(1);
        expect(portrait.device.model).toBe('host-sim');
        expect(portrait.device.capabilities).toEqual(
            expect.arrayContaining(['ai', 'sheets', 'forms', 'docs', 'calendar', 'audio']),
        );
        expect(portrait.device.requires).toEqual(expect.arrayContaining(['net', 'storage']));
        expect(portrait.wake.modes).toEqual(['flex', 'local', 'button']);
        expect(portrait.wake.phrase).toBe('fofura');
        expect(portrait.encantamentos).toEqual([]);
    });

    test('PAIR_REQUEST recebe PAIR_ACCEPT', async () => {
        await client.pair();
        expect(client.portrait?.name).toBe('fofura-sim');
    });

    test('PING/PONG', async () => {
        await client.ping();
    });

    test('GRANT_POWER concede e REVOKE_POWER revoga (cofre do device)', async () => {
        await client.grantPower('openrouter', 'sk-or-v1-test-key-123');
        await client.revokePower('openrouter');
    });

    test('SET_CONFIG aplica wake e nome', async () => {
        await client.setConfig({ wake: { threshold: 0.9, phrase: 'fofinha' }, name: 'fofura-2' });
    });

    test('ENCHANT armazena v1 e v2; reenvio de v1 é idempotente', async () => {
        const base = {
            encId: 'enc_l2test01',
            spellId: 'app_l2test',
            name: 'Gestão da Casa',
            prompt: 'Você é o guardião das tarefas de manutenção da casa.',
            data: { tarefas: [{ id: 1, t: 'trocar filtro' }] },
        };
        const ack1 = await client.enchant(transmuteSpell({ ...base, version: 1 }));
        expect(ack1).toMatchObject({ id: 'enc_l2test01', version: 1, stored: true });

        const ack2 = await client.enchant(transmuteSpell({ ...base, version: 2 }));
        expect(ack2).toMatchObject({ id: 'enc_l2test01', version: 2, stored: true });

        const stale = await client.enchant(transmuteSpell({ ...base, version: 1 }));
        expect(stale).toMatchObject({ id: 'enc_l2test01', version: 2, stored: false });
    });

    test('reconexão entrega retrato com o encantamento persistido', async () => {
        // Retrato só viaja em HELLO (conexão/PAIR) — reconectar para verificar
        // que o bundle sobreviveu no storage do device.
        client.close();
        client = new AppaClient(new TcpTransport('127.0.0.1', sim!.port));
        const portrait = await client.connect();
        expect(portrait.encantamentos).toEqual([{ id: 'enc_l2test01', version: 2, spellId: 'app_l2test' }]);
    });

    test('UNENCHANT remove; segunda tentativa erro UNKNOWN_ENCHANTMENT', async () => {
        await client.unenchant('enc_l2test01');
        await expect(client.unenchant('enc_l2test01')).rejects.toMatchObject({
            name: 'AppaProtocolError',
            code: 'UNKNOWN_ENCHANTMENT',
        });
    });

    test('frame corrompido no meio do fluxo não derruba a sessão (resync)', async () => {
        const rawBad = frameEncode(encoder.encode('lixo')) as Uint8Array;
        rawBad[rawBad.length - 1] ^= 0xff; // estraga o CRC
        const junk = new Uint8Array([0x00, 0x11, 0x22]);
        const conn = (client as unknown as ClientInternals).conn;
        conn.write(junk);
        conn.write(rawBad);
        await client.ping();
    });

    test('WRITEBACK do device chega ao client, aplica no storage e ACK limpa a fila', async () => {
        const store = new Map<string, string>([['tarefas', '{"itens":["filtro"]}']]);
        const io = {
            get: async (_appId: number, key: string) => (store.has(key) ? store.get(key)! : null),
            set: async (_appId: number, key: string, value: string) => {
                store.set(key, value);
            },
        };
        const received: Mutation[] = [];
        client.writebackHandler = async (mutations) => {
            received.push(...mutations);
            const r = await applyMutations(1, mutations, io);
            return { accepted: r.accepted, rejected: r.rejected };
        };

        sim!.write('MUTATE enc_l2test01 tarefas merge {"itens":["lâmpada"]}');

        await waitFor(
            () => expect(received.length).toBe(1),
            'WRITEBACK nao chegou ao client',
        );
        expect(received[0].enc).toBe('enc_l2test01');
        expect(received[0].op).toBe('merge');
        // merge real no app_storage fake
        expect(JSON.parse(store.get('tarefas')!)).toEqual({ itens: ['lâmpada'] });

        // O ACK automático do client limpou a fila: uma mutação nova gera um
        // WRITEBACK com apenas ela.
        sim!.write('MUTATE enc_l2test01 notas set "ok"');
        await waitFor(
            () => expect(received.length).toBe(2),
            'segundo WRITEBACK nao chegou',
        );
        expect(received[1].key).toBe('notas');
    });

    test('tipo válido porém desconhecido responde ERROR BAD_TYPE', async () => {
        await expect(
            (client as unknown as ClientInternals).request('FLUX_CAPACITOR' as never, {}, 'OK'),
        ).rejects.toMatchObject({ name: 'AppaProtocolError', code: 'BAD_TYPE' });
    });
});

// db mockado para o deviceManager (app_settings + storage por app)
const mockManagerStorage = new Map<string, string>([['7:tarefas', '{"itens":["filtro"]}']]);
const mockManagerSettings = new Map<string, string>();
jest.mock('../../lib/database/db', () => ({
    getStorageForApp: async (appId: number) =>
        [...mockManagerStorage.entries()]
            .filter(([k]) => k.startsWith(`${appId}:`))
            .map(([k, v], i) => ({ id: i, appId, key: k.split(':')[1], value: v })),
    getStorageItem: async (appId: number, key: string) => mockManagerStorage.get(`${appId}:${key}`) ?? null,
    setStorageItem: async (appId: number, key: string, value: string) => {
        mockManagerStorage.set(`${appId}:${key}`, value);
    },
    getSetting: async (k: string) => mockManagerSettings.get(k) ?? null,
    setSetting: async (k: string, v: string) => {
        mockManagerSettings.set(k, v);
    },
    getDataSchemas: async () => null,
    saveDataSchemas: async () => {},
}));

describe('appa L2 — deviceManager (produção) x appa-sim (C++)', () => {
    jest.setTimeout(60_000);

    test('fluxo completo do usuário: conectar → imbuir → MUTATE por voz → relíquia atualizada', async () => {
        const { deviceManager } = require('../../lib/devices/deviceManager');
        const { TcpTransport } = require('../../lib/devices/transport');
        const sim2 = await startSim('fofura-sim');
        try {
            const portrait = await deviceManager.connect(new TcpTransport('127.0.0.1', sim2.port));
            expect(portrait.device.capabilities).toContain('ai');

            // Imbução com permissionamento (AI granted → exige openrouter; device cobre 'ai')
            const result = await deviceManager.imbueSpell({ id: 7, name: 'Tarefas da Casa', requiredCapabilities: ['AI'] });
            expect(result.ack.stored).toBe(true);
            expect(result.mapping.powersToGrant).toEqual(['openrouter']);
            expect(result.bundle.data.tarefas).toBe('{"itens":["filtro"]}');

            // Concede o poder; cofre real do C++ responde OK
            await deviceManager.grantPower('openrouter', 'sk-or-v1-test');

            // Mutação "por voz" no device → WRITEBACK → applyMutations → ACK
            sim2.write(`MUTATE ${result.bundle.manifest.id} tarefas merge {"itens":["lâmpada"]}`);
            await waitFor(
                () => expect(JSON.parse(mockManagerStorage.get('7:tarefas')!)).toEqual({ itens: ['lâmpada'] }),
                'relíquia não foi atualizada pelo write-back',
            );

            const session = deviceManager.getSession();
            expect(session?.lastWritebackCount).toBe(1);
            deviceManager.disconnect();
        } finally {
            sim2.stop();
        }
    });

    test('wakeword: o nome É a wakeword — renameFamiliar/ensureWakeword viajam pro device e voltam no HELLO', async () => {
        const { deviceManager, DEFAULT_WAKE_WORD } = require('../../lib/devices/deviceManager');
        const { TcpTransport } = require('../../lib/devices/transport');
        const sim3 = await startSim('fofura-sim', undefined, ['--offline']);
        try {
            // Memória do app guarda um nome legado de fábrica ('fofura'):
            // ensureWakeword coage para o default 'Appa'.
            mockManagerSettings.set(
                'devices.known',
                JSON.stringify([{ id: 'sim3', name: 'fofura', lastSeen: 1 }]),
            );
            expect(DEFAULT_WAKE_WORD).toBe('Appa');
            await deviceManager.connect(new TcpTransport('127.0.0.1', sim3.port), 'sim3');
            expect(deviceManager.refreshPortrait()?.wake?.phrase).toBe('Appa');

            // O device REALMENTE recebeu a frase: o HELLO do sim relê config:wake.
            const p1 = await deviceManager.pullPortrait();
            expect(p1?.wake?.phrase).toBe('Appa');
            expect(p1?.name).toBe('Appa');

            // Renomear = trocar a wakeword (o firmware verifica a nova frase).
            await deviceManager.renameFamiliar('Luna');
            const p2 = await deviceManager.pullPortrait();
            expect(p2?.wake?.phrase).toBe('Luna');
            expect(p2?.name).toBe('Luna');

            // Teto de 10 bytes UTF-8 (acento = 2 bytes): 'Aniversário' = 11 bytes.
            await expect(deviceManager.renameFamiliar('Aniversário')).rejects.toThrow('devicesNameTooLong');

            deviceManager.disconnect();
        } finally {
            sim3.stop();
        }
    });
});

describe('appa client — fluxo WRITEBACK device→APP (fake device node)', () => {
    test('client responde WRITEBACK_ACK com ackOf do WRITEBACK recebido', async () => {
        const server = net.createServer();
        const port = await new Promise<number>((resolve) => {
            server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port));
        });

        // Fake device: envia HELLO na conexão, depois WRITEBACK; espera o ACK do APP.
        const wbSent = {
            v: 1,
            id: 'd0000042',
            type: 'WRITEBACK',
            payload: {
                mutations: [
                    { id: 'm1', enc: 'enc_ab12cd', key: 'tarefas', op: 'merge', value: '{"n":1}', ts: 1760000000000 },
                ],
            },
        };
        const ackReceived: string[] = [];
        const helloReceived: string[] = [];

        const gotAck = new Promise<void>((resolve) => {
            server.on('connection', (socket) => {
                const decoderFrames: Buffer[] = [];
                socket.on('data', (buf: Buffer) => {
                    // respostas do APP chegam enquadradas; decodifica ingenuamente
                    decoderFrames.push(buf);
                    const text = Buffer.concat(decoderFrames).toString();
                    if (text.includes('WRITEBACK_ACK')) {
                        const parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
                        ackReceived.push(parsed.type, parsed.ackOf ?? '');
                        ackReceived.push(JSON.stringify(parsed.payload.accepted));
                        resolve();
                    } else if (text.includes('PING')) {
                        helloReceived.push('ping');
                    }
                });
                const hello = { v: 1, id: 'd0000041', type: 'HELLO', payload: { name: 'fake', proto: 1, encantamentos: [] } };
                const send = (obj: unknown) => socket.write(Buffer.from(frameEncode(encoder.encode(JSON.stringify(obj))) as Uint8Array));
                send(hello);
                setTimeout(() => send(wbSent), 50);
            });
        });

        const client = new AppaClient(new TcpTransport('127.0.0.1', port));
        const decisions: string[][] = [];
        client.writebackHandler = (mutations) => {
            decisions.push(mutations.map((m) => m.id));
            return { accepted: mutations.map((m) => m.id), rejected: [] };
        };
        await client.connect();
        await gotAck;

        expect(decisions).toEqual([['m1']]);
        expect(ackReceived[0]).toBe('WRITEBACK_ACK');
        expect(ackReceived[1]).toBe('d0000042'); // ackOf correlaciona o WRITEBACK
        expect(JSON.parse(ackReceived[2])).toEqual(['m1']);

        client.close();
        server.close();
    });
});
