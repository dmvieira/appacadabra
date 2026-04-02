module.exports = {
    preset: 'jest-expo',
    testEnvironment: 'node',
    testMatch: ['**/__tests__/**/*.test.ts', '**/__tests__/**/*.test.tsx'],
    transformIgnorePatterns: [
        'node_modules/(?!((jest-)?react-native|@react-native(-community)?)|expo(nent)?|@expo(nent)?/.*|@expo-google-fonts/.*|react-navigation|@react-navigation/.*|@unimodules/.*|unimodules|sentry-expo|native-base|react-native-svg|zustand|marked)'
    ],
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
    setupFilesAfterEnv: ['<rootDir>/jest.setup.js'],
    collectCoverageFrom: [
        'lib/**/*.{ts,tsx}',
        '!lib/**/*.d.ts',
        '!lib/**/index.ts'
    ],
    moduleNameMapper: {
        '^@/(.*)$': '<rootDir>/$1',
        'expo/src/winter/runtime\\.native': '<rootDir>/__mocks__/expo-winter-runtime.js'
    }
};
