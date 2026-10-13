import { describe, it, expect } from 'vitest'
import { _evaluateExpression } from './expression-engine'

// Lock the parenthesized-subscript branch of _evalAtom — `(expr)[n]` and
// `(expr)[start..end]` — which exercises string slicing, negative slice bounds
// (clamped from the end), negative single indices, and map key lookup on the
// parenthesised path. Values align with openCypher semantics.

function ev(s: string): unknown {
  return _evaluateExpression(s, {})
}

describe('parenthesized subscript and slicing', () => {
  it('slices a parenthesized string', () => {
    expect(ev("('hello world')[0..5]")).toBe('hello')
    expect(ev("('hello world')[1..3]")).toBe('el')
    expect(ev("('hello world')[6..]")).toBe('world')
  })

  it('clamps negative slice bounds on a parenthesized list', () => {
    expect(ev('([1,2,3,4,5])[-2..]')).toEqual([4, 5])
    expect(ev('([1,2,3,4,5])[..-2]')).toEqual([1, 2, 3])
    expect(ev('([1,2,3,4,5])[-3..-1]')).toEqual([3, 4])
    expect(ev('([1,2,3,4,5])[..]')).toEqual([1, 2, 3, 4, 5])
  })

  it('indexes a parenthesized list with a negative index', () => {
    expect(ev('([1,2,3])[-1]')).toBe(3)
    expect(ev('([1,2,3])[5]')).toBeNull()
    expect(ev('([1,2,3])[null]')).toBeNull()
  })

  it('looks up a key on a parenthesized map', () => {
    expect(ev("({a:1, b:2})['a']")).toBe(1)
    expect(ev("({a:1, b:2})['zzz']")).toBeNull()
  })

  it('rejects a non-string index on a parenthesized map', () => {
    expect(() => ev('({a:1})[0]')).toThrow(/string/)
  })

  it('rejects a non-integer index on a parenthesized list', () => {
    expect(() => ev('([1,2,3])[1.5]')).toThrow(/integer/)
  })

  it('yields null for a null slice boundary on a parenthesized list', () => {
    expect(ev('([1,2,3])[null..2]')).toBeNull()
    expect(ev('([1,2,3])[1..null]')).toBeNull()
  })

  it('treats a non-numeric slice bound as the default endpoint', () => {
    // string bound -> NaN coerced to default (start 0 / end len), matching bare path
    expect(ev("([1,2,3])['x'..2]")).toEqual([1, 2])
    expect(ev("([1,2,3])[1..'x']")).toEqual([2, 3])
  })

  it('subscript on a non-list non-map parenthesized value yields null', () => {
    expect(ev('(123)[0]')).toBeNull()
  })
})
