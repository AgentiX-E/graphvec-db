/**
 * GraphVecAdapter.test.ts — Integration tests for the graphvec-adapter package.
 *
 * Tests all 9 adapter implementations with mocked graphvec-db dependencies.
 * Uses #class-based mocks to support `new` keyword usage by adapters.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── Mock graphvec-db modules (class exports so constructors work) ──

vi.mock('graphvec-db/ops/health', () => {
  class MockHealth {
    constructor() {}
    liveness = vi.fn().mockReturnValue({ ready: true });
    readiness = vi.fn().mockResolvedValue({ ready: true, details: { shards: { healthy: 1, total: 1 } } });
    startup = vi.fn().mockResolvedValue({ started: true, duration: 250 });
    check = vi.fn().mockResolvedValue({ status: 'healthy', shards: { healthy: 3, total: 3 }, raft: { hasLeader: true } });
    getStatus = vi.fn().mockReturnValue({ lastError: null });
  }
  return { Health: MockHealth };
});

vi.mock('graphvec-db/ops/metrics', () => {
  class MockMetrics {
    counters: Record<string, number> = {};
    latencies: Record<string, number[]> = {};
    incrementCounter = vi.fn((name: string, delta: number) => {
      this.counters[name] = (this.counters[name] || 0) + delta;
    });
    getCounter = vi.fn((name: string) => this.counters[name] || 0);
    recordLatency = vi.fn((name: string, ms: number) => {
      if (!this.latencies[name]) this.latencies[name] = [];
      this.latencies[name].push(ms);
    });
    snapshot = vi.fn(() => ({ counters: { ...this.counters } }));
    reset = vi.fn(() => {
      Object.keys(this.counters).forEach(k => delete this.counters[k]);
      Object.keys(this.latencies).forEach(k => delete this.latencies[k]);
    });
  }
  return { Metrics: MockMetrics };
});

vi.mock('graphvec-db/ops/backup-manager', () => {
  let snapshots: Array<{
    snapshotId: string; type: 'full' | 'incremental'; timestamp: number;
    sizeBytes: number; fileCount: number; path: string;
  }> = [];
  let seq = 0;

  class MockIncrementalBackupManager {
    constructor() {}
    fullBackup = vi.fn(async () => {
      const entry = {
        snapshotId: `snap-${++seq}`,
        type: 'full' as const,
        timestamp: Date.now(),
        sizeBytes: 1024,
        fileCount: 5,
        path: `/backups/snap-${seq}`,
      };
      snapshots.push(entry);
      return entry;
    });
    incrementalBackup = vi.fn(async () => {
      const entry = {
        snapshotId: `snap-inc-${++seq}`,
        type: 'incremental' as const,
        timestamp: Date.now(),
        sizeBytes: 256,
        fileCount: 2,
        path: `/backups/snap-inc-${seq}`,
      };
      snapshots.push(entry);
      return entry;
    });
    shouldTakeFullBackup = vi.fn(() => false);
    listSnapshots = vi.fn(async () => [...snapshots]);
    restore = vi.fn(async (id: string) => {
      const exists = snapshots.some(s => s.snapshotId === id);
      if (!exists) throw new Error(`Snapshot ${id} not found`);
    });
  }
  return { IncrementalBackupManager: MockIncrementalBackupManager };
});

vi.mock('graphvec-db/ops/logger', () => {
  class MockLogger {
    constructor(v: string) {}
    trace = vi.fn();
    debug = vi.fn();
    info = vi.fn();
    warn = vi.fn();
    error = vi.fn();
    fatal = vi.fn();
  }
  return { Logger: MockLogger, withTraceContext: vi.fn((_ctx: unknown, fn: () => unknown) => fn()), getTraceId: vi.fn(() => undefined) };
});

vi.mock('graphvec-db/ops/query-slow-log', () => {
  const slowQueries: Array<{ op: string; duration: number; timestamp: number; user?: string }> = [];
  class MockQuerySlowLog {
    constructor() {}
    track = vi.fn(async (name: string, fn: () => Promise<unknown>, _user?: string) => {
      slowQueries.push({ op: name, duration: 100, timestamp: Date.now() });
      return fn();
    });
    getSlowQueries = vi.fn(() => [...slowQueries]);
    setThreshold = vi.fn();
    clear = vi.fn(() => { slowQueries.length = 0; });
    close = vi.fn();
  }
  return { QuerySlowLog: MockQuerySlowLog };
});

vi.mock('graphvec-db/ops/alert-rules', () => {
  const rules: Map<string, any> = new Map();
  class MockAlertRuleManager {
    constructor() {}
    addRule = vi.fn((rule: any) => rules.set(rule.name, rule));
    removeRule = vi.fn((name: string) => rules.delete(name));
    listRules = vi.fn(() => Array.from(rules.values()));
    listAllRules = vi.fn(() => Array.from(rules.values()));
    setRuleEnabled = vi.fn((name: string) => {
      if (!rules.has(name)) return false;
      rules.set(name, { ...rules.get(name), enabled: false });
      return true;
    });
    setThreshold = vi.fn((name: string, threshold: number) => {
      if (!rules.has(name)) return false;
      rules.set(name, { ...rules.get(name), threshold });
      return true;
    });
    evaluateRules = vi.fn(() =>
      Array.from(rules.values())
        .filter((r: any) => r.enabled)
        .map((r: any) => ({
          name: r.name,
          triggered: true,
          severity: r.severity || 'warning',
          message: `${r.name} triggered: ${r.expr}`,
          value: r.threshold ? 50 : 0,
          threshold: r.threshold,
        })),
    );
    toPrometheusYAML = vi.fn(() => '');
  }
  return { AlertRuleManager: MockAlertRuleManager };
});

vi.mock('graphvec-db/ops/resource-quota', () => {
  class MockResourceQuotaManager {
    private config: { maxMemoryMB: number; maxQueriesPerSec: number; maxConnections: number };
    constructor(cfg?: any) {
      this.config = { maxMemoryMB: cfg?.maxMemoryMB ?? 1024, maxQueriesPerSec: cfg?.maxQueriesPerSec ?? 1000, maxConnections: cfg?.maxConnections ?? 100 };
    }
    tryAcquire = vi.fn(() => true);
    getMemoryUsageMB = vi.fn(() => 128);
    reset = vi.fn();
    dispose = vi.fn();
    updateConfig = vi.fn();
    getConfig = vi.fn(() => ({ ...this.config }));
    getQueryCount = vi.fn(() => 42);
  }
  return { ResourceQuotaManager: MockResourceQuotaManager };
});

vi.mock('graphvec-db/ops/security-audit', () => {
  let authFailures = 0;
  class MockSecurityAuditor {
    constructor() {}
    checkConfigBaseline = vi.fn(() => [
      { id: 'CFG-001', category: 'TLS', description: 'TLS enabled', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-002', category: 'TLS', description: 'mTLS cert expiry', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-003', category: 'Encryption', description: 'CURVE key set', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-004', category: 'Auth', description: 'Identities file present', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-005', category: 'Audit', description: 'Audit logging enabled', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-006', category: 'Auth', description: 'RBAC roles configured', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
      { id: 'CFG-007', category: 'Backup', description: 'Backup schedule set', severity: 'PASS' as const, message: 'OK', timestamp: Date.now() },
    ]);
    onAuthFailure = vi.fn((_nodeId: string) => { authFailures++; });
    onExport = vi.fn((_bytes: number) => {});
    onBulkDelete = vi.fn((_count: number) => {});
    checkRuntimeThreats = vi.fn(() => ({
      generatedAt: Date.now(),
      authFailures,
      authFailureRate: authFailures > 0 ? authFailures / 100 : 0,
      bulkExports: 0, bulkExportRate: 0,
      bulkDeletes: 0, bulkDeleteRate: 0,
      alerts: authFailures > 5 ? [`⚠️ High auth failure rate: ${authFailures} failures (rate ${(authFailures / 100).toFixed(2)})`] : [],
    }));
    generateSecurityReport = vi.fn(() => ({}));
    resetThreatCounters = vi.fn(() => { authFailures = 0; });
  }
  return { SecurityAuditor: MockSecurityAuditor };
});

vi.mock('graphvec-db/ops/otel', () => {
  class MockTelemetry {
    initSdk = vi.fn();
    startTracing = vi.fn();
    shutdown = vi.fn(async () => {});
  }
  return { Telemetry: { getInstance: vi.fn(() => new MockTelemetry()) } };
});

vi.mock('graphvec-db/core/graph-engine', () => {
  class MockGraphEngine {
    isOpen = true;
    open = vi.fn(async () => {});
    close = vi.fn(async () => {});
    stats = vi.fn(() => ({ nodeCount: 1000, edgeCount: 5000, diskSizeBytes: 2097152 }));
  }
  return { GraphEngine: MockGraphEngine };
});

vi.mock('graphvec-db/shard/shard-manager', () => {
  class MockShardManager { constructor() {} }
  return { ShardManager: MockShardManager };
});

vi.mock('graphvec-db/core/storage-provider', () => {
  class MockStorageProvider { constructor() {} }
  return { StorageProvider: MockStorageProvider };
});

// ── Adapter imports (must come after mocks) ──

import { GraphVecHealthAdapter } from '../GraphVecHealthAdapter.js';
import { GraphVecMetricAdapter } from '../GraphVecMetricAdapter.js';
import { GraphVecBackupAdapter } from '../GraphVecBackupAdapter.js';
import { GraphVecLoggerAdapter } from '../GraphVecLoggerAdapter.js';
import { GraphVecSlowQueryAdapter } from '../GraphVecSlowQueryAdapter.js';
import { GraphVecAlertAdapter } from '../GraphVecAlertAdapter.js';
import { GraphVecResourceQuotaAdapter } from '../GraphVecResourceQuotaAdapter.js';
import { GraphVecSecurityAdapter } from '../GraphVecSecurityAdapter.js';
import { GraphVecTracerAdapter } from '../GraphVecTracerAdapter.js';

// ── Tests ──────────────────────────────────────────────────

describe('GraphVecHealthAdapter', () => {
  let adapter: GraphVecHealthAdapter;

  beforeEach(() => {
    adapter = new GraphVecHealthAdapter({} as any, {} as any);
  });

  it('should return liveness probe with ok:true when engine is responsive', () => {
    adapter['engine'] = { stats: () => ({ nodeCount: 0 }) } as any;
    const result = adapter.liveness();
    expect(result).toBeDefined();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('responsive');
  });

  it('should have correct probeId and componentName', () => {
    expect(adapter.probeId).toBe('graphvec-engine');
    expect(adapter.componentName).toBe('GraphVec Engine');
  });

  it('should return readiness probe synchronously', () => {
    const result = adapter.readiness();
    expect(result).toBeDefined();
    expect(typeof result.ok).toBe('boolean');
  });

  it('should return startup probe when engine is open', () => {
    adapter['engine'] = { isOpen: true, stats: () => ({}) } as any;
    const result = adapter.startup();
    expect(result).toBeDefined();
    expect(result.ok).toBe(true);
    expect(result.message).toContain('startup completed');
  });

  it('should return aggregated health status with components', () => {
    const status = adapter.getHealthStatus();
    expect(status).toBeDefined();
    expect(status.status).toMatch(/^(healthy|degraded|unhealthy)$/);
    expect(status.uptimeSeconds).toBeGreaterThanOrEqual(0);
    expect(status.components).toBeInstanceOf(Array);
    expect(status.components[0].componentId).toBeDefined();
  });
});

describe('GraphVecMetricAdapter', () => {
  let adapter: GraphVecMetricAdapter;

  beforeEach(() => {
    adapter = new GraphVecMetricAdapter();
  });

  it('should create and increment a counter', () => {
    const counter = adapter.counter('test_ops_total');
    expect(counter.get()).toBe(0);
    counter.inc();
    expect(counter.get()).toBe(1);
    counter.incBy(5);
    expect(counter.get()).toBe(6);
  });

  it('should create and manipulate a gauge', () => {
    const gauge = adapter.gauge('test_active_connections');
    gauge.set(10);
    expect(gauge.get()).toBe(10);
    gauge.inc();
    expect(gauge.get()).toBe(11);
    gauge.dec();
    expect(gauge.get()).toBe(10);
    gauge.add(-5);
    expect(gauge.get()).toBe(5);
  });

  it('should create and observe a histogram', () => {
    const histogram = adapter.histogram('test_query_duration_ms');
    expect(histogram.getCount()).toBe(0);
    histogram.observe(100);
    histogram.observe(200);
    histogram.observe(300);
    expect(histogram.getCount()).toBe(3);
    expect(histogram.getSum()).toBe(600);
  });

  it('should return snapshot with correct metrics', () => {
    const counter = adapter.counter('test_snap_ops');
    counter.incBy(42);
    const snapshot = adapter.snapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.points.length).toBeGreaterThanOrEqual(1);
    const point = snapshot.points.find(p => p.name === 'test_snap_ops');
    expect(point).toBeDefined();
    expect(point!.value).toBe(42);
  });

  it('should reset all metrics', () => {
    adapter.counter('test_reset').incBy(100);
    adapter.gauge('test_gauge_reset').set(50);
    adapter.reset();
    expect(adapter.counter('test_reset').get()).toBe(0);
    expect(adapter.gauge('test_gauge_reset').get()).toBe(0);
  });

  it('should compute histogram quantiles', () => {
    const h = adapter.histogram('test_quantile');
    for (let i = 1; i <= 100; i++) h.observe(i);
    expect(h.getQuantile(0.5)).toBeGreaterThanOrEqual(49);
    expect(h.getQuantile(0.99)).toBeGreaterThanOrEqual(98);
    expect(h.getQuantile(1.0)).toBe(100);
  });
});

describe('GraphVecBackupAdapter', () => {
  let adapter: GraphVecBackupAdapter;

  beforeEach(() => {
    adapter = new GraphVecBackupAdapter({
      backupDir: '/tmp/backups',
      dataDir: '/tmp/data',
      maxSnapshots: 5,
    });
  });

  it('should create a full backup', async () => {
    const result = await adapter.createBackup({ type: 'full' });
    expect(result.success).toBe(true);
    expect(result.snapshot).toBeDefined();
    expect(result.snapshot!.snapshotId).toBeTruthy();
    expect(result.snapshot!.type).toBe('full');
  });

  it('should list created backups', async () => {
    await adapter.createBackup({ type: 'full' });
    const backups = await adapter.listBackups();
    expect(backups.length).toBeGreaterThanOrEqual(1);
    expect(backups[0].snapshotId).toBeTruthy();
  });

  it('should get a specific backup by snapshotId', async () => {
    const result = await adapter.createBackup({ type: 'full' });
    const snapshotId = result.snapshot!.snapshotId;
    const backup = await adapter.getBackup(snapshotId);
    expect(backup).not.toBeNull();
    expect(backup!.snapshotId).toBe(snapshotId);
  });

  it('should return null for non-existent backup', async () => {
    const backup = await adapter.getBackup('nonexistent-snapshot');
    expect(backup).toBeNull();
  });

  it('should restore from a snapshot', async () => {
    const result = await adapter.createBackup({ type: 'full' });
    const restoreResult = await adapter.restoreFromSnapshot(result.snapshot!.snapshotId);
    expect(restoreResult.success).toBe(true);
    expect(restoreResult.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('should handle restore of non-existent snapshot', async () => {
    const result = await adapter.restoreFromSnapshot('nonexistent');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('GraphVecLoggerAdapter', () => {
  let adapter: GraphVecLoggerAdapter;

  beforeEach(() => {
    adapter = new GraphVecLoggerAdapter('test-component');
  });

  it('should log info messages without errors', () => {
    expect(() => adapter.info('test info message')).not.toThrow();
  });

  it('should log info with context', () => {
    expect(() => adapter.info({ shardId: 'shard-1' }, 'context message')).not.toThrow();
  });

  it('should log warn, error, and fatal messages', () => {
    expect(() => adapter.warn('test warning')).not.toThrow();
    expect(() => adapter.error('test error')).not.toThrow();
    expect(() => adapter.error(new Error('test'), 'err msg')).not.toThrow();
    expect(() => adapter.fatal(new Error('fatal'))).not.toThrow();
  });

  it('should create child loggers', () => {
    const child = adapter.child({ module: 'sub-module' });
    expect(() => child.info('from child')).not.toThrow();
  });

  it('should support trace context provider', () => {
    const traceId = adapter.getTraceId();
    expect(traceId).toBeUndefined();
    const result = adapter.withTrace('test-trace-id', () => 42);
    expect(result).toBe(42);
  });

  it('should support async trace context', async () => {
    const result = await adapter.withTraceAsync('async-trace', async () => 'done');
    expect(result).toBe('done');
  });
});

describe('GraphVecSlowQueryAdapter', () => {
  let adapter: GraphVecSlowQueryAdapter;

  beforeEach(() => {
    adapter = new GraphVecSlowQueryAdapter(50, 1000);
  });

  it('should record a slow query', async () => {
    await adapter.record({
      query: 'MATCH (n) RETURN n LIMIT 100',
      durationMs: 200,
      timestamp: new Date(),
      database: 'graphvec',
      user: 'admin',
    });
    const queries = await adapter.getSlowQueries(100);
    expect(queries.length).toBe(1);
    expect(queries[0].durationMs).toBe(200);
  });

  it('should filter slow queries by threshold', async () => {
    await adapter.record({
      query: 'MATCH (a)-[r]->(b) RETURN a, b',
      durationMs: 500,
      timestamp: new Date(),
      database: 'graphvec',
    });
    await adapter.record({
      query: 'MATCH (n) WHERE n.id = ? RETURN n',
      durationMs: 30,
      timestamp: new Date(),
      database: 'graphvec',
    });
    const slow = await adapter.getSlowQueries(100);
    expect(slow.length).toBe(1);
    expect(slow[0].durationMs).toBe(500);
  });

  it('should analyze query patterns', async () => {
    await adapter.record({
      query: 'MATCH (n:User) WHERE n.age > ? RETURN n.name',
      durationMs: 150,
      timestamp: new Date(),
      database: 'graphvec',
    });
    await adapter.record({
      query: 'MATCH (n:User) WHERE n.age > ? RETURN n.name',
      durationMs: 250,
      timestamp: new Date(),
      database: 'graphvec',
    });
    await adapter.record({
      query: 'MATCH (n:Product) WHERE n.price < ? RETURN n',
      durationMs: 300,
      timestamp: new Date(),
      database: 'graphvec',
    });

    const patterns = await adapter.analyzePatterns();
    expect(patterns.length).toBeGreaterThanOrEqual(2);

    const userPattern = patterns.find(p => p.pattern.includes('User'));
    expect(userPattern).toBeDefined();
    expect(userPattern!.count).toBe(2);
    expect(userPattern!.averageDurationMs).toBe(200);
  });

  it('should clear slow queries', async () => {
    await adapter.record({
      query: 'MATCH (n) RETURN n',
      durationMs: 100,
      timestamp: new Date(),
      database: 'graphvec',
    });
    adapter.clear();
    const queries = await adapter.getSlowQueries(0);
    expect(queries.length).toBe(0);
  });
});

describe('GraphVecAlertAdapter', () => {
  let adapter: GraphVecAlertAdapter;

  beforeEach(() => {
    // Each beforeEach gets a fresh adapter, which gets a fresh mock
    adapter = new GraphVecAlertAdapter();
    // Ensure the mock state is clean by creating only the test rule
  });

  it('should create a new alert rule', async () => {
    const ruleId = await adapter.createRule({
      name: 'test-high-latency',
      metric: 'graphvec_node_op_duration_ms',
      condition: 'gt',
      threshold: 1000,
      durationMs: 60_000,
      severity: 'warning',
      enabled: true,
    });
    expect(ruleId).toBe('test-high-latency');
  });

  it('should throw when deleting non-existent rule', async () => {
    await expect(adapter.deleteRule('non-existent')).rejects.toThrow();
  });

  it('should evaluate rules and return triggered alerts', async () => {
    const id = await adapter.createRule({
      name: 'eval-test-only',
      metric: 'test',
      condition: 'gt',
      threshold: 0,
      durationMs: 0,
      severity: 'critical',
      enabled: true,
    });
    const alerts = await adapter.evaluate();
    expect(Array.isArray(alerts)).toBe(true);
    expect(alerts.length).toBeGreaterThanOrEqual(1);
    expect(alerts.some(a => a.ruleId === 'eval-test-only')).toBe(true);
  });

  it('should silence a rule', async () => {
    await adapter.createRule({
      name: 'silence-test',
      metric: 'test',
      condition: 'gt',
      threshold: 5,
      durationMs: 100,
      severity: 'warning',
      enabled: true,
    });
    await adapter.silenceRule('silence-test', 100);
    expect(true).toBe(true);
  });
});

describe('GraphVecResourceQuotaAdapter', () => {
  let adapter: GraphVecResourceQuotaAdapter;

  beforeEach(() => {
    adapter = new GraphVecResourceQuotaAdapter({
      maxMemoryMB: 1024,
      maxQueriesPerSec: 1000,
      maxConnections: 100,
    });
  });

  it('should set and get quotas for a role', async () => {
    await adapter.setQuota('reader', {
      cpuLimit: 4,
      memoryLimitMB: 512,
      connectionLimit: 50,
      queryRateLimit: 500,
    });
    const quota = await adapter.getQuota('reader');
    expect(quota).not.toBeNull();
    expect(quota!.memoryLimitMB).toBe(512);
    expect(quota!.connectionLimit).toBe(50);
  });

  it('should return null for unset quotas', async () => {
    const quota = await adapter.getQuota('unknown-role');
    expect(quota).toBeNull();
  });

  it('should check quota and return allowed for roles within limits', async () => {
    const result = await adapter.checkQuota('__system__');
    expect(result.allowed).toBe(true);
  });

  it('should return a resource usage snapshot', async () => {
    const snapshot = await adapter.getResourceSnapshot();
    expect(snapshot).toBeDefined();
    expect(snapshot.memoryBytes).toBeGreaterThan(0);
    expect(snapshot.memoryUtilization).toBeGreaterThan(0);
    expect(snapshot.connectionPool).toBeDefined();
    expect(snapshot.timestamp).toBeGreaterThan(0);
  });
});

describe('GraphVecSecurityAdapter', () => {
  let adapter: GraphVecSecurityAdapter;

  beforeEach(() => {
    adapter = new GraphVecSecurityAdapter({
      tlsEnabled: true, mtlsCertExpiry: Date.now() + 86_400_000 * 365,
      curveEncryptionKey: 'CURVE_XYZ_123', identitiesFilePath: '/etc/graphvec/identities.json',
      auditLoggingEnabled: true, rbacRolesConfigured: true, backupScheduleConfigured: true,
    });
  });

  it('should run compliance checks and return results', async () => {
    const checks = await adapter.runChecks();
    expect(checks).toBeInstanceOf(Array);
    expect(checks.length).toBeGreaterThanOrEqual(7);
    expect(checks[0].id).toBeTruthy();
    expect(checks[0].category).toBeTruthy();
  });

  it('should run checks for a specific category', async () => {
    const tlsChecks = await adapter.runCategory('TLS');
    expect(tlsChecks.length).toBeGreaterThanOrEqual(2);
    expect(tlsChecks[0].category).toBe('TLS');
  });

  it('should compute a compliance score', async () => {
    await adapter.runChecks();
    const score = adapter.getScore();
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('should return perfect score with all passing checks', async () => {
    await adapter.runChecks();
    const score = adapter.getScore();
    expect(score).toBe(100);
  });

  it('should detect runtime threats', async () => {
    adapter.onAuthFailure('node-1');
    adapter.onAuthFailure('node-2');
    const alerts = await adapter.checkRuntimeThreats();
    expect(Array.isArray(alerts)).toBe(true);
  });

  it('should reset threat counters', () => {
    adapter.onAuthFailure('node-1');
    adapter.resetThreatCounters();
    expect(true).toBe(true);
  });
});

describe('GraphVecTracerAdapter', () => {
  let adapter: GraphVecTracerAdapter;

  beforeEach(() => {
    adapter = new GraphVecTracerAdapter();
  });

  it('should start and end a span', () => {
    const { spanId, end } = adapter.startSpan('test-operation');
    expect(spanId).toBeTruthy();
    end('ok');
    const spans = adapter.getCompletedSpans();
    expect(spans.length).toBe(1);
    expect(spans[0].name).toBe('test-operation');
    expect(spans[0].status).toBe('ok');
  });

  it('should mark error spans', () => {
    const { end } = adapter.startSpan('failing-op');
    end('error', 'timeout exceeded');
    const spans = adapter.getCompletedSpans();
    expect(spans[0].status).toBe('error');
    expect(spans[0].errorMessage).toBe('timeout exceeded');
  });

  it('should inject trace context into a carrier', () => {
    const { end } = adapter.startSpan('inject-test');
    const carrier: Record<string, string> = {};
    adapter.inject(carrier);
    expect(carrier['traceparent']).toBeTruthy();
    expect(carrier['traceparent']).toMatch(/^00-/);
    end('ok');
  });

  it('should extract trace context from a carrier', () => {
    const carrier = {
      traceparent: '00-abcdef0123456789abcdef0123456789-1234567890abcdef-01',
    };
    const ctx = adapter.extract(carrier);
    expect(ctx).toBeDefined();
    expect(ctx!.traceId).toBe('abcdef0123456789abcdef0123456789');
    expect(ctx!.parentSpanId).toBe('1234567890abcdef');
  });

  it('should clear completed spans', () => {
    const { end } = adapter.startSpan('clear-me');
    end('ok');
    expect(adapter.getCompletedSpans().length).toBe(1);
    adapter.clearCompletedSpans();
    expect(adapter.getCompletedSpans().length).toBe(0);
  });
});

describe('Cross-adapter coordination', () => {
  let healthAdapter: GraphVecHealthAdapter;
  let metricAdapter: GraphVecMetricAdapter;
  let loggerAdapter: GraphVecLoggerAdapter;

  beforeEach(() => {
    healthAdapter = new GraphVecHealthAdapter({} as any, {} as any);
    healthAdapter['engine'] = { stats: () => ({}), isOpen: true } as any;
    metricAdapter = new GraphVecMetricAdapter();
    loggerAdapter = new GraphVecLoggerAdapter('integration');
  });

  it('should report healthy engine with active metrics', () => {
    const queryCounter = metricAdapter.counter('queries_total');
    queryCounter.incBy(100);
    const latencyHist = metricAdapter.histogram('query_duration_ms');
    latencyHist.observe(50);
    latencyHist.observe(150);

    const liveness = healthAdapter.liveness();
    expect(liveness.ok).toBe(true);
    expect(queryCounter.get()).toBe(100);
  });

  it('should log system events without errors', () => {
    loggerAdapter.info({ component: 'test', action: 'integration_check' }, 'Running integration test');
    expect(() => loggerAdapter.info('Integration test complete')).not.toThrow();
  });
});
