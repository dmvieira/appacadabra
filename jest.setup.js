// Jest setup file for mocks

// Override expo winter runtime lazy getters that crash in Node test environment.
// expo/src/winter/runtime.native.ts installs these as lazy getters during the react-native
// jest preset's setupFiles phase. When triggered from within a test module they run in the
// wrong runtime context (isInsideTestCode === false) and throw. We replace them with the
// Node.js built-ins (or safe stubs) before any test module is loaded.
(function overrideExpoWinterGlobals() {
    const safeDefine = (name, value) => {
        try {
            Object.defineProperty(global, name, { value, writable: true, configurable: true });
        } catch (e) {
            global[name] = value;
        }
    };
    safeDefine('__ExpoImportMetaRegistry', { url: null });
    safeDefine('structuredClone', global.structuredClone || ((v) => JSON.parse(JSON.stringify(v))));
    safeDefine('TextDecoder', global.TextDecoder);
    safeDefine('TextDecoderStream', global.TextDecoderStream || class TextDecoderStream {});
    safeDefine('TextEncoderStream', global.TextEncoderStream || class TextEncoderStream {});
    safeDefine('URL', global.URL);
    safeDefine('URLSearchParams', global.URLSearchParams);
}());

// Mock expo modules
jest.mock('expo-file-system/legacy', () => ({
    documentDirectory: '/mock/documents/',
    cacheDirectory: '/mock/cache/',
    readAsStringAsync: jest.fn(),
    writeAsStringAsync: jest.fn(),
    deleteAsync: jest.fn(),
    getInfoAsync: jest.fn(),
    makeDirectoryAsync: jest.fn(),
    EncodingType: { UTF8: 'utf8', Base64: 'base64' }
}));

jest.mock('expo-sharing', () => ({
    isAvailableAsync: jest.fn(() => Promise.resolve(true)),
    shareAsync: jest.fn()
}));

jest.mock('expo-document-picker', () => ({
    getDocumentAsync: jest.fn()
}));

jest.mock('expo-notifications', () => ({
    getPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
    requestPermissionsAsync: jest.fn(() => Promise.resolve({ status: 'granted' })),
    scheduleNotificationAsync: jest.fn()
}));

jest.mock('expo-localization', () => ({
    getLocales: () => [{ languageCode: 'en' }]
}));

// Mock react-native AsyncStorage
jest.mock('@react-native-async-storage/async-storage', () => ({
    setItem: jest.fn(),
    getItem: jest.fn(),
    removeItem: jest.fn(),
    clear: jest.fn()
}));

// Mock Firebase
jest.mock('@react-native-firebase/auth', () => ({
    getAuth: jest.fn(() => ({ currentUser: { uid: 'test-user-id' } })),
    signInAnonymously: jest.fn(),
    onAuthStateChanged: jest.fn()
}));

jest.mock('@react-native-firebase/firestore', () => ({
    getFirestore: jest.fn(),
    doc: jest.fn(),
    collection: jest.fn(),
    onSnapshot: jest.fn(),
    addDoc: jest.fn(),
    serverTimestamp: jest.fn()
}));

jest.mock('@react-native-firebase/functions', () => ({
    getFunctions: jest.fn(),
    httpsCallable: jest.fn()
}));

// Global console suppression for cleaner test output
global.console = {
    ...console,
    log: jest.fn(),
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
};
