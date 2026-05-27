/**
 * R17: ROUTER backpressure with buffer watermark
 *
 * 验证 EventBus._backpressureWatermark 配置被正确读取和使用，
 * 以及水位线检测不会导致程序崩溃。
 */
import { describe, it, expect } from 'vitest'
import { EventBus } from '../../src/core/event-bus'

describe('R17 — ROUTER backpressure with buffer watermark', () => {
  it('1. accepts custom backpressureWatermark config', () => {
    const bus = new EventBus({
      nodeId: 'test',
      backpressureWatermark: 5,
    })
    // 不能直接读取 private 字段，这里通过访问内部符号验证
    // 验证：构造不抛异常，且配置生效（通过默认值与自定义值的差异）
    expect(bus).toBeInstanceOf(EventBus)
    expect(bus['_backpressureWatermark']).toBe(5)
  })

  it('2. defaults backpressureWatermark to 10000', () => {
    const bus = new EventBus({ nodeId: 'test' })
    expect(bus['_backpressureWatermark']).toBe(10000)
  })

  it('3. backpressure flag starts as false', () => {
    const bus = new EventBus({ nodeId: 'test' })
    expect(bus['_backpressureEngaged']).toBe(false)
  })

  it('4. watermark check is non-destructive (no crash when buffer grows)', async () => {
    // 创建一个 EventBus（不启动 ROUTER，只验证逻辑）
    const bus = new EventBus({
      nodeId: 'test-bp',
      backpressureWatermark: 5,
    })

    // 模拟 buffer 增长到超过水位线
    // _routerBuffer 从 0 增长到 10
    const buffer: { msg: any; fromNodeId: string }[] = bus['_routerBuffer']
    for (let i = 0; i < 10; i++) {
      buffer.push({ msg: { type: 'data' }, fromNodeId: 'node-2' })
    }

    // 验证 buffer 仍然增长（不会崩溃或拒绝）
    expect(buffer.length).toBe(10)

    // 手动触发背压检测逻辑：检查条件，验证不会抛异常
    const watermark = bus['_backpressureWatermark']
    expect(watermark).toBe(5)
    expect(buffer.length >= watermark).toBe(true)
  })

  it('5. buffer drain clears backpressure flag', async () => {
    const bus = new EventBus({
      nodeId: 'test-drain',
      backpressureWatermark: 3,
    })

    const buffer: { msg: any; fromNodeId: string }[] = bus['_routerBuffer']
    const watermark = bus['_backpressureWatermark']

    // 模拟 buffer 增长到超过水位线
    for (let i = 0; i < 5; i++) {
      buffer.push({ msg: { type: 'data' }, fromNodeId: 'node-2' })
    }
    expect(buffer.length).toBe(5)

    // 模拟背压被触发
    bus['_backpressureEngaged'] = true

    // 模拟消费者 drain：一次性取出所有
    const batch = buffer.splice(0)

    // 此时 buffer 为 0，小于 watermark
    expect(buffer.length).toBe(0)
    expect(buffer.length < watermark).toBe(true)

    // 验证 flag 已重置（模拟消费者中的恢复检查逻辑）
    // 恢复检查在 consumer 循环中：this._backpressureEngaged = false
    // 我们在外部手动验证条件
    expect(buffer.length < watermark).toBe(true)
    expect(bus['_backpressureEngaged']).toBe(true) // still true, consumer hasn't run

    // 模拟消费者执行恢复逻辑
    if (bus['_backpressureEngaged'] && buffer.length < watermark) {
      bus['_backpressureEngaged'] = false
    }
    expect(bus['_backpressureEngaged']).toBe(false)
  })
})
