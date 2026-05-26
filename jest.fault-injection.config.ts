export default {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/fault-injection'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 30000,
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      { diagnostics: false },
    ],
  },
}
