/**
 * pagerank-worker.ts — PageRank 工作线程
 *
 * 被主线程通过 worker_threads 调用。
 * 接收节点子集和入边索引，计算该子集的 PageRank。
 *
 * 消息格式：
 *   incoming: { type: 'compute', segment: [...nodeIds], incoming: [...], 
 *               rank: { nodeId: score, ... }, n: number, dampingFactor: number,
 *               danglingRank: number, teleport: number, danglingContribution: number }
 *   outgoing: { type: 'result', rank: { nodeId: score, ... }, diff: number }
 */

import { parentPort, workerData } from 'worker_threads'

interface WorkerInput {
  segment: number[]
  rank: Record<number, number>
  outgoing: Record<number, number[]>
  outDegrees: Record<number, number>
  n: number
  dampingFactor: number
  danglingRank: number
}

if (parentPort) {
  parentPort.on('message', (msg: { type: string; [key: string]: unknown }) => {
    if (msg.type === 'compute') {
      const input = msg as unknown as WorkerInput
      const result = computeSegment(input)
      parentPort!.postMessage({ type: 'result', ...result })
    }
  })
}

function computeSegment(input: WorkerInput): { rank: Record<number, number>; diff: number } {
  const { segment, rank, outgoing, outDegrees, n, dampingFactor, danglingRank } = input
  const teleport = (1 - dampingFactor) / n
  const danglingContribution = dampingFactor * danglingRank / n
  const newRank: Record<number, number> = {}
  let diff = 0

  for (const node of segment) {
    let incomingSum = 0
    const srcList = outgoing[node]
    if (srcList) {
      for (const src of srcList) {
        incomingSum += (rank[src] || 0) / (outDegrees[src] || 1)
      }
    }
    const score = teleport + dampingFactor * incomingSum + danglingContribution
    newRank[node] = score
    diff += Math.abs(score - (rank[node] || 0))
  }

  return { rank: newRank, diff }
}
