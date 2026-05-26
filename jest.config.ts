/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  collectCoverageFrom: ['src/**/*.ts', '!src/**/*.d.ts'],
  collectCoverage: true,
  coverageThreshold: {
    global: {
      branches: 70,
      functions: 80,
      lines: 75,
      statements: 75,
    },
  },
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^test/(.*)$': '<rootDir>/test/$1',
    '^zeromq$': '<rootDir>/src/test-utils/__mocks__/zeromq.ts',
    '^graph-crdt$': '<rootDir>/src/test-utils/__mocks__/graph-crdt.ts',
    '^chokidar$': '<rootDir>/src/security/__mocks__/chokidar.ts',
  },
  // Handle TypeScript path alias in test imports
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
  transformIgnorePatterns: [
    // Do not transform ESM-only dependencies
    '/node_modules/(?!(archiver|tar|tar-stream|minizlib|minipass|yauzl|bl|readable-stream)/)',
  ],
}
