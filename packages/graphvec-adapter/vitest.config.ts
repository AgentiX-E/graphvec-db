import { defineConfig } from 'vitest/config';
import path from 'path';

const workspaceDir = path.resolve(__dirname, '../../..');

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/__tests__/**/*.test.ts'],
    testTimeout: 30_000,
  },
  resolve: {
    alias: {
      // db-operations packages (from file: deps in package.json)
      '@agentix-e/db-operations-core': path.join(workspaceDir, 'db-operations/packages/core/dist/index.js'),
      '@agentix-e/db-operations-core/types': path.join(workspaceDir, 'db-operations/packages/core/dist/types.js'),
      '@agentix-e/db-operations-health': path.join(workspaceDir, 'db-operations/packages/health/dist/index.js'),
      '@agentix-e/db-operations-backup': path.join(workspaceDir, 'db-operations/packages/backup/dist/index.js'),
      '@agentix-e/db-operations-logger': path.join(workspaceDir, 'db-operations/packages/logger/dist/index.js'),
      '@agentix-e/db-operations-metrics': path.join(workspaceDir, 'db-operations/packages/metrics/dist/index.js'),
      '@agentix-e/db-operations-monitor': path.join(workspaceDir, 'db-operations/packages/monitor/dist/index.js'),
      '@agentix-e/db-operations-security': path.join(workspaceDir, 'db-operations/packages/security/dist/index.js'),
      '@agentix-e/db-operations-observability': path.join(workspaceDir, 'db-operations/packages/observability/dist/index.js'),
      // graphvec-db source modules
      'graphvec-db/core/graph-engine': path.join(workspaceDir, 'graphvec-db/src/core/graph-engine.ts'),
      'graphvec-db/shard/shard-manager': path.join(workspaceDir, 'graphvec-db/src/shard/shard-manager.ts'),
      'graphvec-db/core/storage-provider': path.join(workspaceDir, 'graphvec-db/src/core/storage-provider.ts'),
      'graphvec-db/ops/health': path.join(workspaceDir, 'graphvec-db/src/ops/health.ts'),
      'graphvec-db/ops/metrics': path.join(workspaceDir, 'graphvec-db/src/ops/metrics.ts'),
      'graphvec-db/ops/backup-manager': path.join(workspaceDir, 'graphvec-db/src/ops/backup-manager.ts'),
      'graphvec-db/ops/logger': path.join(workspaceDir, 'graphvec-db/src/ops/logger.ts'),
      'graphvec-db/ops/query-slow-log': path.join(workspaceDir, 'graphvec-db/src/ops/query-slow-log.ts'),
      'graphvec-db/ops/alert-rules': path.join(workspaceDir, 'graphvec-db/src/ops/alert-rules.ts'),
      'graphvec-db/ops/resource-quota': path.join(workspaceDir, 'graphvec-db/src/ops/resource-quota.ts'),
      'graphvec-db/ops/security-audit': path.join(workspaceDir, 'graphvec-db/src/ops/security-audit.ts'),
      'graphvec-db/ops/otel': path.join(workspaceDir, 'graphvec-db/src/ops/otel.ts'),
    },
  },
});
