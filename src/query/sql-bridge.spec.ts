// ============================================================
// sql-bridge.spec.ts — SqlToCypherBridge 测试套件
// ============================================================

import { describe, it, expect } from 'vitest'
import {
  SqlToCypherBridge,
  type SqlTranslationResult,
  type SqlTranslationError,
} from './sql-bridge'

// ── Test Helpers ──────────────────────────

function expectCypher(result: any): asserts result is SqlTranslationResult {
  expect(result).toHaveProperty('cypher')
  expect(typeof (result as SqlTranslationResult).cypher).toBe('string')
}

function expectError(result: any, code?: string): asserts result is SqlTranslationError {
  expect(result).toHaveProperty('message')
  expect(result).toHaveProperty('code')
  if (code) {
    expect(result.code).toBe(code)
  }
}

// ── Tests ─────────────────────────────────

describe('SqlToCypherBridge', () => {
  const bridge = new SqlToCypherBridge()

  describe('translate — basic SELECT', () => {
    it('should translate SELECT * FROM nodes', () => {
      const result = bridge.translate('SELECT * FROM nodes')
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toContain('RETURN')
    })

    it('should translate SELECT n.name FROM nodes n', () => {
      const result = bridge.translate('SELECT n.name FROM nodes n')
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toMatch(/RETURN.*n\.name/)
    })

    it('should translate SELECT name, age FROM nodes', () => {
      const result = bridge.translate('SELECT name, age FROM nodes')
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toContain('RETURN')
    })
  })

  describe('translate — WHERE clause', () => {
    it('should translate WHERE with simple equality', () => {
      const result = bridge.translate(
        "SELECT n.name FROM nodes n WHERE n.age = 30",
      )
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toContain('WHERE')
      expect(result.cypher).toContain('n.age')
    })

    it('should translate WHERE with comparison operators', () => {
      const result = bridge.translate(
        'SELECT n.name FROM nodes n WHERE n.age > 25',
      )
      expectCypher(result)
      expect(result.cypher).toContain('>')
    })

    it('should translate WHERE with AND', () => {
      const result = bridge.translate(
        "SELECT n.name FROM nodes n WHERE n.age > 25 AND n.city = 'NYC'",
      )
      expectCypher(result)
      expect(result.cypher).toContain('AND')
    })
  })

  describe('translate — ORDER BY', () => {
    it('should translate ORDER BY ASC', () => {
      const result = bridge.translate(
        'SELECT n.name FROM nodes n ORDER BY n.name',
      )
      expectCypher(result)
      expect(result.cypher).toMatch(/ORDER BY/i)
    })

    it('should translate ORDER BY DESC', () => {
      const result = bridge.translate(
        'SELECT n.age FROM nodes n ORDER BY n.age DESC',
      )
      expectCypher(result)
      expect(result.cypher).toMatch(/ORDER BY/i)
      expect(result.cypher).toMatch(/DESC/i)
    })
  })

  describe('translate — LIMIT', () => {
    it('should translate LIMIT', () => {
      const result = bridge.translate('SELECT n.name FROM nodes n LIMIT 10')
      expectCypher(result)
      expect(result.cypher).toMatch(/LIMIT\s+10/i)
    })
  })

  describe('translate — FROM edges', () => {
    it('should translate FROM edges', () => {
      const result = bridge.translate('SELECT * FROM edges')
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toContain('-[')
      expect(result.cypher).toContain(']->')
    })
  })

  describe('translate — unsupported', () => {
    it('should reject multi-table JOIN', () => {
      const result = bridge.translate(
        'SELECT * FROM nodes n JOIN edges e ON n.id = e.source',
      )
      expectError(result, 'UNSUPPORTED_JOIN')
    })

    it('should reject subqueries', () => {
      const result = bridge.translate(
        'SELECT * FROM (SELECT * FROM nodes) AS sub',
      )
      expectError(result, 'UNSUPPORTED_SUBQUERY')
    })
  })

  describe('translate — edge cases', () => {
    it('should handle empty SQL string', () => {
      const result = bridge.translate('')
      expectError(result, 'PARSE_ERROR')
    })

    it('should handle whitespace SQL', () => {
      const result = bridge.translate('   ')
      expectError(result, 'PARSE_ERROR')
    })

    it('should handle SELECT with WHERE containing string', () => {
      const result = bridge.translate(
        "SELECT n.name FROM nodes n WHERE n.name = 'Alice'",
      )
      expectCypher(result)
      expect(result.cypher).toContain('WHERE')
    })

    it('should handle boolean values', () => {
      const result = bridge.translate(
        'SELECT n.active FROM nodes n WHERE n.active = true',
      )
      expectCypher(result)
      expect(result.cypher).toContain('WHERE')
    })

    it('should handle IN clause', () => {
      const result = bridge.translate(
        "SELECT n.name FROM nodes n WHERE n.city IN ('NYC', 'SF')",
      )
      expectCypher(result)
      expect(result.cypher).toContain('IN')
    })
  })

  describe('translate — custom label', () => {
    it('should handle FROM with custom table name as label', () => {
      const result = bridge.translate(
        'SELECT p.name FROM Person p WHERE p.age > 18',
      )
      expectCypher(result)
      expect(result.cypher).toContain('MATCH')
      expect(result.cypher).toContain('Person')
    })
  })

  describe('isSupported', () => {
    it('should report SELECT as supported', () => {
      const result = bridge.isSupported('SELECT * FROM nodes')
      expect(result.supported).toBe(true)
    })

    it('should report JOIN as unsupported', () => {
      const result = bridge.isSupported(
        'SELECT * FROM nodes JOIN edges ON 1=1',
      )
      expect(result.supported).toBe(false)
    })

    it('should report invalid SQL as unsupported', () => {
      const result = bridge.isSupported('INVALID SQL STATEMENT')
      expect(result.supported).toBe(false)
    })
  })
})

describe('SqlToCypherBridge — real-world query patterns', () => {
  const bridge = new SqlToCypherBridge()

  it('should produce valid Cypher structure for common query', () => {
    const result = bridge.translate(
      "SELECT n.name, n.age FROM nodes n WHERE n.age > 30 AND n.city = 'NYC' ORDER BY n.age DESC LIMIT 10",
    )
    expectCypher(result)
    expect(result.cypher).toContain('MATCH')
    expect(result.cypher).toContain('WHERE')
    expect(result.cypher).toContain('>')
    expect(result.cypher).toContain('RETURN')
    expect(result.cypher).toMatch(/LIMIT\s+10/i)
    expect(result.cypher).toMatch(/DESC/i)
  })

  it('should handle query with no explicit alias', () => {
    const result = bridge.translate(
      'SELECT name FROM nodes WHERE age > 18 ORDER BY age LIMIT 5',
    )
    expectCypher(result)
    expect(result.cypher).toContain('MATCH')
    expect(result.cypher).toContain('WHERE')
  })

  it('should handle simple edges query', () => {
    const result = bridge.translate(
      'SELECT e.weight FROM edges e WHERE e.weight > 0.5',
    )
    expectCypher(result)
    expect(result.cypher).toContain('-[')
    expect(result.cypher).toContain(']->')
  })

  it('should not produce warnings for clean translation', () => {
    const result = bridge.translate(
      'SELECT n.name FROM nodes n WHERE n.age = 25',
    )
    expectCypher(result)
    expect(result.warnings).toEqual([])
  })
})
