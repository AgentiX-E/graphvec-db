#!/usr/bin/env node
/**
 * event-bus.curvespec.mjs — EventBus CURVE 集成测试
 *
 * 不经过 Jest，直接用 Node ESM 执行。
 * 用法：node src/core/event-bus.curvespec.mjs
 */

import { EventBus } from '../../src/core/event-bus.ts'

process.stderr.write('=== EventBus CURVE 集成测试 ===\n')

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

async function main() {
  const zmq = await import('zeromq')
  const keyA = zmq.curveKeyPair()
  const keyB = zmq.curveKeyPair()

  process.stderr.write(`keyA pub: ${keyA.publicKey.slice(0,8)}...\n`)
  process.stderr.write(`keyB pub: ${keyB.publicKey.slice(0,8)}...\n`)

  const curveA = {
    mode: 'explicit',
    server: true,
    publicKey: keyA.publicKey,
    secretKey: keyA.secretKey,
    peerKeys: { 'tcp://127.0.0.1:5565': keyB.publicKey },
  }

  const curveB = {
    mode: 'explicit',
    server: true,
    publicKey: keyB.publicKey,
    secretKey: keyB.secretKey,
    peerKeys: { 'tcp://127.0.0.1:5564': keyA.publicKey },
  }

  const busA = new EventBus({
    nodeId: 'node-A',
    publishAddress: 'tcp://127.0.0.1:5564',
    subscribeAddresses: ['tcp://127.0.0.1:5565'],
    security: { curve: curveA },
  })

  const busB = new EventBus({
    nodeId: 'node-B',
    publishAddress: 'tcp://127.0.0.1:5565',
    subscribeAddresses: ['tcp://127.0.0.1:5564'],
    security: { curve: curveB },
  })

  process.stderr.write('Starting buses...\n')
  await busA.start()
  await busB.start()
  await sleep(2000)

  const receivedOnB = []
  const receivedOnA = []

  busB.on('node:created', (evt) => {
    receivedOnB.push(evt.data.id)
    process.stderr.write(`B received: ${evt.data.id}\n`)
  })

  busA.on('edge:created', (evt) => {
    receivedOnA.push(evt.data.id)
    process.stderr.write(`A received: ${evt.data.id}\n`)
  })

  // A → B
  process.stderr.write('A sending node:created...\n')
  busA.emit({ type: 'node:created', timestamp: Date.now(), data: { id: 'n1' } })
  await sleep(1000)

  // B → A
  process.stderr.write('B sending edge:created...\n')
  busB.emit({ type: 'edge:created', timestamp: Date.now(), data: { id: 'e1' } })
  await sleep(1000)

  process.stderr.write(`\nResults:\n`)
  process.stderr.write(`B received: ${receivedOnB.length} messages (expect 1)\n`)
  process.stderr.write(`A received: ${receivedOnA.length} messages (expect 1)\n`)

  const ok = receivedOnB.includes('n1') && receivedOnA.includes('e1')
  process.stderr.write(ok ? '\n✅ CURVE PUB/SUB 双向通信成功\n' : '\n❌ FAILED\n')

  await busA.stop()
  await busB.stop()

  process.exit(ok ? 0 : 1)
}

main().catch(err => {
  process.stderr.write(`Error: ${err.stack}\n`)
  process.exit(1)
})
