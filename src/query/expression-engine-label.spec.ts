import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

/**
 * Coverage for the _evalAtom label-predicate branches: `(n:Label)`,
 * `n:Label` (standalone), `n:A:B` / `n:B&C` (conjunction), and relationship
 * type tests `r:T`. These are the node/relationship label checks exercised
 * independently of the query-executor WHERE filtering.
 *
 * Node shape contract (mirrors query-executor): labels live either on the
 * node itself (`_label` / `__fullLabel`) or inside `props._label`; a
 * relationship carries its type under `_type` / `__edgeLabel`.
 */

describe('parenthesized label predicate (n:Label)', () => {
  it('matches a single label on the node', () => {
    const row = { n: { _label: 'Person', props: { name: 'a' } } }
    expect(_evaluateExpression('(n:Person)', row)).toBe(true)
  })
  it('fails a wrong label', () => {
    const row = { n: { _label: 'Person' } }
    expect(_evaluateExpression('(n:Dog)', row)).toBe(false)
  })
  it('label without a variable is null', () => {
    expect(_evaluateExpression('(:Person)', {})).toBeNull()
  })
})

describe('standalone label predicate n:Label', () => {
  it('matches a node with _label only', () => {
    const row = { n: { _label: 'Person' } }
    expect(_evaluateExpression('n:Person', row)).toBe(true)
  })
  it('fails a wrong label', () => {
    const row = { n: { _label: 'Person' } }
    expect(_evaluateExpression('n:Dog', row)).toBe(false)
  })
  it('matches via __fullLabel split', () => {
    const row = { n: { _label: 'A:B', __fullLabel: 'A:B' } }
    expect(_evaluateExpression('n:A', row)).toBe(true)
    expect(_evaluateExpression('n:B', row)).toBe(true)
  })
})

describe('relationship type label predicate r:T', () => {
  it('matches _type', () => {
    const row = { r: { _type: 'T2', __edgeLabel: 'T2' } }
    expect(_evaluateExpression('r:T2', row)).toBe(true)
  })
  it('fails a wrong type', () => {
    const row = { r: { _type: 'T2', __edgeLabel: 'T2' } }
    expect(_evaluateExpression('r:Other', row)).toBe(false)
  })
})

describe('label conjunction n:A:B and n:B&C', () => {
  it('colon-chained label conjunction', () => {
    const row = { n: { _label: 'A:B', __fullLabel: 'A:B' } }
    expect(_evaluateExpression('n:A:B', row)).toBe(true)
  })
  it('ampersand label conjunction', () => {
    const row = { n: { _label: 'B:C', __fullLabel: 'B:C' } }
    expect(_evaluateExpression('n:B&C', row)).toBe(true)
  })
})
