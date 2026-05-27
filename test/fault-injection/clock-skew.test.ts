/**
 * AC-FI-5: HLC 时钟偏差处理
 *
 * 测试 HLC（混合逻辑时钟）在时钟跳跃、回退、极端偏差场景下的行为：
 * 1. 时钟向前跳跃后 HLC 时钟正确跟随，不丢失单调递增性
 * 2. 时钟向后回退时 wallTime 不回退，保持上一个已知最高值
 * 3. 跨节点时钟差超过阈值时 update() 正确同步，不崩溃
 * 4. 连续高频率更新下逻辑计数正确兜底
 */
import { HlcClock } from '../../src/replication/hlc-clock'

describe('AC-FI-5: HLC clock skew handling', () => {
  /**
   * 1. 时钟向前跳跃后 HLC 时钟的恢复行为
   *
   * 场景：本地时钟从 ts1 突然跳到 ts1+50000ms，
   * HLC 收到远高于当前 wallTime 的 remote update 后，
   * 下次 now() 应返回 >= 该未来值。
   */
  test('should advance wallTime after forward clock jump via update', () => {
    const clock = new HlcClock()
    const ts1 = clock.nowWithWallTime()

    // 模拟另一个节点（更快的时钟）推送过来的时间戳
    const fastRemote = { wallTime: ts1.wallTime + 50000n, logical: 42 }
    clock.update(fastRemote)

    const ts2 = clock.nowWithWallTime()
    // wallTime 必须 >= 远程提供的未来值
    expect(ts2.wallTime).toBeGreaterThanOrEqual(fastRemote.wallTime)
    // logical 序必须 >= 远程 logical + 1
    expect(ts2.logical).toBeGreaterThanOrEqual(fastRemote.logical + 1)
  })

  /**
   * 2. 时钟向后回退时的容错
   *
   * 场景：HLC 已经通过 remote update 推进到未来 wallTime，
   * 此时收到一个过去的 remote timestamp。
   * HLC 不能把自己的 wallTime 回退回去，要保持单调递增。
   */
  test('should not regress wallTime on backward clock jump', () => {
    const clock = new HlcClock()
    const ts1 = clock.nowWithWallTime()

    // 先向前推进
    const future = { wallTime: ts1.wallTime + 100000n, logical: 100 }
    clock.update(future)

    // 再尝试回退到更早的时间
    const pastAttempt = { wallTime: ts1.wallTime, logical: 0 }
    clock.update(pastAttempt)

    const ts2 = clock.nowWithWallTime()
    // wallTime 不应回退
    expect(ts2.wallTime).toBeGreaterThanOrEqual(future.wallTime)
    // logical 至少应 >= 100 + 1
    expect(ts2.logical).toBeGreaterThanOrEqual(101)
  })

  /**
   * 3. 跨节点时钟差超过阈值时的一致性保护
   *
   * 场景：两个节点独立生成时间戳，节点 A 时钟正常，节点 B 快了很多。
   * A 收到 B 的时间戳后应该同步到 B 的 wallTime。
   * 同时，A 本地的 now() 不会因为 B 的极端值而崩溃。
   */
  test('should sync across nodes with extreme clock skew without crash', () => {
    const clockA = new HlcClock()
    const clockB = new HlcClock()

    // clockB 模拟一个时间快进很多的节点
    const tsB = clockB.nowWithWallTime()
    const veryFastB = { wallTime: tsB.wallTime + 3600000n, logical: 500 } // 快1小时
    clockB.update(veryFastB) // B 本地已推进

    // A 收到 B 的时间戳
    clockA.update(veryFastB)

    // A 的 now() 应该推进到接近 B 的 wallTime
    const tsA = clockA.nowWithWallTime()
    expect(tsA.wallTime).toBeGreaterThanOrEqual(veryFastB.wallTime)
    // B 本地时间戳也应该正常
    const tsB2 = clockB.nowWithWallTime()
    expect(tsB2.wallTime).toBeGreaterThanOrEqual(veryFastB.wallTime)
    // 均不崩溃
  })

  /**
   * 4. 连续高频调用下 logical 不溢出
   *
   * 场景：在 wallTime 不变的情况下连续调用 now()，
   * logical 应单调递增，且不抛出异常。
   */
  test('should increment logical counter monotonically under rapid successive calls', () => {
    const clock = new HlcClock()
    const timestamps: number[] = []

    // 连续高频生成 100 个时间戳
    for (let i = 0; i < 100; i++) {
      const ts = clock.nowWithWallTime()
      timestamps.push(ts.logical)
    }

    // logical 必须单调非递减（HLC 在 wall time 跃迁时会重置 logical=0）
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i]).toBeGreaterThanOrEqual(timestamps[i - 1])
    }
  })

  /**
   * 5. 二进制编解码 remote update 不崩溃
   *
   * 场景：使用 Uint8Array 格式的 remote timestamp 调用 update，
   * 确保编解码路径在故障注入下不崩溃。
   */
  test('should handle binary-encoded remote timestamp via update without crash', () => {
    const clock = new HlcClock()
    const ts = clock.nowWithWallTime()
    const bytes = ts.toBytes()

    // 用二进制数据更新另一个 clock 实例
    const clock2 = new HlcClock()

    // 对这个新实例先推进一个更高值
    clock2.update({ wallTime: ts.wallTime + 2000n, logical: 5 })

    // 用二进制再更新
    expect(() => {
      clock2.update(bytes)
    }).not.toThrow()

    // 确保更新后时间推进
    const ts2 = clock2.nowWithWallTime()
    expect(ts2.wallTime).toBeGreaterThanOrEqual(ts.wallTime + 2000n)
  })
})
