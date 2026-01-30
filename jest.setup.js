// Jest setup file for mocks

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
