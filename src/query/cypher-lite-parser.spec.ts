import { describe, it, expect, vi } from 'vitest'
import { parser } from './cypher-lite-parser'

describe('cypher-lite-parser', () => {
  it('exports a parser object with parse method', () => {
    expect(parser).toBeDefined()
    expect(typeof parser.parse).toBe('function')
  })

  it('parse works for valid MATCH query', () => {
    const result = parser.parse('MATCH (n) RETURN n')
    expect(result).toBeDefined()
    expect(Array.isArray(result) || typeof result === 'object').toBe(true)
  })

  it('parse works for CREATE query', () => {
    const result = parser.parse('CREATE (n:Person {name: "Alice"})')
    expect(result).toBeDefined()
  })

  it('parse works for simple match with WHERE', () => {
    const result = parser.parse('MATCH (a)-[:KNOWS]->(b) WHERE a.age > 25 RETURN a, b')
    expect(result).toBeDefined()
  })

  it('throws SyntaxError for invalid input', () => {
    expect(() => parser.parse('INVALID QUERY')).toThrow(SyntaxError)
  })

  it('throws for empty input', () => {
    expect(() => parser.parse('')).toThrow(SyntaxError)
  })

  it('throws for garbage input', () => {
    expect(() => parser.parse('!!!')).toThrow(SyntaxError)
  })

  it('handles MERGE query', () => {
    const result = parser.parse('MERGE (n:Person {id: 1})')
    expect(result).toBeDefined()
  })

  it('handles DELETE query', () => {
    const result = parser.parse('MATCH (n) DETACH DELETE n')
    expect(result).toBeDefined()
  })

  it('handles SET query', () => {
    const result = parser.parse('MATCH (n) SET n.name = "test"')
    expect(result).toBeDefined()
  })

  it('handles WITH clause', () => {
    const result = parser.parse('MATCH (n) WITH n.name AS name RETURN name')
    expect(result).toBeDefined()
  })

  it('handles complex query with multiple patterns', () => {
    const result = parser.parse(`MATCH (a:Person)-[:KNOWS]->(b:Person)
WHERE a.age > 25
RETURN a.name, b.name
ORDER BY a.name
LIMIT 10`)
    expect(result).toBeDefined()
  })
})
