module.exports = {
    preset: 'ts-jest',
    testEnvironment: 'node',
    roots: ['<rootDir>/src'],
    testMatch: ['**/__tests__/**/*.test.ts'],
    testPathIgnorePatterns: ['/node_modules/', '/__tests__/ai-quality/'],
    transform: {
        '^.+\\.tsx?$': 'ts-jest'
    },
    moduleFileExtensions: ['ts', 'js'],
    collectCoverageFrom: [
        'src/**/*.ts',
        '!src/**/*.d.ts',
        '!src/__tests__/**'
    ],
    coverageDirectory: 'coverage',
    verbose: true
};
