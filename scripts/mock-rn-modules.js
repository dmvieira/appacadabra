/**
 * mock-rn-modules.js
 *
 * Mocks all React Native / Expo native packages so that ts-node can import
 * capability modules (which import from 'expo-sharing', 'expo-print', etc.)
 * without requiring a native build environment.
 *
 * Usage: ts-node --require ./scripts/mock-rn-modules.js <script>
 */

const Module = require('module');
const _origLoad = Module._load.bind(Module);

const NATIVE_PREFIXES = [
    'react-native',
    'expo-',
    '@react-native',
    '@expo/',
    '@unimodules',
    'react-native-view-shot',
    'react-native-webview',
    '@react-native-async-storage',
    '@react-native-community',
    '@react-native-google-signin',
    '@react-native-firebase',
];

function makeProxy() {
    // Returns a recursive Proxy that satisfies any property/call access chain.
    const handler = {
        get: (_target, prop) => {
            if (prop === 'then') return undefined; // not a Promise
            if (prop === '__esModule') return true;
            return makeProxy();
        },
        apply: () => makeProxy(),
        construct: () => makeProxy(),
    };
    return new Proxy(function () {}, handler);
}

Module._load = function (request, parent, isMain) {
    const isNative = NATIVE_PREFIXES.some(
        prefix => request === prefix || request.startsWith(prefix + '/') || request.startsWith(prefix + '\\'),
    );
    if (isNative) {
        return makeProxy();
    }
    return _origLoad(request, parent, isMain);
};
