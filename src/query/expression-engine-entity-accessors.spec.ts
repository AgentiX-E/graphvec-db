import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the graph-entity accessor functions. These take node / relationship
// object envelopes (the internal `_label` / `_type` / `_startNode` shape) and
// surface their labels, type, endpoints, properties, and property keys.

const node = { _label: 'Person', name: 'Alice', age: 30, active: true }
const multiNode = { _label: 'A:B', name: 'x' }
const rel = { _type: 'KNOWS', _startNode: 1, _endNode: 2, since: 2020 }

describe('graph entity accessors', () => {
  it('labels() lists the label(s)', () => {
    expect(_evaluateExpression('labels(n)', { n: node })).toEqual(['Person'])
    expect(_evaluateExpression('labels(n)', { n: multiNode })).toEqual(['A', 'B'])
  })

  it('labels() returns empty for an unlabeled entity', () => {
    expect(_evaluateExpression('labels(n)', { n: { name: 'anon' } })).toEqual([])
  })

  it('type() returns the relationship type', () => {
    expect(_evaluateExpression('type(r)', { r: rel })).toBe('KNOWS')
  })

  it('properties() returns the non-internal properties', () => {
    expect(_evaluateExpression('properties(n)', { n: node })).toEqual({ name: 'Alice', age: 30, active: true })
  })

  it('keys() returns the non-internal property keys', () => {
    expect(_evaluateExpression('keys(n)', { n: node })).toEqual(['name', 'age', 'active'])
  })

  it('startNode()/endNode() return the endpoint ids', () => {
    expect(_evaluateExpression('startNode(r)', { r: rel })).toBe(1)
    expect(_evaluateExpression('endNode(r)', { r: rel })).toBe(2)
  })

  it('type() returns empty for a node (no relationship type)', () => {
    expect(_evaluateExpression('type(n)', { n: node })).toBe('')
  })

  it('type() throws on a primitive non-object', () => {
    expect(() => _evaluateExpression('type(x)', { x: 42 })).toThrow()
  })
})

// Lock string-literal escape decoding: \\n, \\t, \\r, backslash, escaped quote,
// and \\uXXXX unicode escapes.
describe('string literal escape decoding', () => {
  it('decodes newline and tab escapes', () => {
    expect(_evaluateExpression("'a\\nb'", {})).toBe('a\nb')
    expect(_evaluateExpression("'a\\tb'", {})).toBe('a\tb')
  })

  it('decodes an escaped single quote', () => {
    expect(_evaluateExpression("'it\\'s'", {})).toBe("it's")
  })

  it('decodes a unicode escape', () => {
    expect(_evaluateExpression("'\\u0041'", {})).toBe('A')
  })
})
