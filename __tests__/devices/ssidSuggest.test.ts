/**
 * resolveSuggestedSsid — ordem de sugestão do SSID no ritual de WiFi:
 * rede que o FAMILIAR conhece > rede atual do celular > última usada.
 * Sanitiza aspas do WifiInfo e o placeholder `<unknown ssid>`.
 */

import { resolveSuggestedSsid } from '../../lib/devices/wifiInfo';

describe('resolveSuggestedSsid', () => {
    test('prioriza a rede do familiar, depois o celular, depois a última', () => {
        expect(resolveSuggestedSsid('casa-familiar', 'casa-celular', 'antiga')).toBe('casa-familiar');
        expect(resolveSuggestedSsid(null, 'casa-celular', 'antiga')).toBe('casa-celular');
        expect(resolveSuggestedSsid(null, null, 'antiga')).toBe('antiga');
    });

    test('sanitiza aspas do WifiInfo e `<unknown ssid>`', () => {
        expect(resolveSuggestedSsid('"PICADINHO FOFO"', 'x', 'y')).toBe('PICADINHO FOFO');
        expect(resolveSuggestedSsid('<unknown ssid>', 'celular', 'y')).toBe('celular');
        expect(resolveSuggestedSsid(null, '<unknown ssid>', 'antiga')).toBe('antiga');
    });

    test('vazios/brancos não bloqueiam a cascata; nada disponível = null', () => {
        expect(resolveSuggestedSsid('', '  ', 'antiga')).toBe('antiga');
        expect(resolveSuggestedSsid(null, '', '')).toBeNull();
        expect(resolveSuggestedSsid(null, null, null)).toBeNull();
    });
});
