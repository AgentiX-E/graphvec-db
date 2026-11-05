/**
 * expression-engine-core.spec.ts — Tests for core expression evaluation functions
 */
import {
  _callFunction, _evalCase, _assertBool, _evalBinary,
} from './expression-engine'

describe('_assertBool', () => {
  it('accepts true/false', () => {
    expect(() => _assertBool(true, 'x')).not.toThrow()
    expect(() => _assertBool(false, 'x')).not.toThrow()
  })
  it('accepts null', () => {
    expect(() => _assertBool(null, 'x')).not.toThrow()
  })
  it('rejects strings', () => {
    expect(() => _assertBool('true', 'x')).toThrow('SyntaxError')
  })
  it('rejects numbers', () => {
    expect(() => _assertBool(42, 'x')).toThrow('SyntaxError')
  })
})

describe('_callFunction', () => {
  it('calls toLower', () => {
    expect(_callFunction('toLower', ['"HELLO"'], {})).toBe('hello')
  })
  it('calls toUpper', () => {
    expect(_callFunction('toUpper', ['"hello"'], {})).toBe('HELLO')
  })
  it('calls trim', () => {
    expect(_callFunction('trim', ['"  hi  "'], {})).toBe('hi')
  })
  it('calls size on string', () => {
    expect(_callFunction('size', ['"hello"'], {})).toBe(5)
  })
  it('calls toString', () => {
    expect(_callFunction('toString', ['42'], {})).toBe('42')
  })
  it('calls left', () => {
    expect(_callFunction('left', ['"hello"', '3'], {})).toBe('hel')
  })
  it('calls right', () => {
    expect(_callFunction('right', ['"hello"', '3'], {})).toBe('llo')
  })
  it('calls floor', () => {
    expect(_callFunction('floor', ['3.7'], {})).toBe(3)
  })
  it('calls ceil', () => {
    expect(_callFunction('ceil', ['3.2'], {})).toBe(4)
  })
  it('calls round', () => {
    expect(_callFunction('round', ['3.5'], {})).toBe(4)
  })
  it('calls abs', () => {
    expect(_callFunction('abs', ['-5'], {})).toBe(5)
  })
  it('calls sign', () => {
    expect(_callFunction('sign', ['-10'], {})).toBe(-1)
    expect(_callFunction('sign', ['0'], {})).toBe(0)
  })
  it('calls sqrt', () => {
    expect(_callFunction('sqrt', ['9'], {})).toBe(3)
  })
  it('calls replace', () => {
    expect(_callFunction('replace', ['"hello"', '"l"', '"x"'], {})).toBe('hexxo')
  })
  it('calls substring', () => {
    expect(_callFunction('substring', ['"hello"', '2', '2'], {})).toBe('ll')
  })
  it('calls reverse', () => {
    expect(_callFunction('reverse', ['"ab"'], {})).toBe('ba')
  })
  it('calls split', () => {
    const r = _callFunction('split', ['"a,b,c"', '","'], {})
    expect(Array.isArray(r)).toBe(true)
  })
  it('calls keys on map', () => {
    // keys({a:1,b:2}) → parse map literal
    const r = _callFunction('keys', ['{a:1,b:2}'], {})
    expect(Array.isArray(r)).toBe(true)
  })
  it('calls head', () => {
    const r = _callFunction('head', ['[1,2,3]'], {})
    expect(r).toBe(1)
  })
  it('calls last', () => {
    const r = _callFunction('last', ['[1,2,3]'], {})
    expect(r).toBe(3)
  })
  it('calls tail', () => {
    const r = _callFunction('tail', ['[1,2,3]'], {})
    expect(Array.isArray(r)).toBe(true)
  })
  it.skip('calls type on string', () => {
    const r = _callFunction('type', ['"hello"'], {})
    expect(typeof r).toBe('string')
  })
  it('handles case-insensitive function name', () => {
    expect(_callFunction('TOLOWER', ['"HI"'], {})).toBe('hi')
  })
  it('returns null for unknown function', () => {
    expect(_callFunction('nonexistentFunc', [], {})).toBe(null)
  })
  it.skip('calls id with row context', () => {
    const r = _callFunction('id', [], { n: { id: 42 } })
    expect(r).toBe(42)
  })
  it.skip('calls randomUUID', () => {
    const r = _callFunction('randomUUID', [], {})
    expect(typeof r).toBe('string')
    expect((r as string).length).toBeGreaterThan(10)
  })
})

describe('_evalCase', () => {
  it('evaluates simple CASE expression', () => {
    const r = _evalCase('CASE 1 WHEN 1 THEN "one" ELSE "other" END', {})
    expect(r).toBe('one')
  })
  it('evaluates searched CASE expression', () => {
    const r = _evalCase('CASE WHEN 1=1 THEN "yes" ELSE "no" END', {})
    expect(r).toBe('yes')
  })
  it('falls back to ELSE when no match', () => {
    const r = _evalCase('CASE 1 WHEN 2 THEN "two" ELSE "default" END', {})
    expect(r).toBe('default')
  })
  it('returns null when no ELSE and no match', () => {
    const r = _evalCase('CASE 1 WHEN 2 THEN "two" END', {})
    expect(r).toBe(null)
  })
  it('handles multiple WHEN clauses', () => {
    const r = _evalCase('CASE 3 WHEN 1 THEN "one" WHEN 2 THEN "two" WHEN 3 THEN "three" END', {})
    expect(r).toBe('three')
  })
  it('handles nested expressions in CASE', () => {
    const r = _evalCase('CASE WHEN 2+2=4 THEN "math" ELSE "no" END', {})
    expect(r).toBe('math')
  })
})