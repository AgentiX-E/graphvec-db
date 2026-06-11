import { vi } from 'vitest'

vi.mock('../query-engine', async () => {
  const actual: any = await vi.importActual('../query-engine')
  const { parseCypherToPlan } = await import('../ast-to-plan-v2')
  return { ...actual, parseQuery: (q: string) => parseCypherToPlan(q) }
})

import './openCypher-tck.spec'
