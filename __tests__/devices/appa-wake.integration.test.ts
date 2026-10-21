/**
 * L2 cross-repo: wakeword custom do Familiar ponta a ponta, sem hardware e sem
 * rede. O appacadabra configura a wakeword (o nome É a wakeword) no appa-sim
 * real (C++); o sim simula o identificador (WAKE <frase>) e, acordado, o STT
 * injetado (VOICE <transcricao>) -> route_query -> QUERY_RESULT.
 *
 * Valida a tríade pedida: acordar o dispositivo -> escutar -> executar o
 * encantamento CORRETO. A verificação contra áudio real fica no hardware (ver
 * docs/DEVICE_E2E_REPORT.md, Fase G).
 */

import { AppaClient } from '../../lib/devices/appaClient';
import { transmuteSpell } from '../../lib/devices/transmute';
import { TcpTransport } from '../../lib/devices/transport';
import { hasAppaRepo, startSim, type SimHandle } from './simHarness';

const describeFn = hasAppaRepo ? describe : describe.skip;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(check: () => void, message: string, timeoutMs = 5000): Promise<void> {
    const started = Date.now();
    for (;;) {
        try {
            check();
            return;
        } catch (e) {
            if (Date.now() - started > timeoutMs) throw new Error(`${message} (${timeoutMs}ms)`);
            await delay(100);
        }
    }
}

describeFn('appa wakeword L2 — acordar -> escutar -> encantamento certo (sim offline)', () => {
    jest.setTimeout(120_000);

    let sim: SimHandle;
    let client: AppaClient;

    beforeAll(async () => {
        sim = await startSim('fofura-sim', undefined, ['--offline']);
        client = new AppaClient(new TcpTransport('127.0.0.1', sim.port));
    });

    afterAll(() => {
        client?.close();
        sim?.stop();
    });

    test('wake custom: frase certa acorda e a pergunta cai no encantamento certo', async () => {
        const portrait = await client.connect();
        expect(portrait.wake.modes).toEqual(expect.arrayContaining(['flex', 'local', 'button']));

        // O appacadabra configura a wakeword custom ("Appa") — o nome É a wakeword.
        await client.setConfig({ name: 'Appa', wake: { mode: 'flex', phrase: 'Appa' } });
        sim.write('HELLO');
        await waitFor(
            () => expect(client.portrait?.wake?.phrase).toBe('Appa'),
            'HELLO não refletiu a wakeword custom',
        );

        // Duas spells com roteamento distinto (keywords).
        const compras = transmuteSpell({
            encId: 'enc_c0ffee1',
            spellId: 'app_1',
            name: 'Compras',
            prompt: 'Você guarda a lista de compras da casa.',
            data: { lista: JSON.stringify(['arroz', 'café']) },
            keywords: ['lista de compras', 'mercado'],
        });
        const tarefas = transmuteSpell({
            encId: 'enc_ta6e1a',
            spellId: 'app_2',
            name: 'Tarefas da Casa',
            prompt: 'Você guarda as tarefas de manutenção da casa.',
            data: { tarefas: JSON.stringify(['lavar louça']) },
            keywords: ['afazeres'],
        });
        await client.enchant(compras);
        await client.enchant(tarefas);

        const results: Array<{ enc: string; q: string; a: string }> = [];
        client.queryResultHandler = (qr) => results.push(qr);

        // 1) Dormindo: VOICE não é atendido (nada de QUERY_RESULT).
        sim.write('VOICE qual é a minha lista de compras?');
        await delay(400);
        expect(results.length).toBe(0);

        // 2) Frase ERRADA (default de fábrica): não acorda -> não escuta.
        sim.write('WAKE fofura');
        await delay(300);
        sim.write('VOICE qual é a minha lista de compras?');
        await delay(400);
        expect(results.length).toBe(0);

        // 3) Frase CERTA "Appa": acorda -> escuta -> encantamento Compras.
        sim.write('WAKE Appa');
        await delay(300);
        sim.write('VOICE qual é a minha lista de compras?');
        await waitFor(() => expect(results.length).toBe(1), 'QUERY_RESULT não chegou');
        expect(results[0].enc).toBe('enc_c0ffee1');
        expect(results[0].q).toBe('qual é a minha lista de compras?');

        // 4) Case-insensitive e roteamento para o OUTRO encantamento.
        sim.write('WAKE appa');
        await delay(300);
        sim.write('VOICE o que tenho de afazeres');
        await waitFor(() => expect(results.length).toBe(2), 'segundo QUERY_RESULT não chegou');
        expect(results[1].enc).toBe('enc_ta6e1a');
    });
});
