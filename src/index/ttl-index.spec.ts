import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest'
import { TTLIndex } from './ttl-index'

describe('TTLIndex', () => {
  let idx: TTLIndex

  beforeEach(() => {
    vi.useFakeTimers()
    idx = new TTLIndex()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  test('setTTL and tickAll returns expired nodes', () => {
    idx.setTTL(1, 10)  // 10s later
    idx.setTTL(2, 5)   // 5s later
    idx.setTTL(3, 20)  // 20s later

    expect(idx.size).toBe(3)

    // Fast forward 6s — only node 2 should expire
    vi.advanceTimersByTime(6000)
    const expired = idx.tickAll()
    expect(expired).toEqual([2])
    expect(idx.size).toBe(2)
  })

  test('multiple nodes at same TTL expire together', () => {
    idx.setTTL(1, 10)
    idx.setTTL(2, 10)
    idx.setTTL(3, 10)

    vi.advanceTimersByTime(10001)
    const expired = idx.tickAll()
    expect(expired.sort()).toEqual([1, 2, 3])
    expect(idx.size).toBe(0)
  })

  test('setExpireAt with absolute timestamp', () => {
    const future = Date.now() + 10000  // 10s from now
    idx.setExpireAt(42, future)

    // Before expiry — nothing
    expect(idx.tickAll()).toEqual([])

    // After expiry — node 42
    vi.advanceTimersByTime(10001)
    const expired = idx.tickAll()
    expect(expired).toEqual([42])
  })

  test('removeTTL cancels expiry', () => {
    idx.setTTL(1, 10)
    idx.removeTTL(1)

    vi.advanceTimersByTime(10001)
    expect(idx.tickAll()).toEqual([])
    expect(idx.hasTTL(1)).toBe(false)
  })

  test('hasTTL returns correct status', () => {
    expect(idx.hasTTL(1)).toBe(false)
    idx.setTTL(1, 10)
    expect(idx.hasTTL(1)).toBe(true)
    idx.removeTTL(1)
    expect(idx.hasTTL(1)).toBe(false)
  })

  test('getExpireAt returns correct timestamp', () => {
    expect(idx.getExpireAt(1)).toBe(-1)
    idx.setTTL(1, 60)
    const expireAt = idx.getExpireAt(1)
    expect(expireAt).toBeGreaterThan(Date.now())
    expect(expireAt).toBeLessThanOrEqual(Date.now() + 61000)
  })

  test('onExpire callback is invoked with expired node IDs', () => {
    const callback = vi.fn()
    const idxWithCB = new TTLIndex(callback)

    idxWithCB.setTTL(1, 10)
    idxWithCB.setTTL(2, 10)

    vi.advanceTimersByTime(10001)
    idxWithCB.tickAll()

    expect(callback).toHaveBeenCalledTimes(1)
    const ids = callback.mock.calls[0][0] as number[]
    expect(ids.sort()).toEqual([1, 2])
  })

  test('onExpire with immediate expiry (ttlSeconds <= 0)', () => {
    idx.setTTL(1, 0)   // 立即过期
    idx.setTTL(2, -5)  // 立即过期

    const expired = idx.tickAll()
    expect(expired.sort()).toEqual([1, 2])
  })

  test('clear resets all TTL data', () => {
    idx.setTTL(1, 10)
    idx.setTTL(2, 20)
    expect(idx.size).toBe(2)

    idx.clear()
    expect(idx.size).toBe(0)

    vi.advanceTimersByTime(20001)
    expect(idx.tickAll()).toEqual([])
  })

  test('updateTTL replaces old expiry with new', () => {
    idx.setTTL(1, 10)  // expire in 10s

    vi.advanceTimersByTime(5000)  // 5s later
    idx.setTTL(1, 20)  // reset to 20s from now
    vi.advanceTimersByTime(6000)  // total 11s — old TTL would have fired

    // Should NOT expire — TTL was updated
    expect(idx.tickAll()).toEqual([])

    vi.advanceTimersByTime(15001)  // total ~26s — new TTL expires
    expect(idx.tickAll()).toEqual([1])
  })

  test('tickAll returns only currently expired, no duplicates on re-tick', () => {
    idx.setTTL(1, 10)

    vi.advanceTimersByTime(10001)
    expect(idx.tickAll()).toEqual([1])

    // Second tick — no more expired
    expect(idx.tickAll()).toEqual([])
  })
})
