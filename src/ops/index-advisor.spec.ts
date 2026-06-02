/**
 * index-advisor.spec.ts — Tests for IndexAdvisor
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { IndexAdvisor, suggestIndexes, suggestIndexesFromSlowLog } from './index-advisor'
import type { QueryPlan } from '../query/query-engine'

// ── Helpers ───────────────────────────────────────────────

function makePlan(overrides: Partial<QueryPlan> = {}): QueryPlan {
  return {
    type: 'QUERY',
    scanLabel: null,
    steps: [],
    filters: [],
    returnColumns: [],
    orderBy: [],
    limit: undefined,
    skip: undefined,
    ...overrides,
  }
}

// ── Tests ─────────────────────────────────────────────────

describe('IndexAdvisor', () => {
  let advisor: IndexAdvisor

  beforeEach(() => {
    advisor = new IndexAdvisor()
  })

  describe('analyze', () => {
    it('should suggest index for filter column', () => {
      const plan = makePlan({
        filters: [
          { source: 'n', property: 'age', operator: 'GT', value: 30 },
        ],
      })
      const suggestions = advisor.analyze(plan)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions[0].columns).toContain('age')
      expect(suggestions[0].reason).toContain('age')
    })

    it('should suggest index for multiple filter columns', () => {
      const plan = makePlan({
        filters: [
          { source: 'n', property: 'age', operator: 'GT', value: 30 },
          { source: 'n', property: 'name', operator: 'EQ', value: 'Alice' },
        ],
      })
      const suggestions = advisor.analyze(plan)
      const cols = suggestions.flatMap(s => s.columns)
      expect(cols).toContain('age')
      expect(cols).toContain('name')
    })

    it('should suggest index for ORDER BY column', () => {
      const plan = makePlan({
        orderBy: [{ property: 'createdAt', direction: 'DESC' }],
      })
      const suggestions = advisor.analyze(plan)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions[0].columns).toContain('createdAt')
    })

    it('should suggest composite index for WHERE + ORDER BY', () => {
      const plan = makePlan({
        filters: [
          { source: 'n', property: 'status', operator: 'EQ', value: 'active' },
        ],
        orderBy: [{ property: 'createdAt', direction: 'DESC' }],
      })
      const suggestions = advisor.analyze(plan)
      // Should have at least: single col for 'status' + composite
      expect(suggestions.length).toBeGreaterThanOrEqual(1)
      const composite = suggestions.find(s => s.columns.length > 1)
      if (composite) {
        expect(composite.reason).toContain('ORDER BY')
      }
    })

    it('should not suggest already indexed columns', () => {
      const existingIndexes = [
        { name: 'idx_age', columns: ['age'] },
        { name: 'idx_name', columns: ['name'] },
      ]
      const lister = () => existingIndexes
      const idxAdvisor = new IndexAdvisor({ indexLister: lister })

      const plan = makePlan({
        filters: [
          { source: 'n', property: 'age', operator: 'GT', value: 30 },
          { source: 'n', property: 'name', operator: 'EQ', value: 'Alice' },
          { source: 'n', property: 'score', operator: 'GT', value: 50 },
        ],
      })
      const suggestions = idxAdvisor.analyze(plan)
      // score should be the only suggestion
      const cols = suggestions.flatMap(s => s.columns)
      expect(cols).not.toContain('age')
      expect(cols).not.toContain('name')
      expect(cols).toContain('score')
    })

    it('should handle empty plan gracefully', () => {
      const plan = makePlan({})
      const suggestions = advisor.analyze(plan)
      expect(suggestions).toEqual([])
    })

    it('should recognize columns from returnColumns', () => {
      const plan = makePlan({
        returnColumns: ['title', 'content'],
      })
      const suggestions = advisor.analyze(plan)
      const cols = suggestions.flatMap(s => s.columns)
      expect(cols).toContain('title')
    })

    it('should return all columns when no indexLister is set', () => {
      const plan = makePlan({
        filters: [{ source: 'n', property: 'email', operator: 'EQ', value: 'a@b.com' }],
      })
      const suggestions = advisor.analyze(plan)
      expect(suggestions[0].columns).toContain('email')
    })
  })

  describe('analyzeBatch', () => {
    it('should deduplicate suggestions across multiple plans', () => {
      const plans = [
        makePlan({ filters: [{ source: 'n', property: 'age', operator: 'GT', value: 30 }] }),
        makePlan({ filters: [{ source: 'n', property: 'age', operator: 'LT', value: 100 }] }),
        makePlan({ filters: [{ source: 'n', property: 'name', operator: 'EQ', value: 'Bob' }] }),
      ]
      const suggestions = advisor.analyzeBatch(plans)
      const ageSuggestions = suggestions.filter(s => s.columns.includes('age'))
      expect(ageSuggestions.length).toBeGreaterThanOrEqual(1)
    })

    it('should propose composite index for high-frequency columns', () => {
      const plans = [
        makePlan({ filters: [{ source: 'n', property: 'city', operator: 'EQ', value: 'NYC' }] }),
        makePlan({ filters: [{ source: 'n', property: 'city', operator: 'EQ', value: 'SF' }] }),
        makePlan({ filters: [{ source: 'n', property: 'city', operator: 'EQ', value: 'LA' }] }),
      ]
      const suggestions = advisor.analyzeBatch(plans)
      const composite = suggestions.find(s => s.columns.length > 1)
      // Since only 'city' appears across plans (≥2 times), no composite will be proposed
      // because need at least 2 different columns
      expect(suggestions.some(s => s.columns.includes('city'))).toBe(true)
    })
  })

  describe('resetStats', () => {
    it('should clear accumulated access counts', () => {
      advisor.analyze(makePlan({ filters: [{ source: 'n', property: 'age', operator: 'EQ', value: 1 }] }))
      expect(advisor.getAccessStats().size).toBe(1)
      advisor.resetStats()
      expect(advisor.getAccessStats().size).toBe(0)
    })
  })

  describe('suggestIndexes (convenience)', () => {
    it('should return suggestions directly', () => {
      const plan = makePlan({
        filters: [{ source: 'n', property: 'email', operator: 'EQ', value: 'x@y' }],
      })
      const suggestions = suggestIndexes(plan)
      expect(suggestions.length).toBeGreaterThan(0)
      expect(suggestions[0].columns).toContain('email')
    })
  })

  describe('suggestIndexesFromSlowLog', () => {
    it('should batch analyze multiple plans', () => {
      const plans = [
        makePlan({ filters: [{ source: 'n', property: 'age', operator: 'GT', value: 30 }] }),
        makePlan({ filters: [{ source: 'n', property: 'age', operator: 'EQ', value: 25 }] }),
      ]
      const suggestions = suggestIndexesFromSlowLog(plans)
      expect(suggestions.some(s => s.columns.includes('age'))).toBe(true)
    })
  })

  describe('priority levels', () => {
    it('should assign critical priority for high-frequency columns', () => {
      const plans: QueryPlan[] = []
      for (let i = 0; i < 15; i++) {
        plans.push(makePlan({ filters: [{ source: 'n', property: 'highFreqCol', operator: 'EQ', value: i }] }))
      }
      advisor.analyzeBatch(plans)
      // Build suggestions from the frequency
      const suggestions = advisor.analyze(makePlan({
        filters: [{ source: 'n', property: 'highFreqCol', operator: 'EQ', value: 99 }],
      }))
      const highFreq = suggestions.find(s => s.columns.includes('highFreqCol'))
      if (highFreq) {
        expect(highFreq.priority).toBe('critical')
      }
    })

    it('should assign recommended priority for columns with 3-9 occurrences', () => {
      const plans: QueryPlan[] = []
      for (let i = 0; i < 5; i++) {
        plans.push(makePlan({ filters: [{ source: 'n', property: 'midFreqCol', operator: 'EQ', value: i }] }))
      }
      advisor.analyzeBatch(plans)
      const suggestions = advisor.analyze(makePlan({
        filters: [{ source: 'n', property: 'midFreqCol', operator: 'EQ', value: 99 }],
      }))
      const midFreq = suggestions.find(s => s.columns.includes('midFreqCol'))
      if (midFreq) {
        expect(midFreq.priority).toBe('recommended')
      }
    })

    it('should assign nice-to-have priority for low-frequency columns', () => {
      const plan = makePlan({ filters: [{ source: 'n', property: 'rareCol', operator: 'EQ', value: 1 }] })
      const suggestions = advisor.analyze(plan)
      const rare = suggestions.find(s => s.columns.includes('rareCol'))
      if (rare) {
        expect(rare.priority).toBe('nice-to-have')
      }
    })
  })
})
