/**
 * N1.7 — UI↔device integration (in-app L2): renders the real Devices screen
 * with the production DeviceManager, a mocked native AppaTcpModule that
 * speaks real TCP, and the real C++ appa-sim. Runs in `npm test` whenever
 * the ../appa sibling repo is present.
 */

import * as fs from 'fs';
import * as path from 'path';

import { DeviceEventEmitter, NativeModules } from 'react-native';

const APPA_ROOT = path.resolve(__dirname, '..', '..', '..', 'appa');
const hasAppaRepo = fs.existsSync(path.join(APPA_ROOT, 'protocol', 'PROTOCOL.md'));

// db mock (getStorageForApp do imbue; settings do índice enc→app)
jest.mock('../../lib/database/db', () => ({
    getStorageForApp: async () => [],
    getSetting: async () => null,
    setSetting: async () => {},
}));

jest.mock('../../lib/i18n', () => ({ t: (k: string) => k }));

jest.mock('expo-router', () => ({
    Stack: { Screen: () => null },
    useRouter: () => ({ push: jest.fn(), back: jest.fn() }),
    useLocalSearchParams: () => ({}),
    useFocusEffect: () => {},
}));

const { Alert } = require('react-native');
jest.spyOn(Alert, 'alert').mockImplementation((title, msg) => {
    console.log('ALERT:', title, '|', String(msg).slice(0, 100));
});

const net = require('net');
const rtl = require('@testing-library/react-native');
const { fireEvent, waitFor } = rtl;
const { deviceManager } = require('../../lib/devices/deviceManager');
const { startSim } = require('./simHarness');

// Native TCP module: mesmo contrato JS do AppaTcpModule.kt, sobre Node net.
let mockSocket: import('net').Socket | null = null;
NativeModules.AppaTcpModule = {
    connect: async (host: string, port: number) => {
        mockSocket = net.connect(port, host === '10.0.2.2' ? '127.0.0.1' : host);
        await new Promise<void>((resolve, reject) => {
            mockSocket!.once('connect', resolve);
            mockSocket!.once('error', reject);
        });
        mockSocket!.on('data', (buf: Buffer) => {
            DeviceEventEmitter.emit('AppaTcpData', { base64: Buffer.from(buf).toString('base64') });
        });
    },
    write: (b64: string) => {
        mockSocket?.write(Buffer.from(b64, 'base64'));
    },
    disconnect: () => {
        mockSocket?.destroy();
        mockSocket = null;
    },
};

const describeFn = hasAppaRepo ? describe : describe.skip;

describeFn('devices UI — tela Familiares x appa-sim (C++)', () => {
    jest.setTimeout(60_000);

    let sim: { port: number; write(l: string): void; stop(): void } | null = null;

    beforeAll(async () => {
        // Porta fixa 7788 = default da tela (o input de porta não precisa mudar)
        sim = await startSim('fofura-sim', 7788);
    });

    afterAll(() => {
        deviceManager.disconnect();
        sim?.stop();
    });

    test('conectar via UI (botão) entrega o retrato do device real', async () => {
        const DevicesScreen = require('../../app/devices/index').default;
        await rtl.render(<DevicesScreen />);

        // host:porta ficam em "Avançado" agora — abre para apontar ao sim
        rtl.fireEvent.press(rtl.screen.getByText(/advanced/i));
        const hostInput = await rtl.screen.findByPlaceholderText('10.0.2.2');
        rtl.fireEvent.changeText(hostInput, '127.0.0.1');

        rtl.fireEvent.press(rtl.screen.getByText('devicesConnect'));

        await waitFor(
            () => expect(rtl.screen.getByText('fofura-sim')).toBeTruthy(),
            { timeout: 10_000 },
        );
        // retrato v0.2 renderizado
        expect(rtl.screen.getByText(/host-sim/)).toBeTruthy();
        expect(rtl.screen.getByText('devicesPowers')).toBeTruthy();
        expect(rtl.screen.getByText('devicesNoPowers')).toBeTruthy();

        // write-back wiring ativo (sessão do manager)
        expect(deviceManager.getSession()?.portrait.name).toBe('fofura-sim');

        // desconecta pela UI — o manager encerra a sessão (o re-render do
        // form é coberto pelo subscription; no ambiente de teste validamos o estado)
        rtl.fireEvent.press(rtl.screen.getByText('devicesDisconnect'));
        await waitFor(() => expect(deviceManager.getSession()).toBeNull());
    });
});
