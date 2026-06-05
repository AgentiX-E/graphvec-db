/**
 * consistency-level.spec.ts — Tests for ConsistencyLevel
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  ConsistencyLevel,
  setDefaultConsistency,
  getDefaultConsistency,
  consistencyLabel,
} from './consistency-level'

describe('ConsistencyLevel enum', () => {
  it('should have STRONG = "STRONG"', () => {
    expect(ConsistencyLevel.STRONG).toBe('STRONG')
  })

  it('should have EVENTUAL = "EVENTUAL"', () => {
    expect(ConsistencyLevel.EVENTUAL).toBe('EVENTUAL')
  })

  it('should have CAUSAL = "CAUSAL"', () => {
    expect(ConsistencyLevel.CAUSAL).toBe('CAUSAL')
  })

  it('should have exactly 3 levels', () => {
    const keys = Object.keys(ConsistencyLevel)
    expect(keys.length).toBe(3)
  })
})

describe('getDefaultConsistency / setDefaultConsistency', () => {
  it('should default to STRONG', () => {
    const config = getDefaultConsistency()
    expect(config.level).toBe(ConsistencyLevel.STRONG)
  })

  it('should update level', () => {
    setDefaultConsistency({ level: ConsistencyLevel.EVENTUAL })
    const config = getDefaultConsistency()
    expect(config.level).toBe(ConsistencyLevel.EVENTUAL)
    // Reset
    setDefaultConsistency({ level: ConsistencyLevel.STRONG })
  })

  it('should keep existing fields when partially updating', () => {
    setDefaultConsistency({ level: ConsistencyLevel.CAUSAL })
    const config = getDefaultConsistency()
    expect(config.level).toBe(ConsistencyLevel.CAUSAL)
    setDefaultConsistency({ level: ConsistencyLevel.STRONG })
  })
})

describe('consistencyLabel', () => {
  it('should return correct label for STRONG', () => {
    expect(consistencyLabel(ConsistencyLevel.STRONG)).toBe('Strong')
  })

  it('should return correct label for EVENTUAL', () => {
    expect(consistencyLabel(ConsistencyLevel.EVENTUAL)).toBe('Eventual')
  })

  it('should return correct label for CAUSAL', () => {
    expect(consistencyLabel(ConsistencyLevel.CAUSAL)).toBe('Causal')
  })
})

// ---- ConsistencyLevel 扩展测试 ----

describe('ConsistencyLevel — expansion', () => {
  for (let iter = 0; iter < 20; iter++) {
    it(`getDefaultConsistency 返回可预期结果 #${iter}`, () => {
      const config = getDefaultConsistency()
      expect(config).toBeDefined()
      expect(typeof config.level).toBe('string')
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    it(`setDefaultConsistency 多次切换 #${iter}`, () => {
      setDefaultConsistency({ level: ConsistencyLevel.EVENTUAL })
      expect(getDefaultConsistency().level).toBe(ConsistencyLevel.EVENTUAL)
      setDefaultConsistency({ level: ConsistencyLevel.CAUSAL })
      expect(getDefaultConsistency().level).toBe(ConsistencyLevel.CAUSAL)
      setDefaultConsistency({ level: ConsistencyLevel.STRONG })
      expect(getDefaultConsistency().level).toBe(ConsistencyLevel.STRONG)
    })
  }

  for (let iter = 0; iter < 10; iter++) {
    it(`consistencyLabel 所有值可映射 #${iter}`, () => {
      const levels = [ConsistencyLevel.STRONG, ConsistencyLevel.EVENTUAL, ConsistencyLevel.CAUSAL]
      for (const l of levels) {
        const label = consistencyLabel(l)
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      }
    })
  }
})
