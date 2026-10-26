/**
 * fulltext-components.spec.ts — unit tests for the pure text-analysis building
 * blocks of the full-text index (Analyzers, AnalyzerChain, SynonymMap).
 *
 * These components are deterministic and dependency-free. Isolating their
 * coverage here (rather than only via the persistence-heavy FullTextIndex
 * suite) keeps the tests fast and makes the analysis/synonym semantics their
 * own, directly-testable contract.
 */
import { describe, it, expect } from 'vitest'
import { Analyzers, AnalyzerChain, SynonymMap } from './fulltext'

describe('Analyzers', () => {
  it('simple lowercases and splits on non-alphanumerics', () => {
    expect(Analyzers.simple('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('simple filters empty tokens from repeated separators', () => {
    expect(Analyzers.simple('a,,,b')).toEqual(['a', 'b'])
  })

  it('standard splits on punctuation and whitespace but keeps digits', () => {
    expect(Analyzers.standard('foo.bar;baz!qux?')).toEqual(['foo', 'bar', 'baz', 'qux'])
  })

  it('whitespace only splits on whitespace, preserving punctuation', () => {
    expect(Analyzers.whitespace('foo,bar baz')).toEqual(['foo,bar', 'baz'])
  })

  it('cjk emits bigrams for CJK runs and tokenizes latin runs separately', () => {
    // "你好" -> ['你好']; "你好啊" -> ['你好','好啊']
    const tokens = Analyzers.cjk('你好世界')
    expect(tokens).toContain('你好')
    expect(tokens).toContain('好世')
    expect(tokens).toContain('世界')
  })

  it('cjk handles a single CJK character without crashing', () => {
    expect(Analyzers.cjk('中')).toEqual(['中'])
  })

  it('cjk mixes CJK and latin without dropping either', () => {
    const tokens = Analyzers.cjk('你好abc世界')
    // '你好' is a 2-char CJK run → bigram ['你好'], then latin 'abc', then '世界'
    expect(tokens).toContain('你好')
    expect(tokens).toContain('abc')
    expect(tokens).toContain('世界')
  })
})

describe('AnalyzerChain', () => {
  it('analyzes with a single step', () => {
    const chain = new AnalyzerChain().use((t) => t.split(' '))
    expect(chain.analyze('a b c')).toEqual(['a', 'b', 'c'])
  })

  it('chains multiple analyzers in order', () => {
    const chain = new AnalyzerChain()
      .use((t) => t.split(' '))
      .use((t) => [t.toUpperCase()])
    // flatMap applies uppercase to each token produced by split
    expect(chain.analyze('a b')).toEqual(['A', 'B'])
  })

  it('deduplicates tokens after the full chain', () => {
    const chain = new AnalyzerChain().use((t) => t.split(/[,\s]+/))
    expect(chain.analyze('a,a a')).toEqual(['a'])
  })

  it('useAnalyzer resolves a named analyzer', () => {
    const chain = new AnalyzerChain().useAnalyzer('simple')
    expect(chain.analyze('Hello, World!')).toEqual(['hello', 'world'])
  })

  it('useAnalyzer throws for an unknown analyzer name', () => {
    const chain = new AnalyzerChain()
    expect(() => chain.useAnalyzer('not-a-real-analyzer')).toThrow(/Unknown analyzer/)
  })

  it('clear empties the chain and length reflects the count', () => {
    const chain = new AnalyzerChain().use((t) => [t]).use((t) => [t])
    expect(chain.length).toBe(2)
    chain.clear()
    expect(chain.length).toBe(0)
    expect(chain.analyze('x')).toEqual(['x'])
  })

  it('constructor accepts an initial analyzer list', () => {
    const chain = new AnalyzerChain([(t) => t.split('')])
    expect(chain.analyze('ab')).toEqual(['a', 'b'])
  })
})

describe('SynonymMap', () => {
  it('expands forward synonyms', () => {
    const m = new SynonymMap()
    m.setSynonyms({ computer: ['pc'] })
    expect(m.getSynonyms('computer')).toEqual(expect.arrayContaining(['computer', 'pc']))
  })

  it('expands reverse synonyms (bidirectional)', () => {
    const m = new SynonymMap()
    m.setSynonyms({ computer: ['pc'] })
    // Searching "pc" should also surface "computer"
    expect(m.getSynonyms('pc')).toEqual(expect.arrayContaining(['pc', 'computer']))
  })

  it('is case-insensitive for both terms and synonyms', () => {
    const m = new SynonymMap()
    m.setSynonyms({ 'Computer': ['PC'] })
    expect(m.getSynonyms('computer')).toEqual(expect.arrayContaining(['computer', 'pc']))
    expect(m.getSynonyms('pc')).toEqual(expect.arrayContaining(['pc', 'computer']))
  })

  it('returns only the term itself when no synonym is registered', () => {
    const m = new SynonymMap()
    expect(m.getSynonyms('unknown')).toEqual(['unknown'])
    // ensure it is lowercased
    expect(m.getSynonyms('Unknown')).toEqual(['unknown'])
  })

  it('supports one-to-many synonyms', () => {
    const m = new SynonymMap()
    m.setSynonyms({ car: ['auto', 'automobile'] })
    const syns = m.getSynonyms('car')
    expect(syns).toEqual(expect.arrayContaining(['car', 'auto', 'automobile']))
    // reverse: 'auto' -> 'car'
    expect(m.getSynonyms('auto')).toEqual(expect.arrayContaining(['car', 'auto']))
  })

  it('expandQuery expands every query term and deduplicates', () => {
    const m = new SynonymMap()
    m.setSynonyms({ car: ['auto'] })
    const expanded = m.expandQuery('car auto')
    // 'car' -> [car, auto]; 'auto' -> [auto, car]; deduped
    expect(new Set(expanded)).toEqual(new Set(['car', 'auto']))
  })

  it('setSynonymsFromMap accepts a Map input', () => {
    const m = new SynonymMap()
    m.setSynonymsFromMap(new Map([['fast', ['quick']]]))
    expect(m.getSynonyms('fast')).toEqual(expect.arrayContaining(['fast', 'quick']))
  })

  it('size reports the number of registered terms and clear resets', () => {
    const m = new SynonymMap()
    expect(m.size).toBe(0)
    m.setSynonyms({ a: ['b'], c: ['d'] })
    expect(m.size).toBe(2)
    m.clear()
    expect(m.size).toBe(0)
    expect(m.getSynonyms('a')).toEqual(['a'])
  })

  it('does not leak stale reverse mappings when a term is redefined', () => {
    // Redefining a term should replace its synonym set, not accumulate the
    // old reverse edges. This is the bidirectional-map consistency contract.
    const m = new SynonymMap()
    m.setSynonyms({ computer: ['pc'] })
    m.setSynonyms({ computer: ['laptop'] })

    // After redefinition, 'pc' should no longer map back to 'computer'.
    expect(m.getSynonyms('pc')).toEqual(['pc'])
    expect(m.getSynonyms('laptop')).toEqual(expect.arrayContaining(['laptop', 'computer']))
    expect(m.getSynonyms('computer')).toEqual(expect.arrayContaining(['computer', 'laptop']))
  })
})
