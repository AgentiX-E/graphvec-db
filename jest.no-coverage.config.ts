/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src'],
  testMatch: ['**/*.spec.ts'],
  collectCoverage: false,
  maxWorkers: 1,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^test/(.*)$': '<rootDir>/test/$1',
    '^zeromq$': '<rootDir>/src/test-utils/__mocks__/zeromq.ts',
    '^graph-crdt$': '<rootDir>/src/test-utils/__mocks__/graph-crdt.ts',
    '^chokidar$': '<rootDir>/src/security/__mocks__/chokidar.ts',
  },
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
    '/node_modules/(?!(archiver|tar|tar-stream|minizlib|minipass|yauzl|bl|readable-stream)/)',
  ],
}
