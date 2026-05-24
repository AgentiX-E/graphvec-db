import { RowLevelSecurity, RLSContext } from './rls'
import { Role } from '../types'

describe('RowLevelSecurity', () => {
  let rls: RowLevelSecurity
  let ctx: RLSContext

  beforeEach(() => {
    rls = new RowLevelSecurity()
    ctx = { userId: 'user1', role: Role.READER, tenantId: 'tenant-a' }
  })

  test('should pass through all records when no policies', () => {
    const records = [{ id: 1 }, { id: 2 }]
    expect(rls.enforceQuery('nodes', ctx, records)).toEqual(records)
  })

  test('should filter records based on tenant isolation', () => {
    rls.addPolicy({
      table: 'nodes',
      name: 'tenant-isolation',
      filter: (ctx, record: any) => record.tenantId === ctx.tenantId,
    })

    const records = [
      { id: 1, tenantId: 'tenant-a' },
      { id: 2, tenantId: 'tenant-b' },
      { id: 3, tenantId: 'tenant-a' },
    ]
    const filtered = rls.enforceQuery('nodes', ctx, records)
    expect(filtered).toEqual([
      { id: 1, tenantId: 'tenant-a' },
      { id: 3, tenantId: 'tenant-a' },
    ])
  })

  test('should apply wildcard table policy to all queries', () => {
    rls.addPolicy({
      table: '*',
      name: 'sensitive-data',
      filter: (ctx, record: any) => !record.sensitive || ctx.role === Role.ADMIN,
    })

    const records = [
      { id: 1, sensitive: false },
      { id: 2, sensitive: true },
    ]
    const filtered = rls.enforceQuery('edges', ctx, records)
    expect(filtered).toEqual([{ id: 1, sensitive: false }])
  })

  test('should allow admin to bypass sensitive filter', () => {
    const adminCtx: RLSContext = { userId: 'admin', role: Role.ADMIN }
    rls.addPolicy({
      table: 'graph',
      name: 'sensitive-data',
      filter: (ctx, record: any) => !record.sensitive || ctx.role === Role.ADMIN,
    })

    const records = [
      { id: 1, sensitive: false },
      { id: 2, sensitive: true },
    ]
    const filtered = rls.enforceQuery('graph', adminCtx, records)
    expect(filtered).toHaveLength(2)
  })

  test('removePolicy should work', () => {
    rls.addPolicy({ table: 'nodes', name: 'test', filter: () => false })
    expect(rls.getPolicies()).toHaveLength(1)
    expect(rls.removePolicy('nonexistent')).toBe(false)
    expect(rls.removePolicy('test')).toBe(true)
    expect(rls.getPolicies()).toHaveLength(0)
  })

  test('checkRecord should check single record', () => {
    rls.addPolicy({
      table: 'nodes',
      name: 'owner-only',
      filter: (ctx, record: any) => record.ownerId === ctx.userId,
    })
    expect(rls.checkRecord('nodes', ctx, { ownerId: 'user1' })).toBe(true)
    expect(rls.checkRecord('nodes', ctx, { ownerId: 'other' })).toBe(false)
  })

  test('clear should remove all policies', () => {
    rls.addPolicy({ table: 'nodes', name: 'a', filter: () => true })
    rls.addPolicy({ table: 'edges', name: 'b', filter: () => true })
    rls.clear()
    expect(rls.getPolicies()).toHaveLength(0)
  })
})
