/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>'],
  testMatch: ['**/test/eventbus-curve.spec.ts'],
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  // 使用真实的 zeromq（不 mock）
  modulePathIgnorePatterns: ['<rootDir>/src/test-utils/__mocks__'],
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        tsconfig: {
          allowImportingTsExtensions: false,
          moduleResolution: 'node',
        },
        diagnostics: false,
      },
    ],
  },
}
