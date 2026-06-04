import { describe, it, expect } from 'vitest'
import {
  EdgeType,
  NodeType,
  Role,
  AuthError,
  type NodeRecord,
  type EdgeRecord,
  type RaftNodeConfig,
  type RaftStatus,
  type RaftOperation,
  type UpsertNodeOptions,
  type UpsertEdgeOptions,
  type VectorSearchOptions,
  type VectorSearchResult,
  type NodeProperties,
  type TemporalValidity,
  type GeoPoint,
  type ShardMap,
  type RangeConfig,
  type OverGraphConfig,
  type HealthStatus,
  type MetricsSnapshot,
  type AuthorizedIdentity,
  type AuthConfig,
  type AuthResult,
  type SubgraphPermission,
  type AuditEntry,
  type MaterializedViewConfig,
  type MaterializedViewStatus,
  type ReshardingPlan,
  type ReshardingStatus,
  type DCSyncConfig,
  type DeltaMessage,
  type MembershipChange,
  type PersonalizedPageRankOptions,
  type ShortestPathOptions,
  type ConnectedComponentsOptions,
  type PatternMatchOptions,
} from './types'

describe('EdgeType enum', () => {
  it('has RELATED with value 10', () => {
    expect(EdgeType.RELATED).toBe(10)
  })
  it('has DEPENDS_ON with value 11', () => {
    expect(EdgeType.DEPENDS_ON).toBe(11)
  })
  it('has REFERENCES with value 12', () => {
    expect(EdgeType.REFERENCES).toBe(12)
  })
  it('has HAS_PROPERTY with value 13', () => {
    expect(EdgeType.HAS_PROPERTY).toBe(13)
  })
  it('has SEQUENCE with value 14', () => {
    expect(EdgeType.SEQUENCE).toBe(14)
  })
  it('has USER_DEFINED with value 100', () => {
    expect(EdgeType.USER_DEFINED).toBe(100)
  })
})

describe('NodeType enum', () => {
  it('has GENERIC with value 1', () => {
    expect(NodeType.GENERIC).toBe(1)
  })
  it('has USER with value 2', () => {
    expect(NodeType.USER).toBe(2)
  })
  it('has AGENT with value 3', () => {
    expect(NodeType.AGENT).toBe(3)
  })
  it('has CONVERSATION with value 4', () => {
    expect(NodeType.CONVERSATION).toBe(4)
  })
  it('has DOCUMENT with value 5', () => {
    expect(NodeType.DOCUMENT).toBe(5)
  })
  it('has ENTITY with value 6', () => {
    expect(NodeType.ENTITY).toBe(6)
  })
  it('has USER_DEFINED with value 100', () => {
    expect(NodeType.USER_DEFINED).toBe(100)
  })
})

describe('Role enum', () => {
  it('has ADMIN', () => {
    expect(Role.ADMIN).toBe('admin')
  })
  it('has READER', () => {
    expect(Role.READER).toBe('reader')
  })
  it('has WRITER', () => {
    expect(Role.WRITER).toBe('writer')
  })
  it('has OPERATOR', () => {
    expect(Role.OPERATOR).toBe('operator')
  })
})

describe('AuthError', () => {
  it('is an instance of Error', () => {
    const err = new AuthError('unauthorized')
    expect(err).toBeInstanceOf(Error)
  })

  it('has name AuthError', () => {
    const err = new AuthError('unauthorized')
    expect(err.name).toBe('AuthError')
  })

  it('stores message', () => {
    const err = new AuthError('access denied')
    expect(err.message).toBe('access denied')
  })

  it('defaults statusCode to 401', () => {
    const err = new AuthError('unauthorized')
    expect(err.statusCode).toBe(401)
  })

  it('accepts custom statusCode', () => {
    const err = new AuthError('forbidden', 403)
    expect(err.statusCode).toBe(403)
  })
})

describe('NodeRecord interface', () => {
  it('can be constructed with required fields', () => {
    const node: NodeRecord = {
      id: 1,
      type: 1,
      name: 'test',
      props: {},
    }
    expect(node.id).toBe(1)
    expect(node.type).toBe(1)
    expect(node.name).toBe('test')
    expect(node.props).toEqual({})
  })

  it('supports optional fields', () => {
    const node: NodeRecord = {
      id: 1,
      type: 1,
      name: 'test',
      props: { key: 'value' },
      createdAt: 1000,
      degree: 5,
      mvccVersion: 3,
    }
    expect(node.createdAt).toBe(1000)
    expect(node.degree).toBe(5)
    expect(node.mvccVersion).toBe(3)
  })
})

describe('EdgeRecord interface', () => {
  it('can be constructed with required fields', () => {
    const edge: EdgeRecord = {
      src: 1,
      dst: 2,
      type: 10,
      props: {},
    }
    expect(edge.src).toBe(1)
    expect(edge.dst).toBe(2)
    expect(edge.type).toBe(10)
  })

  it('supports timestamp', () => {
    const edge: EdgeRecord = {
      src: 1,
      dst: 2,
      type: 10,
      props: { weight: '0.5' },
      timestamp: Date.now(),
    }
    expect(edge.timestamp).toBeDefined()
  })
})

describe('NodeProperties', () => {
  it('supports various value types', () => {
    const props: NodeProperties = {
      str: 'hello',
      num: 42,
      bool: true,
      nullVal: null,
      strArr: ['a', 'b'],
      numArr: [1, 2],
    }
    expect(typeof props.str).toBe('string')
    expect(typeof props.num).toBe('number')
    expect(props.nullVal).toBeNull()
    expect(Array.isArray(props.strArr)).toBe(true)
  })
})

describe('UpsertNodeOptions', () => {
  it('can be constructed with all fields', () => {
    const opts: UpsertNodeOptions = {
      props: { name: 'test' },
      denseVector: new Float32Array([0.1, 0.2]),
      sparseVector: { 1: 0.5 },
      temporalValidity: { start: 100, end: 200 },
      decayFactor: 0.9,
      ttlSeconds: 3600,
      skipReplication: false,
      _mvccVersion: 1,
      _txId: 'tx-1',
    }
    expect(opts.props!.name).toBe('test')
    expect(opts.denseVector).toBeInstanceOf(Float32Array)
    expect(opts.ttlSeconds).toBe(3600)
    expect(opts.skipReplication).toBe(false)
  })

  it('allow partial construction', () => {
    const opts: UpsertNodeOptions = {}
    expect(Object.keys(opts)).toHaveLength(0)
  })
})

describe('UpsertEdgeOptions', () => {
  it('supports weight and replication skip', () => {
    const opts: UpsertEdgeOptions = {
      weight: 0.8,
      skipReplication: true,
    }
    expect(opts.weight).toBe(0.8)
    expect(opts.skipReplication).toBe(true)
  })
})

describe('RaftNodeConfig', () => {
  it('can be constructed', () => {
    const config: RaftNodeConfig = {
      nodeId: 'node-1',
      peers: [{ id: 'node-2', address: 'localhost:5001' }],
      storagePath: '/data/raft',
    }
    expect(config.nodeId).toBe('node-1')
    expect(config.peers).toHaveLength(1)
    expect(config.storagePath).toBe('/data/raft')
  })

  it('supports optional fields', () => {
    const config: RaftNodeConfig = {
      nodeId: 'node-1',
      peers: [],
      storagePath: '/data',
      electionTimeoutMinMs: 150,
      electionTimeoutMaxMs: 300,
      heartbeatIntervalMs: 50,
      preVote: true,
      checkQuorum: true,
    }
    expect(config.electionTimeoutMinMs).toBe(150)
    expect(config.preVote).toBe(true)
  })
})

describe('RaftStatus', () => {
  it('can be constructed with all fields', () => {
    const status: RaftStatus = {
      role: 'leader',
      leaderId: 'node-1',
      term: 2,
      committed: 10,
      applied: 10,
      lastIndex: 10,
      snapshotIndex: 5,
    }
    expect(status.role).toBe('leader')
    expect(status.term).toBe(2)
    expect(status.committed).toBe(10)
  })
})

describe('RaftOperation', () => {
  it('can be constructed', () => {
    const op: RaftOperation = {
      id: 'op-1',
      type: 'upsert_node',
      payload: { typeId: 1, name: 'test' },
    }
    expect(op.id).toBe('op-1')
    expect(op.type).toBe('upsert_node')
  })

  it('supports all operation types', () => {
    const types: RaftOperation['type'][] = [
      'upsert_node', 'upsert_edge', 'delete_node', 'delete_edge',
      'batch_upsert', 'batch_edge', 'admin', 'optimistic_upsert_node',
      'optimistic_upsert_edge', 'install_snapshot',
    ]
    for (const t of types) {
      const op: RaftOperation = { id: `op-${t}`, type: t, payload: {} }
      expect(op.type).toBe(t)
    }
  })
})

describe('VectorSearchOptions', () => {
  it('supports hybrid search config', () => {
    const opts: VectorSearchOptions = {
      k: 10,
      hybrid: { text: 'find similar', strategy: 'rrf', vectorWeight: 0.5, textWeight: 0.5 },
    }
    expect(opts.k).toBe(10)
    expect(typeof opts.hybrid).toBe('object')
  })
})

describe('VectorSearchResult', () => {
  it('contains node, score, and optional distance', () => {
    const result: VectorSearchResult = {
      node: { id: 1, type: 1, name: 'test', props: {} },
      score: 0.95,
      distance: 0.1,
    }
    expect(result.node.id).toBe(1)
    expect(result.score).toBe(0.95)
  })
})

describe('GeoPoint', () => {
  it('stores lat/lng', () => {
    const pt: GeoPoint = { latitude: 31.23, longitude: 121.47 }
    expect(pt.latitude).toBe(31.23)
    expect(pt.longitude).toBe(121.47)
  })
})

describe('AuthConfig', () => {
  it('requires mtls mode', () => {
    const config: AuthConfig = {
      mode: 'mtls',
      tlsCert: '/certs/cert.pem',
      tlsKey: '/certs/key.pem',
    }
    expect(config.mode).toBe('mtls')
  })

  it('supports identities file and default role', () => {
    const config: AuthConfig = {
      mode: 'mtls',
      tlsCert: '/certs/cert.pem',
      tlsKey: '/certs/key.pem',
      identitiesFile: '/certs/identities.json',
      defaultRole: Role.READER,
    }
    expect(config.defaultRole).toBe('reader')
  })
})

describe('AuthorizedIdentity', () => {
  it('associates cn with role and databases', () => {
    const identity: AuthorizedIdentity = {
      cn: 'client-1',
      role: Role.ADMIN,
      databases: ['db1', 'db2'],
    }
    expect(identity.cn).toBe('client-1')
    expect(identity.databases).toContain('db1')
  })
})

describe('HealthStatus', () => {
  it('can represent healthy state', () => {
    const health: HealthStatus = {
      status: 'healthy',
      uptime: 3600,
      raft: { hasLeader: true, nodeCount: 3, role: 'leader' },
      shards: { total: 4, healthy: 4 },
      storage: { diskFree: 1000000, diskUsed: 500000 },
      latency: { p50: 5, p99: 20 },
      lastError: null,
    }
    expect(health.status).toBe('healthy')
    expect(health.raft.hasLeader).toBe(true)
  })
})

describe('AuditEntry', () => {
  it('supports hash chain integrity', () => {
    const entry: AuditEntry = {
      timestamp: '2024-01-01T00:00:00Z',
      operation: 'CREATE_NODE',
      user: 'admin',
      role: Role.ADMIN,
      resource: 'node:1',
      result: 'success',
      prevHash: 'abc123',
    }
    expect(entry.prevHash).toBe('abc123')
    expect(entry.operation).toBe('CREATE_NODE')
  })
})
