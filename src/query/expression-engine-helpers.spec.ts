/**
 * expression-engine-helpers.spec.ts — Unit tests for expression-engine helper functions
 *
 * Covers pure utility functions that are exported and independently testable:
 * _bigintReplacer, _bigintReviver, _isExprValue, _evalStructuredLiteral,
 * findThenIndex, _parseCommaList, _resolveNanoseconds, _formatTime,
 * _extractTimeMap.
 */
import {
  _bigintReplacer, _bigintReviver, _isExprValue, _evalStructuredLiteral,
  findThenIndex, _parseCommaList, _resolveNanoseconds, _formatTime,
  _extractTimeMap, _evalCase,
} from './expression-engine'

describe('expression-engine helpers', () => {
  // ── _bigintReplacer / _bigintReviver ───────────────
  describe('bigint serialization', () => {
    it('_bigintReplacer wraps bigint in __bigint object', () => {
      const r = _bigintReplacer('x', 42n)
      expect(r).toEqual({ __bigint: '42' })
    })

    it('_bigintReplacer passes through non-bigint values', () => {
      expect(_bigintReplacer('x', 123)).toBe(123)
      expect(_bigintReplacer('x', 'hello')).toBe('hello')
      expect(_bigintReplacer('x', null)).toBe(null)
    })

    it('_bigintReviver restores bigint from __bigint object', () => {
      const r = _bigintReviver('x', { __bigint: '9007199254740993' })
      expect(typeof r).toBe('bigint')
      expect(r).toBe(9007199254740993n)
    })

    it('_bigintReviver passes through non-__bigint values', () => {
      expect(_bigintReviver('x', { a: 1 })).toEqual({ a: 1 })
      expect(_bigintReviver('x', null)).toBe(null)
      expect(_bigintReviver('x', 42)).toBe(42)
    })
  })

  // ── _isExprValue ──────────────────────────────────
  describe('_isExprValue', () => {
    it('detects function call syntax', () => {
      expect(_isExprValue('count(*)')).toBe(true)
      expect(_isExprValue('toLower(n.name)')).toBe(true)
    })

    it('detects operators', () => {
      expect(_isExprValue('1 + 2')).toBe(true)
      expect(_isExprValue('a > b')).toBe(true)
      expect(_isExprValue('a = b')).toBe(true)
    })

    it('detects AND/OR/NOT', () => {
      expect(_isExprValue('a AND b')).toBe(true)
      expect(_isExprValue('a OR b')).toBe(true)
    })

    it('rejects plain strings and literals', () => {
      expect(_isExprValue('hello')).toBe(false)
      expect(_isExprValue('12345')).toBe(false)
    })
  })

  // ── _evalStructuredLiteral ────────────────────────
  describe('_evalStructuredLiteral', () => {
    it('evaluates STRING type', () => {
      expect(_evalStructuredLiteral({ type: 'STRING', value: 'hello' })).toBe('hello')
    })

    it('evaluates NUMBER type', () => {
      expect(_evalStructuredLiteral({ type: 'NUMBER', value: '42' })).toBe(42)
    })

    it('evaluates NUMBER as bigint for large values', () => {
      const r = _evalStructuredLiteral({ type: 'NUMBER', value: '9007199254740993' })
      expect(typeof r).toBe('bigint')
    })

    it('evaluates BOOLEAN type', () => {
      expect(_evalStructuredLiteral({ type: 'BOOLEAN', value: true })).toBe(true)
      expect(_evalStructuredLiteral({ type: 'BOOLEAN', value: 'false' })).toBe(false)
    })

    it('evaluates NULL type', () => {
      expect(_evalStructuredLiteral({ type: 'NULL' })).toBe(null)
    })

    it('evaluates LIST type', () => {
      expect(_evalStructuredLiteral({
        type: 'LIST', items: [
          { type: 'STRING', value: 'a' },
          { type: 'NUMBER', value: '1' },
        ],
      })).toEqual(['a', 1])
    })

    it('evaluates MAP type', () => {
      const r = _evalStructuredLiteral({
        type: 'MAP',
        key1: { type: 'STRING', value: 'val' },
        key2: { type: 'NUMBER', value: '99' },
      })
      expect(r).toEqual({ key1: 'val', key2: 99 })
    })

    it('defaults to null for unknown types', () => {
      expect(_evalStructuredLiteral({ type: 'UNKNOWN', value: 'x' })).toBe(null)
      expect(_evalStructuredLiteral({})).toBe(null)
    })
  })

  // ── findThenIndex ─────────────────────────────────
  describe('findThenIndex', () => {
    it('finds THEN at top level', () => {
      expect(findThenIndex('x > 0 THEN 1')).toBe(6)
    })

    it('skips THEN inside parentheses', () => {
      expect(findThenIndex('(a THEN b) > 0 THEN 42')).toBeGreaterThan(12)
    })

    it('skips THEN inside brackets', () => {
      expect(findThenIndex('[THEN value] THEN result')).toBeGreaterThan(11)
    })

    it('returns -1 when no THEN found', () => {
      expect(findThenIndex('no keyword here')).toBe(-1)
    })
  })

  // ── _parseCommaList ───────────────────────────────
  describe('_parseCommaList', () => {
    it('splits on commas at depth 0', () => {
      expect(_parseCommaList('a, b, c')).toEqual(['a', 'b', 'c'])
    })

    it('ignores commas inside parentheses', () => {
      expect(_parseCommaList('a, func(b, c), d')).toEqual(['a', 'func(b, c)', 'd'])
    })

    it('handles quoted strings with commas', () => {
      expect(_parseCommaList("'hello, world', b")).toEqual(["'hello, world'", 'b'])
    })

    it('handles empty string', () => {
      expect(_parseCommaList('')).toEqual([])
    })

    it('handles single value', () => {
      expect(_parseCommaList('solo')).toEqual(['solo'])
    })

    it('handles nested brackets', () => {
      expect(_parseCommaList('[[1,2],[3,4]], x')).toEqual(['[[1,2],[3,4]]', 'x'])
    })
  })

  // ── _resolveNanoseconds ───────────────────────────
  describe('_resolveNanoseconds', () => {
    it('combines millisecond, microsecond, nanosecond', () => {
      expect(_resolveNanoseconds({ milliseconds: 1, microseconds: 2, nanoseconds: 3 })).toBe(1002003)
    })

    it('handles singular millisecond/microsecond/nanosecond', () => {
      expect(_resolveNanoseconds({ millisecond: 2, microsecond: 3, nanosecond: 5 })).toBe(2003005)
    })

    it('returns 0 for empty map', () => {
      expect(_resolveNanoseconds({})).toBe(0)
    })

    it('handles only nanoseconds', () => {
      expect(_resolveNanoseconds({ nanoseconds: 999 })).toBe(999)
    })
  })

  // ── _formatTime ────────────────────────────────────
  describe('_formatTime', () => {
    it('formats simple time', () => {
      expect(_formatTime(12, 30, 0, 0)).toBe('12:30')
    })

    it('formats with seconds', () => {
      expect(_formatTime(12, 30, 45, 0)).toBe('12:30:45')
    })

    it('formats with nanoseconds', () => {
      expect(_formatTime(12, 30, 45, 123456000)).toBe('12:30:45.123456')
    })
  })

  // ── _extractTimeMap ────────────────────────────────
  describe('_extractTimeMap', () => {
    it('extracts time components', () => {
      const r = _extractTimeMap({ hour: 14, minute: 5, second: 30, nanosecond: 0 })
      expect(r).toEqual({ hour: 14, minute: 5, second: 30, nanosecond: 0 })
    })
  })
})
