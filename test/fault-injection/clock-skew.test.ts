/**
 * AC-FI-5: HLC 时钟偏差处理
 *
 * 测试 HLC（混合逻辑时钟）在时钟跳跃、回退、极端偏差场景下的行为：
 * 1. 向前跳跃后 wallTime 应 >= 跳跃后的值
 * 2. 向后跳跃时 wallTime 不应回退
 * 3. 极端时钟偏差不应导致崩溃
 */
import { HlcClock } from '../../src/replication/hlc-clock'

describe('AC-FI-5: HLC clock skew handling', () => {
  test('should handle forward clock jump', () => {
    const c1 = new HlcClock()
    const ts1 = c1.nowWithWallTime()

    // 模拟 clock jump forward
    const advanced = { wallTime: ts1.wallTime + 50000n, logical: 0 }
    c1.update(advanced)

    const ts2 = c1.nowWithWallTime()
    expect(ts2.wallTime).toBeGreaterThanOrEqual(ts1.wallTime + 50000n)
  })

  test('should handle backward clock jump gracefully', () => {
    const c1 = new HlcClock()

    // Set a far future timestamp first
    const ts1 = c1.nowWithWallTime()
    const future = { wallTime: ts1.wallTime + 100000n, logical: 100 }
    c1.update(future)

    // Now try to go back — clock should not regress
    const pastAttempt = { wallTime: ts1.wallTime, logical: 0 }
    c1.update(pastAttempt)

    const ts2 = c1.nowWithWallTime()
    // wallTime should still be >= future value
    expect(ts2.wallTime).toBeGreaterThanOrEqual(future.wallTime)
  })

  test('should not crash on extreme clock skew', () => {
    const c1 = new HlcClock()

    expect(() => {
      c1.update({ wallTime: BigInt(Number.MAX_SAFE_INTEGER), logical: 99999 })
    }).not.toThrow()
  })
})
