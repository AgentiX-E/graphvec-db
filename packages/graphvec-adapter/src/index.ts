/**
 * graphvec-adapter — Index file
 *
 * Exports all adapter implementations for the graphvec-db engine.
 * Each adapter implements a db-operations interface by wrapping graphvec-db's
 * native ops/ classes.
 */

export { GraphVecHealthAdapter } from './GraphVecHealthAdapter.js';
export { GraphVecMetricAdapter } from './GraphVecMetricAdapter.js';
export { GraphVecBackupAdapter } from './GraphVecBackupAdapter.js';
export { GraphVecLoggerAdapter } from './GraphVecLoggerAdapter.js';
export { GraphVecSlowQueryAdapter } from './GraphVecSlowQueryAdapter.js';
export { GraphVecAlertAdapter } from './GraphVecAlertAdapter.js';
export { GraphVecResourceQuotaAdapter } from './GraphVecResourceQuotaAdapter.js';
export { GraphVecSecurityAdapter } from './GraphVecSecurityAdapter.js';
export { GraphVecTracerAdapter } from './GraphVecTracerAdapter.js';

// Re-export core types for convenience
export type { ProbeResult, ComponentHealth, HealthStatus } from '@agentix-e/db-operations-core/types';
export type { ICounter, IGauge, IHistogram } from '@agentix-e/db-operations-metrics';
export type { LogLevel, LogEntry, ITraceContextProvider } from '@agentix-e/db-operations-logger';
export type { IResourceQuota, ResourceUsageSnapshot } from '@agentix-e/db-operations-monitor';
export type { Span } from '@agentix-e/db-operations-observability';
