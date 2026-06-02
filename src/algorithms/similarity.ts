/**
 * similarity.ts — 图算法相似度与链路预测
 *
 * 提供：
 * - JaccardSimilarity / CosineSimilarity（节点间相似度）
 * - AdamicAdar / PreferentialAttachment / ResourceAllocation（链路预测分数）
 */

/**
 * Jaccard 相似度 — 基于共同邻居的比例
 */
export function jaccardSimilarity(neighborsA: Set<number>, neighborsB: Set<number>): number {
  const union = new Set([...neighborsA, ...neighborsB])
  if (union.size === 0) return 0
  let intersection = 0
  for (const v of neighborsA) if (neighborsB.has(v)) intersection++
  return intersection / union.size
}

/**
 * Cosine 相似度 — 基于属性向量夹角
 */
export function cosineSimilarity(vectorA: number[], vectorB: number[]): number {
  if (vectorA.length !== vectorB.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < vectorA.length; i++) {
    dot += vectorA[i] * vectorB[i]
    normA += vectorA[i] * vectorA[i]
    normB += vectorB[i] * vectorB[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

/**
 * Adamic-Adar 链路预测 — 公共邻居的对数倒数权重和
 */
export function adamicAdar(
  neighborsA: Set<number>,
  neighborsB: Set<number>,
  getDegree: (id: number) => number,
): number {
  let score = 0
  for (const v of neighborsA) {
    if (neighborsB.has(v)) {
      score += 1 / Math.log(getDegree(v) + 1)
    }
  }
  return score
}

/**
 * Preferential Attachment — 度乘积
 */
export function preferentialAttachment(degreeA: number, degreeB: number): number {
  return degreeA * degreeB
}

/**
 * Resource Allocation — 公共邻居的度倒数权重和
 */
export function resourceAllocation(
  neighborsA: Set<number>,
  neighborsB: Set<number>,
  getDegree: (id: number) => number,
): number {
  let score = 0
  for (const v of neighborsA) {
    if (neighborsB.has(v)) {
      score += 1 / (getDegree(v) || 1)
    }
  }
  return score
}
