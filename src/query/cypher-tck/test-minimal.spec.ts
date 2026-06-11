import { describe, it, expect } from 'vitest'
import { _executeQuery } from '../query-engine'

describe('minimal test', () => {
  it('should not hang', () => {
    const plan = { scanLabel: 'Person', returnColumns: ['n'], type: 'MATCH' } as any
    const data = [{ _label: 'Person', name: 'Alice' }]
    const result = _executeQuery(plan, data)
    expect(result.length).toBe(1)
  }, 30000)
})