import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    coverage: {
      enabled: true,
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts', 'src/test-utils/**', 'src/security/__mocks__/**', 'src/**/*.d.ts'],
      reporter: ['text', 'text-summary', 'json'],
      reportsDirectory: './coverage',
    },
    environment: 'node',
    include: ['src/**/*.spec.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 1200000,
    hookTimeout: 1200000,
    globals: true,
    pool: 'threads',
    singleThread: true,
    server: {
      deps: {
        exclude: ['raft-logic'],
      },
    },
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'test': path.resolve(__dirname, 'test'),
      'graph-crdt': path.resolve(__dirname, 'src/test-utils/__mocks__/graph-crdt.ts'),
      'chokidar': path.resolve(__dirname, 'src/security/__mocks__/chokidar.ts'),
    },
  },
})
