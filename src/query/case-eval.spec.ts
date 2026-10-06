/**
 * CASE expression runtime evaluation unit tests.
 *
 * Tests _evalCase (string-based Cypher CASE evaluation). The legacy
 * AST-object API (_evalCaseExprOnRow/_applyCaseColumns) was replaced by the
 * string-driven _evalCase in expression-engine.ts. This spec migrates the
 * semantic matrix to the new API while preserving coverage of:
 *   - searched CASE with comparison operators (EQ/GT/GTE/LT/NEQ)
 *   - AND / OR compound conditions
 *   - ELSE fallback and short-circuit multi-WHEN matching
 *   - simple CASE (CASE <value> WHEN <v> THEN ...)
 *   - NULL / missing-property propagation
 */
import { describe, it, expect } from 'vitest'
import { _evalCase } from './expression-engine'

// Helper: build a row with sensible defaults.
function row(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    name: 'Alice',
    age: 30,
    score: 85,
    city: 'Beijing',
    isActive: true,
    ...overrides,
  }
}

describe('_evalCase — searched CASE (CASE WHEN <cond> THEN <r>)', () => {
  it('EQ comparison', () => {
    expect(_evalCase("CASE WHEN age = 30 THEN 'adult' END", row())).toBe('adult')
    expect(_evalCase("CASE WHEN age = 30 THEN 'adult' END", row({ age: 25 }))).toBeNull()
  })

  it('GT comparison', () => {
    expect(_evalCase("CASE WHEN age > 18 THEN 'adult' END", row({ age: 20 }))).toBe('adult')
    expect(_evalCase("CASE WHEN age > 18 THEN 'adult' END", row({ age: 15 }))).toBeNull()
  })

  it('GTE comparison', () => {
    expect(_evalCase("CASE WHEN score >= 60 THEN 'pass' END", row({ score: 85 }))).toBe('pass')
    expect(_evalCase("CASE WHEN score >= 60 THEN 'pass' END", row({ score: 59 }))).toBeNull()
  })

  it('LT comparison', () => {
    expect(_evalCase("CASE WHEN age < 18 THEN 'minor' END", row({ age: 15 }))).toBe('minor')
    expect(_evalCase("CASE WHEN age < 18 THEN 'minor' END", row({ age: 20 }))).toBeNull()
  })

  it('NEQ comparison (Cypher <> inequality)', () => {
    expect(_evalCase("CASE WHEN name <> 'Alice' THEN 'other' END", row({ name: 'Bob' }))).toBe('other')
    expect(_evalCase("CASE WHEN name <> 'Alice' THEN 'other' END", row({ name: 'Alice' }))).toBeNull()
  })
})

describe('_evalCase — AND / OR compound conditions', () => {
  it('AND', () => {
    expect(_evalCase("CASE WHEN age > 18 AND age < 65 THEN 'working' END", row({ age: 30 }))).toBe('working')
    expect(_evalCase("CASE WHEN age > 18 AND age < 65 THEN 'working' END", row({ age: 10 }))).toBeNull()
    expect(_evalCase("CASE WHEN age > 18 AND age < 65 THEN 'working' END", row({ age: 70 }))).toBeNull()
  })

  it('OR', () => {
    expect(_evalCase("CASE WHEN age < 18 OR age > 65 THEN 'special' END", row({ age: 15 }))).toBe('special')
    expect(_evalCase("CASE WHEN age < 18 OR age > 65 THEN 'special' END", row({ age: 70 }))).toBe('special')
    expect(_evalCase("CASE WHEN age < 18 OR age > 65 THEN 'special' END", row({ age: 30 }))).toBeNull()
  })

  it('AND across two properties', () => {
    expect(_evalCase("CASE WHEN age > 18 AND city = 'Beijing' THEN 'local-adult' END", row({ age: 25, city: 'Beijing' }))).toBe('local-adult')
    expect(_evalCase("CASE WHEN age > 18 AND city = 'Beijing' THEN 'local-adult' END", row({ age: 25, city: 'Shanghai' }))).toBeNull()
  })
})

describe('_evalCase — ELSE fallback and short-circuit multi-WHEN', () => {
  it('ELSE fallback', () => {
    expect(_evalCase("CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END", row({ age: 25 }))).toBe('adult')
    expect(_evalCase("CASE WHEN age > 18 THEN 'adult' ELSE 'minor' END", row({ age: 15 }))).toBe('minor')
  })

  it('multi-WHEN short-circuit (first match wins)', () => {
    const expr = "CASE WHEN score >= 90 THEN 'A' WHEN score >= 80 THEN 'B' ELSE 'C' END"
    expect(_evalCase(expr, row({ score: 95 }))).toBe('A')
    expect(_evalCase(expr, row({ score: 85 }))).toBe('B')
    expect(_evalCase(expr, row({ score: 70 }))).toBe('C')
  })

  it('multi-WHEN equality short-circuit', () => {
    const expr = "CASE WHEN age = 10 THEN 'first' WHEN age = 20 THEN 'second' END"
    expect(_evalCase(expr, row({ age: 10 }))).toBe('first')
    expect(_evalCase(expr, row({ age: 20 }))).toBe('second')
    expect(_evalCase(expr, row({ age: 30 }))).toBeNull()
  })
})

describe('_evalCase — simple CASE (CASE <value> WHEN <v> THEN <r>)', () => {
  it('numeric WHEN values', () => {
    const expr = "CASE age WHEN 10 THEN 'child' WHEN 20 THEN 'youth' ELSE 'other' END"
    expect(_evalCase(expr, row({ age: 10 }))).toBe('child')
    expect(_evalCase(expr, row({ age: 20 }))).toBe('youth')
    expect(_evalCase(expr, row({ age: 30 }))).toBe('other')
  })

  it('string WHEN value', () => {
    const expr = "CASE name WHEN 'Alice' THEN 'found' ELSE 'missing' END"
    expect(_evalCase(expr, row({ name: 'Alice' }))).toBe('found')
    expect(_evalCase(expr, row({ name: 'Bob' }))).toBe('missing')
  })
})

describe('_evalCase — NULL / missing-property propagation', () => {
  it('missing property falls through to ELSE', () => {
    expect(_evalCase("CASE WHEN missingProp = 10 THEN 'found' ELSE 'not-found' END", row())).toBe('not-found')
  })

  it('no match and no ELSE yields null', () => {
    expect(_evalCase("CASE WHEN age = 999 THEN 'never' END", row())).toBeNull()
  })
})
