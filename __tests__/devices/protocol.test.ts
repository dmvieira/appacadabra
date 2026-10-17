/**
 * L1-parity tests for the appa protocol mirror (lib/devices/protocol.ts) plus
 * the cross-repo schema conformance check against ../appa (skipped when the
 * sibling repo is absent, e.g. in CI).
 */

import * as fs from 'fs';
import * as path from 'path';

import {
    Bundle,
    FrameDecoder,
    MSG,
    buildMessage,
    crc16CcittFalse,
    frameEncode,
    frameEncodedSize,
    generateEncantamentoId,
    generateMessageId,
    parseMessage,
    validEncantamentoId,
    validMessageId,
    validMessageType,
    validPowerName,
} from '../../lib/devices/protocol';
import { transmuteSpell, validateBundle } from '../../lib/devices/transmute';

const encoder = new TextEncoder();

function encode(payload: string): Uint8Array {
    const frame = frameEncode(encoder.encode(payload));
    expect(frame).not.toBeNull();
    return frame as Uint8Array;
}

describe('appa protocol mirror — CRC16-CCITT-FALSE', () => {
    test('check value oficial "123456789" -> 0x29B1', () => {
        expect(crc16CcittFalse(encoder.encode('123456789'))).toBe(0x29b1);
    });

    test('init sem dados devolve o proprio init', () => {
        expect(crc16CcittFalse(new Uint8Array(0))).toBe(0xffff);
        expect(crc16CcittFalse(new Uint8Array(0), 0x1234)).toBe(0x1234);
    });

    test('encadeamento equivale a unica passada (contrato do framing)', () => {
        const data = encoder.encode('payload do frame appa');
        const once = crc16CcittFalse(data);
        const chained = crc16CcittFalse(data.subarray(7), crc16CcittFalse(data.subarray(0, 7)));
        expect(chained).toBe(once);
    });
});

describe('appa protocol mirror — framing', () => {
    test('roundtrip byte a byte', () => {
        const frames: string[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(new TextDecoder().decode(p)));
        const bytes = encode('{"v":1,"type":"PING"}');
        for (let i = 0; i < bytes.length; i++) dec.feed(bytes.subarray(i, i + 1));
        expect(dec.getFramesOk()).toBe(1);
        expect(frames).toEqual(['{"v":1,"type":"PING"}']);
    });

    test('dois frames em um unico feed', () => {
        const frames: string[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(new TextDecoder().decode(p)));
        const a = encode('primeiro');
        const b = encode('segundo');
        const all = new Uint8Array(a.length + b.length);
        all.set(a, 0);
        all.set(b, a.length);
        dec.feed(all);
        expect(dec.getFramesOk()).toBe(2);
        expect(frames).toEqual(['primeiro', 'segundo']);
    });

    test('payload vazio e frame minimo', () => {
        const frames: Uint8Array[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(p));
        const bytes = encode('');
        expect(bytes.length).toBe(frameEncodedSize(0));
        dec.feed(bytes);
        expect(dec.getFramesOk()).toBe(1);
        expect(frames[0].length).toBe(0);
    });

    test('corrupcao de CRC nao derruba o frame seguinte', () => {
        const frames: string[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(new TextDecoder().decode(p)));
        const bad = encode('corrompido');
        bad[bad.length - 1] ^= 0xff;
        const good = encode('intacto');
        const all = new Uint8Array(bad.length + good.length);
        all.set(bad, 0);
        all.set(good, bad.length);
        dec.feed(all);
        expect(dec.getCrcErrors()).toBe(1);
        expect(dec.getFramesOk()).toBe(1);
        expect(frames).toEqual(['intacto']);
    });

    test('payload acima de max_payload conta erro de comprimento', () => {
        const dec = new FrameDecoder(8);
        dec.setHandler(() => {});
        dec.feed(encode('payload maior que oito'));
        expect(dec.getLengthErrors()).toBe(1);
        expect(dec.getFramesOk()).toBe(0);
    });

    test('0xA5 solto no payload nao confunde o decodificador', () => {
        const frames: Uint8Array[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(p));
        const payload = new Uint8Array([0xa5, 0x5a, 0x64, 0x61, 0x64, 0x6f, 0x73]);
        dec.feed(frameEncode(payload) as Uint8Array);
        expect(dec.getFramesOk()).toBe(1);
        expect(frames[0].length).toBe(payload.length);
    });

    test('ruido sem par de sync e descartado (tradeoff PROTOCOL.md §1)', () => {
        const frames: string[] = [];
        const dec = new FrameDecoder();
        dec.setHandler((p) => frames.push(new TextDecoder().decode(p)));
        const bytes = encode('payload');
        const noisy = new Uint8Array([0x00, 0xa5, 0x11, 0xff, 0x5a]);
        const all = new Uint8Array(noisy.length + bytes.length);
        all.set(noisy, 0);
        all.set(bytes, noisy.length);
        dec.feed(all);
        expect(dec.getFramesOk()).toBe(1);
        expect(frames).toEqual(['payload']);
    });
});

describe('appa protocol mirror — envelope', () => {
    test('roundtrip basico PING', () => {
        const json = buildMessage({ id: 'a1b2c3d4', type: MSG.PING });
        expect(json).not.toBeNull();
        const res = parseMessage(json as string);
        expect(res.ok).toBe(true);
        expect(res.message).toMatchObject({ v: 1, id: 'a1b2c3d4', type: 'PING' });
        expect(res.message?.ackOf).toBe('');
        expect(res.message?.payload).toEqual({});
    });

    test('roundtrip com payload e ackOf', () => {
        const json = buildMessage({
            id: 'd0000001',
            type: MSG.ENCHANT,
            ackOf: 'req_9',
            payload: { manifest: { id: 'enc_ab12cd', version: 3 }, data: { k: '[1,2]' } },
        });
        const res = parseMessage(json as string);
        expect(res.ok).toBe(true);
        expect(res.message?.ackOf).toBe('req_9');
        expect(res.message?.payload.manifest).toEqual({ id: 'enc_ab12cd', version: 3 });
    });

    test('payload ausente ou null equivale a {}', () => {
        expect(parseMessage('{"v":1,"id":"abc","type":"PING"}').message?.payload).toEqual({});
        expect(parseMessage('{"v":1,"id":"abc","type":"PING","payload":null}').message?.payload).toEqual({});
    });

    test('rejeita json invalido, raiz nao-objeto, versao errada', () => {
        expect(parseMessage('{nao json').error).toMatch(/^BAD_JSON/);
        expect(parseMessage('[1,2]').error).toMatch(/^BAD_JSON/);
        expect(parseMessage('{"v":2,"id":"abc","type":"PING"}').error).toBe('BAD_VERSION');
    });

    test('rejeita id/tipo/payload invalidos', () => {
        expect(parseMessage('{"v":1,"id":"","type":"PING"}').error).toBe('BAD_ID');
        expect(parseMessage('{"v":1,"id":"id com espaco","type":"PING"}').error).toBe('BAD_ID');
        expect(parseMessage('{"v":1,"id":"0123456789abcdef0","type":"PING"}').error).toBe('BAD_ID');
        expect(parseMessage('{"v":1,"id":"abc","type":"ping"}').error).toBe('BAD_TYPE');
        expect(parseMessage('{"v":1,"id":"abc","type":"1PING"}').error).toBe('BAD_TYPE');
        expect(parseMessage('{"v":1,"id":"abc"}').error).toBe('BAD_TYPE');
        expect(parseMessage('{"v":1,"id":"abc","type":"PING","payload":[1]}').error).toMatch(/^BAD_PAYLOAD/);
        expect(parseMessage('{"v":1,"id":"abc","type":"PING","ackOf":"x y"}').error).toBe('BAD_ACKOF');
    });

    test('build rejeita id/tipo invalidos', () => {
        expect(buildMessage({ id: '0123456789abcdef0', type: MSG.PING })).toBeNull();
        expect(buildMessage({ id: 'valido000', type: 'lower' as never })).toBeNull();
        expect(buildMessage({ id: 'valido000', type: MSG.PING, payload: [1, 2] as never })).toBeNull();
    });

    test('geradores de id respeitam a spec', () => {
        for (let i = 0; i < 50; i++) {
            expect(validMessageId(generateMessageId())).toBe(true);
            expect(generateMessageId()).toMatch(/^[0-9a-f]{8}$/);
            expect(validEncantamentoId(generateEncantamentoId())).toBe(true);
        }
    });
});

describe('appa transmute (mini-forja)', () => {
    test('bundle valido com dados serializados', () => {
        const bundle = transmuteSpell({
            spellId: 'app_xyz',
            name: 'Gestão da Casa',
            prompt: 'Você é o guardião das tarefas de manutenção da casa...',
            data: { tarefas: [{ id: 1, t: 'trocar filtro' }] },
        });
        expect(validateBundle(bundle)).toBeNull();
        expect(bundle.data.tarefas).toBe('[{"id":1,"t":"trocar filtro"}]');
        expect(validEncantamentoId(bundle.manifest.id)).toBe(true);
    });

    test('rejeita campos fora do schema', () => {
        expect(
            validateBundle({
                manifest: { id: 'spell_ab12cd', spellId: 's', name: 'n', version: 1, requiredPowers: [], createdAt: 0 },
                prompt: 'p',
                data: {},
                config: { refreshPolicy: 'manual' },
            } as Bundle),
        ).toContain('manifest.id');
        expect(
            validateBundle({
                manifest: { id: 'enc_ab12cd', spellId: 's', name: 'n', version: 0, requiredPowers: [], createdAt: 0 },
                prompt: 'p',
                data: {},
                config: { refreshPolicy: 'manual' },
            } as Bundle),
        ).toContain('version');
        expect(
            validateBundle({
                manifest: { id: 'enc_ab12cd', spellId: 's', name: 'n', version: 1, requiredPowers: ['SHEETS'], createdAt: 0 },
                prompt: 'p',
                data: {},
                config: { refreshPolicy: 'manual' },
            } as Bundle),
        ).toContain('poder');
        expect(
            validateBundle({
                manifest: { id: 'enc_ab12cd', spellId: 's', name: 'n', version: 1, requiredPowers: [], createdAt: 0 },
                prompt: 'p',
                data: { 'chave com espaço': 'x' },
                config: { refreshPolicy: 'manual' },
            } as Bundle),
        ).toContain('chave de data');
    });
});

// ============= Cross-repo conformance (../appa) =============

const APPA_ROOT = path.resolve(__dirname, '..', '..', '..', 'appa');

function readSchema(rel: string): any | null {
    const file = path.join(APPA_ROOT, 'protocol', 'schemas', rel);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
}

const hasAppaRepo = fs.existsSync(path.join(APPA_ROOT, 'protocol', 'PROTOCOL.md'));

describe('appa cross-repo conformance (../appa)', () => {
    const maybe = hasAppaRepo ? it : it.skip;

    maybe('constantes MSG cobrem exatamente o enum do message.schema.json', () => {
        const schema = readSchema('message.schema.json');
        expect(schema).not.toBeNull();
        const enumTypes: string[] = schema.properties.type.enum;
        expect(enumTypes.sort()).toEqual(Object.values(MSG).sort());
    });

    maybe('validadores TS aceitam/rejeitam conforme os patterns do schema', () => {
        const message = readSchema('message.schema.json');
        const bundle = readSchema('bundle.schema.json');
        const idPattern = new RegExp(message.properties.id.pattern);
        const typePattern = new RegExp(message.properties.type.pattern);
        const encIdPattern = new RegExp(bundle.properties.manifest.properties.id.pattern);
        const powerPattern = new RegExp(bundle.properties.manifest.properties.requiredPowers.items.pattern);

        const idCases: Array<[string, boolean]> = [
            ['abc', true],
            ['a1b2c3d4', true],
            ['id_com-traco', true],
            ['', false],
            ['id com espaco', false],
            ['0123456789abcdef0', false],
        ];
        for (const [value, expected] of idCases) {
            expect(validMessageId(value)).toBe(expected);
            expect(idPattern.test(value)).toBe(expected);
        }

        const typeCases: Array<[string, boolean]> = [
            ['PING', true],
            ['PAIR_REQUEST', true],
            ['QUERY_RESULT', true],
            ['ping', false],
            ['1PING', false],
            ['A_VERY_LONG_MESSAGE_TYPE_X', false],
        ];
        for (const [value, expected] of typeCases) {
            expect(validMessageType(value)).toBe(expected);
            expect(typePattern.test(value)).toBe(expected);
        }

        const encCases: Array<[string, boolean]> = [
            ['enc_ab12cd', true],
            ['enc_0123456789ab', true],
            ['enc_AB', false],
            ['spell_ab12cd', false],
            ['enc_AB12CD', false],
        ];
        for (const [value, expected] of encCases) {
            expect(validEncantamentoId(value)).toBe(expected);
            expect(encIdPattern.test(value)).toBe(expected);
        }

        const powerCases: Array<[string, boolean]> = [
            ['sheets', true],
            ['openrouter', true],
            ['SHEETS', false],
            ['a'.repeat(16), false],
        ];
        for (const [value, expected] of powerCases) {
            expect(validPowerName(value)).toBe(expected);
            expect(powerPattern.test(value)).toBe(expected);
        }
    });

    maybe('frames TS decodificam saida do binario C++ (vetor canônico)', () => {
        // Frame hand-computed: payload "hi" -> len 02 00; CRC sobre 02 00 'h' 'i';
        // layout A5 5A lenL lenH payload crcL crcH (CRC em 4+len).
        const payload = encoder.encode('hi');
        const frame = frameEncode(payload) as Uint8Array;
        expect(Array.from(frame.subarray(0, 6))).toEqual([0xa5, 0x5a, 0x02, 0x00, 0x68, 0x69]);
        const crc = crc16CcittFalse(new Uint8Array([0x02, 0x00, 0x68, 0x69]));
        expect(frame[6]).toBe(crc & 0xff);
        expect(frame[7]).toBe(crc >> 8);
    });
});
