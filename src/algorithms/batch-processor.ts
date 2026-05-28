/**
 * BatchProcessor — 流式批处理辅助工具
 *
 * 提供通用的分批、批量异步处理方法，供 PageRank/BFS 等流式算法使用。
 */

export class BatchProcessor {
  /**
   * 将数组分割成固定大小的批次
   */
  splitIntoBatches<T>(items: T[], batchSize: number): T[][] {
    if (batchSize <= 0) throw new Error('batchSize must be > 0')
    const batches: T[][] = []
    for (let i = 0; i < items.length; i += batchSize) {
      batches.push(items.slice(i, i + batchSize))
    }
    return batches
  }

  /**
   * 分批异步处理数组元素，返回平铺的结果数组。
   * batchFn 接收一个批次，返回该批次的处理结果。
   */
  async processInBatches<T, R>(
    items: T[],
    batchFn: (batch: T[]) => Promise<R[]>,
    batchSize: number,
  ): Promise<R[]> {
    const batches = this.splitIntoBatches(items, batchSize)
    const results: R[] = []
    for (const batch of batches) {
      const batchResult = await batchFn(batch)
      results.push(...batchResult)
    }
    return results
  }
}
