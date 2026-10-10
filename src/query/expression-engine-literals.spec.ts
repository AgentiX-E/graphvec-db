import { describe, it, expect } from 'vitest'
import {
  _validateLiterals, _detectMissingCommas, _isPureLiteralExpr, _evaluateExpression,
} from './expression-engine'

/** Coverage for literal validation & the pure-literal classifier. */

describe('_validateLiterals — valid inputs (no throw)', () => {
  it('accepts plain int', () => expect(() => _validateLiterals('RETURN 42')).not.toThrow())
  it('accepts list with commas', () => expect(() => _validateLiterals('RETURN [1,2,3]')).not.toThrow())
  it('accepts map', () => expect(() => _validateLiterals("RETURN {a:1,b:2}")).not.toThrow())
  it('accepts float', () => expect(() => _validateLiterals('RETURN 3.14')).not.toThrow())
  it('accepts hex within range', () => expect(() => _validateLiterals('RETURN 0xFF')).not.toThrow())
  it('accepts unicode escape', () => expect(() => _validateLiterals("RETURN '\\u0041'")).not.toThrow())
  it('skips non-RETURN query', () => expect(() => _validateLiterals('MATCH (n)')).not.toThrow())
  it('complex expr not validated as literal', () => expect(() => _validateLiterals('RETURN [1,2] = [1]')).not.toThrow())
})

describe('_validateLiterals — integer overflow', () => {
  it('overflows int64 max', () => {
    expect(() => _validateLiterals('RETURN 9223372036854775808')).toThrow(/IntegerOverflow/)
  })
  it('overflows negative min', () => {
    expect(() => _validateLiterals('RETURN -9223372036854775809')).toThrow(/IntegerOverflow/)
  })
  it('accepts int64 boundary', () => {
    expect(() => _validateLiterals('RETURN 9223372036854775807')).not.toThrow()
  })
})

describe('_validateLiterals — invalid number literals', () => {
  it('rejects bad digits', () => {
    expect(() => _validateLiterals('RETURN 9223372#54775808')).toThrow(/InvalidNumberLiteral/)
  })
  it('rejects empty hex', () => {
    expect(() => _validateLiterals('RETURN 0x')).toThrow(/InvalidNumberLiteral/)
  })
  it('rejects non-hex hex', () => {
    expect(() => _validateLiterals('RETURN 0xGG')).toThrow(/InvalidNumberLiteral/)
  })
  it('rejects octal with invalid digits', () => {
    expect(() => _validateLiterals('RETURN 0o89')).toThrow(/InvalidNumberLiteral/)
  })
})

describe('_validateLiterals — map syntax errors', () => {
  it('rejects only-comma map', () => {
    expect(() => _validateLiterals('RETURN {,}')).toThrow(/UnexpectedSyntax/)
  })
  it('rejects map without key', () => {
    expect(() => _validateLiterals('RETURN {1}')).toThrow(/UnexpectedSyntax/)
  })
  it('rejects numeric-leading key', () => {
    expect(() => _validateLiterals('RETURN {1a:2}')).toThrow(/UnexpectedSyntax/)
  })
  it('rejects dotted key', () => {
    expect(() => _validateLiterals('RETURN {a.b:2}')).toThrow(/UnexpectedSyntax/)
  })
})

describe('_validateLiterals — missing commas & size(pattern)', () => {
  it('rejects list missing comma', () => {
    expect(() => _validateLiterals("RETURN ['a''b']")).toThrow(/UnexpectedSyntax/)
  })
  it('rejects size() on pattern predicate', () => {
    expect(() => _validateLiterals('RETURN size((a)-->(b))')).toThrow(/UnexpectedSyntax/)
  })
})

describe('_validateLiterals — floating point overflow', () => {
  it('rejects 1e400', () => {
    expect(() => _validateLiterals('RETURN 1e400')).toThrow(/FloatingPointOverflow/)
  })
})

describe('_validateLiterals — unicode literal', () => {
  it('rejects invalid unicode escape', () => {
    expect(() => _validateLiterals("RETURN '\\uH'")).toThrow(/InvalidUnicodeLiteral/)
  })
})

describe('_detectMissingCommas', () => {
  it('detects adjacent list literals', () => {
    expect(_detectMissingCommas("['a''b']")).toBe(true)
  })
  it('accepts proper comma list', () => {
    expect(_detectMissingCommas('[1,2,3]')).toBe(false)
  })
  it('empty list', () => expect(_detectMissingCommas('[]')).toBe(false))
  it('nested missing comma detected', () => {
    expect(_detectMissingCommas('[1,[2 3]]')).toBe(true)
  })
  it('leading comma -> missing', () => {
    expect(_detectMissingCommas('[,1]')).toBe(true)
  })
  it('non-list/non-map -> false', () => {
    expect(_detectMissingCommas('42')).toBe(false)
  })
})

describe('_isPureLiteralExpr', () => {
  it('plain int is pure', () => expect(_isPureLiteralExpr('42')).toBe(true))
  it('arithmetic is not pure', () => expect(_isPureLiteralExpr('1+2')).toBe(false))
  it('comparison is not pure', () => expect(_isPureLiteralExpr('1=2')).toBe(false))
  it('list comprehension is not pure', () => expect(_isPureLiteralExpr('[x IN [1] | x]')).toBe(false))
  it('negative literal is pure', () => expect(_isPureLiteralExpr('-42')).toBe(true))
  it('map literal is pure', () => expect(_isPureLiteralExpr('{a:1}')).toBe(true))
  it('boolean IN operator is not pure', () => expect(_isPureLiteralExpr('x IN [1,2]')).toBe(false))
  it('boolean AND operator is not pure', () => expect(_isPureLiteralExpr('a AND b')).toBe(false))
})

describe('percentile functions', () => {
  it('percentileDisc', () => {
    expect(_evaluateExpression('percentileDisc([1,2,3,4], 0.5)', {})).toBe(2)
  })
  it('percentileCont interpolates', () => {
    expect(_evaluateExpression('percentileCont([1,2,3,4], 0.5)', {})).toBe(2.5)
  })
  it('percentile out of range throws', () => {
    expect(() => _evaluateExpression('percentileDisc([1,2], 1.5)', {})).toThrow(/NumberOutOfRange/)
  })
  it('percentile on empty -> null', () => {
    expect(_evaluateExpression('percentileDisc([], 0.5)', {})).toBe(null)
  })
})

describe('datetime.fromepoch', () => {
  it('fromepoch', () => {
    expect(_evaluateExpression('datetime.fromepoch(0)', {})).toBe('1970-01-01T00:00:00.000Z')
  })
  it('fromepochmillis', () => {
    expect(_evaluateExpression('datetime.fromepochmillis(0)', {})).toBe('1970-01-01T00:00:00.000Z')
  })
})
