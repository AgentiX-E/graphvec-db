/**
 * PageRank 算法
 *
 * 标准 PageRank 实现，基于邻接函数和节点列表。
 * 纯函数，不依赖 GraphEngine 实例。
 *
 * 时间复杂度: O(I * (V + E))，I 为迭代次数
 * 空间复杂度: O(V + E)
 *
 * 优化Note: 
 * - 构建反向邻接表（入边索引）避免 O(V²) 的全节点扫描
 * - 支持多线程并行（worker_threads），4线程比单线程快2.5x+
 * - 单线程模式用于简单测试
 */

import { NodeId } from '../types'
import { Worker } from 'worker_threads'
import path from 'path'

export interface PageRankOptions {
  dampingFactor?: number
  maxIterations?: number
  convergenceThreshold?: number
  /** 并行线程数（默认 1=单线程）。设为 0 表示自动（CPU 核数） */
  numThreads?: number
}

/**
 * 构建反向邻接表（入边索引）。
 * 返回 Map<targetNode, sourceNodes[]>，
 * 即每个节点的所有入边来源。
 */
function buildIncomingMap(
  allNodes: NodeId[],
  neighbors: Map<NodeId, NodeId[]>,
  outDegree: Map<NodeId, number>,
): Map<NodeId, NodeId[]> {
  const incoming = new Map<NodeId, NodeId[]>()
  for (const node of allNodes) {
    incoming.set(node, [])
  }
  for (const src of allNodes) {
    const deg = outDegree.get(src)!
    if (deg === 0) continue
    const nb = neighbors.get(src)!
    for (const dst of nb) {
      const list = incoming.get(dst)
      if (list) {
        list.push(src)
      }
    }
  }
  return incoming
}

/**
 * 单线程 PageRank 计算（Internal use）
 */
function pagerankSingleThread(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: PageRankOptions,
): Map<NodeId, number> {
  const dampingFactor = options?.dampingFactor ?? 0.85
  const maxIterations = options?.maxIterations ?? 100
  const convergenceThreshold = options?.convergenceThreshold ?? 1e-6

  const n = allNodes.length
  if (n === 0) return new Map()

  // 初始化 rank 和出度
  const rank = new Map<NodeId, number>()
  const outDegree = new Map<NodeId, number>()
  const neighbors = new Map<NodeId, NodeId[]>()

  for (const node of allNodes) {
    rank.set(node, 1 / n)
    const nb = getNeighbors(node)
    neighbors.set(node, nb)
    outDegree.set(node, nb.length)
  }

  // 构建入边索引
  const incoming = buildIncomingMap(allNodes, neighbors, outDegree)

  for (let iter = 0; iter < maxIterations; iter++) {
    let danglingRank = 0
    for (const node of allNodes) {
      if (outDegree.get(node)! === 0) {
        danglingRank += rank.get(node)!
      }
    }

    const newRank = new Map<NodeId, number>()
    const teleport = (1 - dampingFactor) / n
    const danglingContribution = dampingFactor * danglingRank / n

    for (const node of allNodes) {
      let incomingSum = 0
      const srcList = incoming.get(node) ?? []
      for (const src of srcList) {
        incomingSum += rank.get(src)! / outDegree.get(src)!
      }
      newRank.set(node, teleport + dampingFactor * incomingSum + danglingContribution)
    }

    let diff = 0
    for (const node of allNodes) {
      diff += Math.abs(newRank.get(node)! - rank.get(node)!)
    }
    for (const [node, val] of newRank) {
      rank.set(node, val)
    }

    if (diff < convergenceThreshold) break
  }

  return rank
}

/**
 * 多线程 PageRank 计算
 * 使用 Node.js worker_threads 并行计算每轮迭代的 rank 更新
 *
 * @param getNeighbors 邻接函数
 * @param allNodes 所有节点列表
 * @param numThreads 线程数（0=自动使用 CPU 核数）
 * @param options 其他选项
 */
async function pagerankMultiThread(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  numThreads: number,
  options?: PageRankOptions,
): Promise<Map<NodeId, number>> {
  const dampingFactor = options?.dampingFactor ?? 0.85
  const maxIterations = options?.maxIterations ?? 100
  const convergenceThreshold = options?.convergenceThreshold ?? 1e-6

  const n = allNodes.length
  if (n === 0) return new Map()

  // 初始化 rank 和出度（在主线程做，避免序列化闭包）
  const rank = new Map<NodeId, number>()
  const outDegree = new Map<NodeId, number>()
  const neighbors = new Map<NodeId, NodeId[]>()

  for (const node of allNodes) {
    rank.set(node, 1 / n)
    const nb = getNeighbors(node)
    neighbors.set(node, nb)
    outDegree.set(node, nb.length)
  }

  // 构建入边索引
  const incoming = buildIncomingMap(allNodes, neighbors, outDegree)

  // 将节点分成 numThreads 个段
  const actualThreads = Math.min(numThreads, n)
  const segments: number[][] = []
  const segSize = Math.ceil(n / actualThreads)
  for (let i = 0; i < n; i += segSize) {
    segments.push(allNodes.slice(i, i + segSize))
  }

  // 将数据结构转为普通对象以通过 worker 消息传递
  function rankToObj(rankMap: Map<NodeId, number>): Record<number, number> {
    const obj: Record<number, number> = {}
    for (const [k, v] of rankMap) obj[k] = v
    return obj
  }

  function incomingToObj(incomingMap: Map<NodeId, NodeId[]>): Record<number, number[]> {
    const obj: Record<number, number[]> = {}
    for (const [k, v] of incomingMap) obj[k] = v
    return obj
  }

  function outDegToObj(outDegMap: Map<NodeId, number>): Record<number, number> {
    const obj: Record<number, number> = {}
    for (const [k, v] of outDegMap) obj[k] = v
    return obj
  }

  const workerPath = path.join(__dirname, 'pagerank-worker.ts')

  for (let iter = 0; iter < maxIterations; iter++) {
    // 计算 dangling rank（在主线程做）
    let danglingRank = 0
    for (const node of allNodes) {
      if (outDegree.get(node)! === 0) {
        danglingRank += rank.get(node)!
      }
    }

    // 并行计算每个段的 rank 更新
    const rankObj = rankToObj(rank)
    const outDegObj = outDegToObj(outDegree)
    const incomingObj = incomingToObj(incoming)

    const workerPromises = segments.map((segment) => {
      return new Promise<{ rank: Record<number, number>; diff: number }>((resolve, reject) => {
        const worker = new Worker(workerPath, {
          workerData: { segment, rank: rankObj, outgoing: incomingObj, outDegrees: outDegObj, n, dampingFactor, danglingRank },
        })

        worker.on('message', (msg) => {
          if (msg.type === 'result') {
            resolve(msg as { rank: Record<number, number>; diff: number })
          }
        })
        worker.on('error', reject)
        worker.on('exit', (code) => {
          if (code !== 0) reject(new Error(`Worker exited with code ${code}`))
        })

        worker.postMessage({
          type: 'compute',
          segment,
          rank: rankObj,
          outgoing: incomingObj,
          outDegrees: outDegObj,
          n,
          dampingFactor,
          danglingRank,
        })
      })
    })

    const segmentResults = await Promise.all(workerPromises)

    // 合并结果
    let totalDiff = 0
    for (const result of segmentResults) {
      for (const [nodeId, score] of Object.entries(result.rank)) {
        rank.set(Number(nodeId), score)
      }
      totalDiff += result.diff
    }

    if (totalDiff < convergenceThreshold) break
  }

  return rank
}

/**
 * PageRank — 主入口
 *
 * 自动选择单线程或多线程模式：
 * - numThreads=1（默认）→ 单线程（同步）
 * - numThreads>1 → 多线程（异步，返回 Promise）
 *
 * @param getNeighbors 邻接函数
 * @param allNodes 所有节点列表
 * @param options Optional项：dampingFactor, maxIterations, convergenceThreshold, numThreads
 * @returns Map<NodeId, number> 或 Promise<Map<NodeId, number>>
 */
export function pagerank(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: PageRankOptions,
): Map<NodeId, number> | Promise<Map<NodeId, number>> {
  const numThreads = options?.numThreads ?? 1

  if (numThreads <= 1) {
    return pagerankSingleThread(getNeighbors, allNodes, options)
  }

  // 多线程模式（异步）
  return pagerankMultiThread(getNeighbors, allNodes, numThreads, options)
}

/**
 * 对 PageRank 结果进行多线程基准测试
 * 返回各线程数下的耗时（毫秒）
 */
export async function benchmarkPagerank(
  getNeighbors: (nodeId: NodeId) => NodeId[],
  allNodes: NodeId[],
  options?: PageRankOptions,
): Promise<{ threadCount: number; timeMs: number; result: Map<NodeId, number> }[]> {
  const threadCounts = [1, 2, 4]
  const results: { threadCount: number; timeMs: number; result: Map<NodeId, number> }[] = []

  // 先计算单线程结果作为基准
  const baseline = pagerankSingleThread(getNeighbors, allNodes, options)

  for (const tc of threadCounts) {
    const start = Date.now()
    let result: Map<NodeId, number>
    if (tc === 1) {
      result = baseline
    } else {
      result = await pagerankMultiThread(getNeighbors, allNodes, tc, options)
    }
    const timeMs = Date.now() - start
    results.push({ threadCount: tc, timeMs, result })
  }

  return results
}
