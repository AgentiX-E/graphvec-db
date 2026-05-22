import { UpsertNodeOptions, OverGraphConfig } from '../../src/types'

/** 测试用的 OverGraph 配置 */
export const testEngineConfig: OverGraphConfig = {
  path: './test-data/test-graph',
  denseVector: { dimension: 384 },
}

/** 创建一个测试节点 */
export function makeTestNode(name: string, opts?: Partial<UpsertNodeOptions>) {
  return {
    typeId: 1,
    name,
    opts: {
      props: { name: `Test-${name}`, created: Date.now() },
      ...opts,
    },
  }
}

/** 创建一批测试节点的输入 */
export function makeTestBatch(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    typeId: 1,
    name: `batch-node-${i}`,
    opts: {
      props: { index: i, group: 'test-batch' },
    } as UpsertNodeOptions,
  }))
}

/** 清理测试数据目录 */
export function cleanTestData(dir: string = './test-data'): void {
  try {
    const fs = require('fs')
    if (fs.existsSync(dir)) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  } catch {
    // ignore
  }
}
