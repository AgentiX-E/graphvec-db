/**
 * FullTextIndex 基准测试
 *
 * 测试添加文档、单词搜索、多词搜索、中文搜索的性能。
 * 运行方式：npx ts-node bench/fulltext.bench.ts
 */
import { FullTextIndex } from '../src/search/fulltext'

const DOC_COUNT = 1000
const SEARCH_ITERATIONS = 100

/** 生成测试文档 */
function generateDocs(count: number): Array<{ id: string; fields: Record<string, string | string[]> }> {
  const docs: Array<{ id: string; fields: Record<string, string | string[]> }> = []
  const subjects = [
    'machine learning', 'deep learning', 'natural language processing',
    'computer vision', 'reinforcement learning', 'data mining',
    'neural networks', 'transformer architecture', 'graph neural network',
    'large language model',
  ]
  const topics = [
    'classification', 'regression', 'clustering', 'dimensionality reduction',
    'sequence modeling', 'attention mechanism', 'embedding', 'optimization',
    'regularization', 'transfer learning',
  ]
  const frameworks = [
    'TensorFlow', 'PyTorch', 'JAX', 'Keras', 'scikit-learn',
    'Hugging Face', 'LangChain', 'LlamaIndex', 'ONNX', 'MLflow',
  ]

  for (let i = 0; i < count; i++) {
    const s = subjects[i % subjects.length]
    const t = topics[(i * 3) % topics.length]
    const f = frameworks[(i * 7) % frameworks.length]
    docs.push({
      id: `doc-${i}`,
      fields: {
        title: `${s} with ${f}: ${t}`,
        content: [
          `This document covers ${s} techniques applied to ${t} problems.`,
          `We use ${f} as our primary framework for implementation.`,
          `Key contributions include novel approaches to ${t} in the context of ${s}.`,
          `Experimental results demonstrate state-of-the-art performance.`,
        ].join(' '),
        category: t,
      },
    })
  }
  return docs
}

/** 生成中文测试文档 */
function generateChineseDocs(count: number): Array<{ id: string; fields: Record<string, string | string[]> }> {
  const docs: Array<{ id: string; fields: Record<string, string | string[]> }> = []
  const titles = [
    '机器学习在自然语言处理中的应用',
    '深度学习与计算机视觉前沿技术',
    '强化学习在推荐系统中的应用',
    '大规模语言模型的训练与优化',
    '图神经网络在知识图谱中的应用',
    '迁移学习在医疗影像中的实践',
    '注意力机制在文本分类中的效果',
    '向量数据库在AI应用中的核心作用',
  ]
  const contents = [
    '本文系统地介绍了机器学习在自然语言处理中的关键应用，包括文本分类、情感分析和机器翻译等场景。',
    '深度学习在计算机视觉领域取得了突破性进展，特别是在目标检测和图像分割方面。',
    '强化学习通过与环境互动学习最优策略，在推荐系统和游戏AI中表现优异。',
    '大规模语言模型如GPT和BERT在多个NLP任务上达到了新的性能水平。',
    '图神经网络能够有效处理图结构数据，在知识图谱推理和社会网络分析中应用广泛。',
  ]

  for (let i = 0; i < count; i++) {
    docs.push({
      id: `zh-doc-${i}`,
      fields: {
        title: titles[i % titles.length],
        content: contents[(i * 2 + i) % contents.length],
        category: '中文文档',
      },
    })
  }
  return docs
}

function p50(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.5)]
}

function p95(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

function p99(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.99)]
}

async function main() {
  console.log('=== FullTextIndex Benchmarks ===\n')

  // ──────────────────────────────────────
  // 1. 添加文档
  // ──────────────────────────────────────
  console.log('--- 1. Add Documents ---')
  const index = new FullTextIndex({ analyzer: 'cjk' })
  const docs = generateDocs(DOC_COUNT)
  const zhDocs = generateChineseDocs(500)

  const addStart = Date.now()
  for (const doc of docs) {
    index.addDocument(doc.id, doc.fields)
  }
  for (const doc of zhDocs) {
    index.addDocument(doc.id, doc.fields)
  }
  const addMs = Date.now() - addStart
  const totalDocs = DOC_COUNT + 500
  console.log(`Added ${totalDocs} docs: ${addMs}ms (${Math.round(totalDocs / (addMs / 1000))} docs/s)`)
  console.log(`Index stats: ${JSON.stringify(index.stats())}\n`)

  // ──────────────────────────────────────
  // 2. 单术语搜索
  // ──────────────────────────────────────
  console.log('--- 2. Single Term Search ---')
  const singleTerms = ['learning', 'network', 'transformer', 'classification', 'attention']
  for (const term of singleTerms) {
    const latencies: number[] = []

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      const start = performance.now()
      index.search(term, { limit: 10, mode: 'or' })
      const elapsed = performance.now() - start
      latencies.push(elapsed)
    }

    latencies.sort((a, b) => a - b)
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length
    const p50v = p50(latencies)
    const p95v = p95(latencies)
    const p99v = p99(latencies)
    const results = index.search(term, { limit: 10, mode: 'or' })
    console.log(
      `  "${term}": ${results.length} results — ` +
      `avg=${avg.toFixed(3)}ms p50=${p50v.toFixed(3)}ms p95=${p95v.toFixed(3)}ms p99=${p99v.toFixed(3)}ms`
    )
  }

  // ──────────────────────────────────────
  // 3. 多术语搜索
  // ──────────────────────────────────────
  console.log('\n--- 3. Multi-Term Search ---')
  const multiQueries = [
    'machine learning classification',
    'deep neural network',
    'transformer attention mechanism',
    'natural language processing',
    'reinforcement learning optimization',
  ]
  for (const query of multiQueries) {
    const latencies: number[] = []

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      const start = performance.now()
      index.search(query, { limit: 10, mode: 'or' })
      const elapsed = performance.now() - start
      latencies.push(elapsed)
    }

    latencies.sort((a, b) => a - b)
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length
    const p50v = p50(latencies)
    const p95v = p95(latencies)
    const p99v = p99(latencies)
    const results = index.search(query, { limit: 10, mode: 'or' })
    console.log(
      `  "${query}": ${results.length} results — ` +
      `avg=${avg.toFixed(3)}ms p50=${p50v.toFixed(3)}ms p95=${p95v.toFixed(3)}ms p99=${p99v.toFixed(3)}ms`
    )
  }

  // ──────────────────────────────────────
  // 4. 中文搜索 (CJK analyzer)
  // ──────────────────────────────────────
  console.log('\n--- 4. Chinese Text Search ---')
  const chineseQueries = ['机器学习', '深度学习', '图神经网络', '自然语言', '强化学习']
  for (const query of chineseQueries) {
    const latencies: number[] = []

    for (let i = 0; i < SEARCH_ITERATIONS; i++) {
      const start = performance.now()
      index.search(query, { limit: 10, mode: 'or' })
      const elapsed = performance.now() - start
      latencies.push(elapsed)
    }

    latencies.sort((a, b) => a - b)
    const avg = latencies.reduce((s, v) => s + v, 0) / latencies.length
    const p50v = p50(latencies)
    const p95v = p95(latencies)
    const p99v = p99(latencies)
    const results = index.search(query, { limit: 10, mode: 'or' })
    console.log(
      `  "${query}": ${results.length} results — ` +
      `avg=${avg.toFixed(3)}ms p50=${p50v.toFixed(3)}ms p95=${p95v.toFixed(3)}ms p99=${p99v.toFixed(3)}ms`
    )
  }

  // ──────────────────────────────────────
  // 5. AND mode search
  // ──────────────────────────────────────
  console.log('\n--- 5. AND Mode Multi-Term Search ---')
  const andQueries = [
    'learning network',
    'deep learning',
    'transformer attention',
  ]
  for (const query of andQueries) {
    const start = performance.now()
    const results = index.search(query, { limit: 10, mode: 'and' })
    const elapsed = performance.now() - start
    console.log(`  "${query}" (AND): ${results.length} results — ${elapsed.toFixed(3)}ms`)
  }

  console.log('\n--- Benchmark Complete ---')
}

main().catch(console.error)
