import { describe, it, expect } from 'vitest'
import {
  _parseNestedAggregate, _executeAggregation, _computeAggregate, _cleanFloat,
  _compareOrderByValue, _orderByField, _extractAggColumns, _hasAggregates,
  _enrichWithAggregates, _parseAggregate,
} from './expression-engine'

/** Coverage for aggregation execution, ordering comparator, and helpers. */

describe('_parseNestedAggregate', () => {
  it('parses count (lowercase fn)', () => {
    expect(_parseNestedAggregate('size(collect(n.prop))')).toEqual({ fn: 'collect', field: 'n.prop', distinct: false })
  })
  it('parses distinct sum', () => {
    expect(_parseNestedAggregate('$age + sum(DISTINCT x)')).toEqual({ fn: 'sum', field: 'x', distinct: true })
  })
  it('returns null without aggregate', () => {
    expect(_parseNestedAggregate('n.name')).toBe(null)
  })
  it('returns null for quantifier source collect', () => {
    expect(_parseNestedAggregate('ALL(x IN collect(...) WHERE x > 0)')).toBe(null)
  })
})

describe('_parseAggregate (uppercase fn)', () => {
  it('parses count(*)', () => {
    const r = _parseAggregate('count(*)')!
    expect(r.fn).toBe('COUNT')
    expect(r.prop).toBe('*')
  })
  it('parses percentileCont two-arg', () => {
    const r = _parseAggregate('percentileCont(x, 0.5)')!
    expect(r.fn).toBe('PERCENTILECONT')
    expect(r.field).toBe('x')
    expect(r.pctArg).toBe('0.5')
  })
})

describe('_extractAggColumns / _hasAggregates', () => {
  it('splits agg vs group-by', () => {
    const r = _extractAggColumns(['count(n)', 'n.name'])
    expect(r.aggCols.length).toBe(1)
    expect(r.groupByCols).toEqual(['name'])
  })
  it('detects aggregates', () => {
    expect(_hasAggregates(['count(n)'])).toBe(true)
    expect(_hasAggregates(['n.name'])).toBe(false)
  })
})

describe('_enrichWithAggregates', () => {
  it('marks aggregate columns', () => {
    const r = _enrichWithAggregates([{ expression: 'count(n)' }, { expression: 'n.x' }])
    expect(r[0].isAggregate).toBe(true)
    expect(r[0].aggFn).toBe('COUNT')
    expect(r[1].isAggregate).toBe(false)
  })
})

describe('_computeAggregate (uppercase fn)', () => {
  it('count', () => expect(_computeAggregate('COUNT', [1, 2, 3])).toBe(3))
  it('count empty -> 0', () => expect(_computeAggregate('COUNT', [])).toBe(0))
  it('sum', () => expect(_computeAggregate('SUM', [1, 2, 3])).toBe(6))
  it('avg', () => expect(_computeAggregate('AVG', [1, 2, 3])).toBe(2))
  it('avg empty -> null', () => expect(_computeAggregate('AVG', [])).toBe(null))
  it('max/min', () => {
    expect(_computeAggregate('MAX', [1, 5, 3])).toBe(5)
    expect(_computeAggregate('MIN', [1, 5, 3])).toBe(1)
  })
  it('collect returns list', () => expect(_computeAggregate('COLLECT', [1, 2])).toEqual([1, 2]))
  it('percentileDisc empty -> null', () => expect(_computeAggregate('PERCENTILEDISC', [], '0.5')).toBe(null))
  it('percentileDisc range throws', () => {
    expect(() => _computeAggregate('PERCENTILEDISC', [1, 2, 3], '1.5')).toThrow(/NumberOutOfRange/)
  })
})

describe('_cleanFloat', () => {
  it('integer passthrough', () => expect(_cleanFloat(5)).toBe(5))
  it('cleans floating noise', () => expect(_cleanFloat(0.30000000000000004)).toBe(0.3))
})

describe('_executeAggregation', () => {
  const rows = [
    { group: 'a', v: 1 },
    { group: 'a', v: 2 },
    { group: 'b', v: 10 },
  ]
  it('no group-by, count', () => {
    const r = _executeAggregation(rows, [{ fn: 'COUNT', prop: '*', alias: 'c' }], [])
    expect(r).toEqual([{ c: 3 }])
  })
  it('no group-by, sum', () => {
    const r = _executeAggregation(rows, [{ fn: 'SUM', prop: 'v', alias: 's' }], [])
    expect(r).toEqual([{ s: 13 }])
  })
  it('group-by sum', () => {
    const r = _executeAggregation(rows, [{ fn: 'SUM', prop: 'v', alias: 's' }], ['group'])
    const byGroup = Object.fromEntries(r.map(x => [x.group, x.s]))
    expect(byGroup).toEqual({ a: 3, b: 10 })
  })
  it('empty rows count -> 0', () => {
    const r = _executeAggregation([], [{ fn: 'COUNT', prop: '*', alias: 'c' }], [])
    expect(r).toEqual([{ c: 0 }])
  })
  it('empty rows avg -> null', () => {
    const r = _executeAggregation([], [{ fn: 'AVG', prop: 'v', alias: 'a' }], [])
    expect(r).toEqual([{ a: null }])
  })
})

describe('_compareOrderByValue', () => {
  it('null sorts last', () => {
    expect(_compareOrderByValue(1, null)).toBe(-1)
    expect(_compareOrderByValue(null, 1)).toBe(1)
  })
  it('numbers', () => {
    expect(_compareOrderByValue(1, 2)).toBe(-1)
    expect(_compareOrderByValue(2, 1)).toBe(1)
    expect(_compareOrderByValue(1, 1)).toBe(0)
  })
  it('NaN sorts after number', () => {
    expect(_compareOrderByValue(1, NaN)).toBe(-1)
    expect(_compareOrderByValue(NaN, 1)).toBe(1)
    expect(_compareOrderByValue(NaN, NaN)).toBe(0)
  })
  it('cross-type string < number', () => {
    expect(_compareOrderByValue('a', 1)).toBe(-1)
  })
  it('lists lexicographic', () => {
    expect(_compareOrderByValue([1, 2], [1, 3])).toBe(-1)
    expect(_compareOrderByValue([1], [1, 2])).toBeLessThan(0)
  })
  it('__float unwrap sorts as number', () => {
    expect(_compareOrderByValue({ __float: 3 }, { __float: 4 })).toBe(-1)
  })
})

describe('_orderByField', () => {
  it('extracts field', () => expect(_orderByField({ field: 'n.name' })).toBe('name'))
  it('falls back to property', () => expect(_orderByField({ property: 'age' })).toBe('age'))
  it('default n', () => expect(_orderByField({})).toBe('n'))
})
