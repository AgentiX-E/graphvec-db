import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    root: path.resolve(__dirname, '.'),
    include: ['test/integration/**/*.test.ts', 'test/fault-injection/**/*.test.ts'],
    exclude: ['**/node_modules/**'],
    testTimeout: 60000,
    hookTimeout: 60000,
    globals: true,
    pool: 'forks',
    singleFork: false,
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'test': path.resolve(__dirname, 'test'),
      'graph-crdt': path.resolve(__dirname, 'src/test-utils/__mocks__/graph-crdt.ts'),
      'chokidar': path.resolve(__dirname, 'src/security/__mocks__/chokidar.ts'),
    },
  },
})
