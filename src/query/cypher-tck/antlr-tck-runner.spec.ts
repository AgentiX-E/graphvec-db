/**
 * antlr-tck-runner.spec.ts — 使用 ANTLR parser 运行全部 TCK
 *
 * 通过 vitest 的 vi.mock 在模块加载前替换 parseQuery。
 * 然后导入并运行全部 TCK 测试。注意避免循环引用：
 * ast-to-plan-v2 不导入 query-engine，所以 mock 安全。
 */
import { vi } from 'vitest'

// 必须在 import 前 mock - 使用工厂函数避免循环依赖
vi.mock('../query-engine.js', async (importOriginal) => {
  // 获取原始模块
  const actual = await importOriginal() as any
  // 动态导入 ANTLR parser（注意：不使用在顶层，因为此时 mock 尚未就绪）
  const { parseCypherToPlan } = await import('../ast-to-plan-v2')
  return { ...actual, parseQuery: (q: string) => parseCypherToPlan(q) }
})

// TCK 测试
import './openCypher-tck.spec'
