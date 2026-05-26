/** @type {import('ts-jest').JestConfigWithTsJest} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/test/integration'],
  testMatch: ['**/*.test.ts'],
  testTimeout: 60000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
    '^chokidar$': '<rootDir>/src/security/__mocks__/chokidar.ts',
    '^archiver$': '<rootDir>/src/ops/__mocks__/archiver.js',
  },
  transform: {
    '^.+\\.tsx?$': [
      'ts-jest',
      {
        diagnostics: false,
      },
    ],
  },
  transformIgnorePatterns: [
    '/node_modules/(?!(archiver|tar|tar-stream|minizlib|minipass|yauzl|bl|readable-stream)/)',
  ],
}
