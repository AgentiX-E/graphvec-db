import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
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
