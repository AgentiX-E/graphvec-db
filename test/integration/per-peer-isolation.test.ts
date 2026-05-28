/**
 * AC-IT-R6: Per-Peer ZMQ 隔离性测试
 *
 * 基于真实 ZMQ ROUTER/DEALER 验证：
 * 1. 多 DEALER 并发通信
 * 2. 一个 DEALER 关闭不影响其他
 * 3. DEALER 重连后仍可通信
 *
 * 注意：ZMQ Router receive 返回 [identity, payload]（2 frames）
 * 没有中间的空 delimiter。
 */

import { describe, it, expect } from 'vitest'
import * as zmq from 'zeromq'

describe('AC-IT-R6: Per-Peer ZMQ Isolation', () => {

  it('1. 多 DEALER 并发通信', async () => {
    const router = new zmq.Router()
    await router.bind('tcp://127.0.0.1:0')
    const port = router.lastEndpoint!.split(':').pop()!

    const d1 = new zmq.Dealer()
    const d2 = new zmq.Dealer()
    await d1.connect(`tcp://127.0.0.1:${port}`)
    await d2.connect(`tcp://127.0.0.1:${port}`)

    await new Promise(r => setTimeout(r, 50))
    await d1.send('m1')
    await d2.send('m2')

    // Router receive: [identity, payload]
    const [, p1] = await router.receive()
    const [, p2] = await router.receive()
    expect(Buffer.from(p1).toString()).toBe('m1')
    expect(Buffer.from(p2).toString()).toBe('m2')

    d1.close()
    d2.close()
    router.close()
  })

  it('2. DEALER 关闭后另一个正常', async () => {
    const router = new zmq.Router()
    await router.bind('tcp://127.0.0.1:0')
    const port = router.lastEndpoint!.split(':').pop()!

    const d1 = new zmq.Dealer()
    const d2 = new zmq.Dealer()
    await d1.connect(`tcp://127.0.0.1:${port}`)
    await d2.connect(`tcp://127.0.0.1:${port}`)
    await new Promise(r => setTimeout(r, 50))

    // 关闭 d1
    d1.close()
    await new Promise(r => setTimeout(r, 100))

    // d2 仍正常
    await d2.send('d2-alone')
    const [, p] = await router.receive()
    expect(Buffer.from(p).toString()).toBe('d2-alone')

    d2.close()
    router.close()
  })

  it('3. DEALER 重连后通信', async () => {
    const router = new zmq.Router()
    await router.bind('tcp://127.0.0.1:0')
    const port = router.lastEndpoint!.split(':').pop()!

    const d1 = new zmq.Dealer()
    await d1.connect(`tcp://127.0.0.1:${port}`)
    await new Promise(r => setTimeout(r, 50))

    // 关闭
    d1.close()
    await new Promise(r => setTimeout(r, 100))

    // 新 dealer 连接
    const d1New = new zmq.Dealer()
    await d1New.connect(`tcp://127.0.0.1:${port}`)
    await new Promise(r => setTimeout(r, 100))

    await d1New.send('reborn')
    const [, p] = await router.receive()
    expect(Buffer.from(p).toString()).toBe('reborn')

    d1New.close()
    router.close()
  })
})
