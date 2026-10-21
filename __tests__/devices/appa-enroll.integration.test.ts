/**
 * L2 cross-repo: cadastro da wakeword contra o appa-sim real (C++) — protocolo
 * ENROLL_* de ponta a ponta e `wake.enrolled` refletido no HELLO.
 */

import { AppaClient } from '../../lib/devices/appaClient';
import { TcpTransport } from '../../lib/devices/transport';
import { hasAppaRepo, startSim, type SimHandle } from './simHarness';

const describeFn = hasAppaRepo ? describe : describe.skip;
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describeFn('appa enroll L2 — cadastro da wakeword (sim C++)', () => {
    jest.setTimeout(60_000);

    let sim: SimHandle;
    let client: AppaClient;

    beforeAll(async () => {
        sim = await startSim('appa-sim');
        client = new AppaClient(new TcpTransport('127.0.0.1', sim.port));
    });

    afterAll(() => {
        client?.close();
        sim?.stop();
    });

    test('ENROLL_START -> 3 amostras -> calibrar -> commit; HELLO reflete enrolled', async () => {
        const portrait = await client.connect();
        expect(portrait.wake?.enrolled).toBe(false);

        const ackStart = await client.enrollStart();
        expect(ackStart.stage).toBe('start');

        for (let i = 0; i < 3; i++) {
            const r = await client.enrollSample();
            expect(r.ok).toBe(true);
            expect(r.index).toBe(1);
        }
        const calib = await client.enrollCalibrate();
        expect(calib.ok).toBe(true);
        expect(calib.stage).toBe('calibrate');

        const ack = await client.enrollCommit();
        expect(ack.enrolled).toBe(true);
        expect(ack.templates).toBe(3);

        // HELLO reemitido mostra o cadastro
        sim.write('HELLO');
        await delay(400);
        expect(client.portrait?.wake?.enrolled).toBe(true);
    });
});
