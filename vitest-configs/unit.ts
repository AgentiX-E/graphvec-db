import { defineConfig } from 'vitest/config'
import base from './base.js'

export default defineConfig({
  ...base,
  test: {
    ...base.test,
    include: [
      'src/algorithms/**/*.spec.ts',
      'src/api/**/*.spec.ts',
      'src/import/**/*.spec.ts',
      'src/index/**/*.spec.ts',
      'src/materialized-view/**/*.spec.ts',
      'src/ops/**/*.spec.ts',
      'src/query/**/*.spec.ts',
      'src/security/**/*.spec.ts',
      'src/utils/**/*.spec.ts',
    ],
    exclude: ['src/**/(rest|integration)/**'],
  },
})
