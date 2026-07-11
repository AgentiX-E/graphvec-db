/**
 * index-advisor.ts — 自动索引建议
 *
 * 从 EXPLAIN 执行计划和慢查询日志中提取列访问模式，
 * 对比现有索引，输出索引创建建议。
 *
 * 工作原理：
 * 1. 从 QueryPlan.filters 提取所有被过滤列
 * 2. 从 QueryPlan.orderBy 提取排序列
 * 3. 对比当前已存在的索引（通过 indexLister 回调）
 * 4. 生成缺失索引建议
 *
 * 用法：
 *   const advisor = new IndexAdvisor(engine)
 *   const suggestions = advisor.analyze(plan)
 */

import { QueryPlan } from '../query/query-engine'
import { ExplainFormatter } from '../query/explain'

/** 索引建议 */
export interface IndexSuggestion {
  /** 建议创建的列名（单列 or 多个列的组合索引） */
  columns: string[]
  /** 建议原因 */
  reason: string
  /** 优先级: 'critical' | 'recommended' | 'nice-to-have' */
  priority: 'critical' | 'recommended' | 'nice-to-have'
  /** 预计收益说明 */
  benefit: string
}

/** 现有列索引Info */
export interface ExistingIndex {
  name: string
  columns: string[]
  unique?: boolean
}

/** 索引列出函数签名 */
export type IndexLister = () => ExistingIndex[]

/** 索引建议器配置 */
export interface IndexAdvisorConfig {
  /**
   * 返回当前数据库中已存在的索引列表。
   * 未提供时，advisor 无法消重，所有分析结果均为建议。
   */
  indexLister?: IndexLister
  /**
   * 阈值：查询中某一列在多少次分析中出现才建议索引。
   * 默认 1（每次出现都建议）。
   */
  minOccurrences?: number
}

/**
 * IndexAdvisor — 自动索引建议
 *
 * 分析 QueryPlan 中的过滤器（WHERE）、排序（ORDER BY）、
 * 标签扫描等操作，提取被引用的属性列，
 * 对比现有索引后给出创建复合索引的建议。
 */
export class IndexAdvisor {
  private _lister: IndexLister | null
  private _minOccurrences: number
  /** 列出现频次统计（累积多组分析） */
  private _accessCount: Map<string, number> = new Map()

  constructor(config?: IndexAdvisorConfig) {
    this._lister = config?.indexLister ?? null
    this._minOccurrences = config?.minOccurrences ?? 1
  }

  /**
   * 分析一个 QueryPlan，返回索引建议。
   *
   * @param plan — 查询计划
   * @returns 索引建议列表（去重后的新建议）
   */
  analyze(plan: QueryPlan): IndexSuggestion[] {
    const accessedColumns = this._extractAccessedColumns(plan)

    // 累加访问频次
    for (const col of accessedColumns) {
      this._accessCount.set(col, (this._accessCount.get(col) ?? 0) + 1)
    }

    return this._buildSuggestions(accessedColumns, plan)
  }

  /**
   * 从多个查询计划中分析并生成最终建议。
   * 用于批量分析（如来自慢查询日志的一组查询）。
   *
   * @param plans — 多个查询计划
   * @returns 去重后的索引建议
   */
  analyzeBatch(plans: QueryPlan[]): IndexSuggestion[] {
    const allColumns = new Set<string>()

    for (const plan of plans) {
      const cols = this._extractAccessedColumns(plan)
      for (const col of cols) {
        allColumns.add(col)
        this._accessCount.set(col, (this._accessCount.get(col) ?? 0) + 1)
      }
    }

    // 对整个集合生成建议
    const suggestions: IndexSuggestion[] = []
    for (const col of allColumns) {
      const freq = this._accessCount.get(col) ?? 0
      if (freq < this._minOccurrences) continue

      if (!this._isIndexed(col)) {
        suggestions.push(this._makeColSuggestion(col))
      }
    }

    // 从高频列中寻找复合索引可能
    const highFreqCols = [...allColumns]
      .filter(col => (this._accessCount.get(col) ?? 0) >= 2)
    if (highFreqCols.length >= 2) {
      // 将高频列按频率降序排列，取前 2-3 列作为复合索引候选
      highFreqCols.sort((a, b) => (this._accessCount.get(b) ?? 0) - (this._accessCount.get(a) ?? 0))
      const composite = highFreqCols.slice(0, Math.min(3, highFreqCols.length))
      if (!this._isIndexedComposite(composite)) {
        suggestions.push({
          columns: composite,
          reason: `过滤器/排序同时高频访问列: ${composite.join(', ')}`,
          priority: 'recommended',
          benefit: `复合索引加速含 ${composite.join(', ')} 的查询`,
        })
      }
    }

    return suggestions
  }

  /**
   * 重置访问计数统计（用于开始新一轮分析）。
   */
  resetStats(): void {
    this._accessCount.clear()
  }

  /**
   * 获取当前访问频次统计。
   */
  getAccessStats(): Map<string, number> {
    return new Map(this._accessCount)
  }

  // ── 内部方法 ──

  /**
   * 从 QueryPlan 中提取所有被访问的列名。
   */
  private _extractAccessedColumns(plan: QueryPlan): string[] {
    const columns = new Set<string>()

    // 1. 从过滤器 (WHERE) 中提取列
    for (const filter of plan.filters) {
      columns.add(filter.property)
    }

    // 2. 从 ORDER BY 中提取列
    if (plan.orderBy) {
      for (const ob of plan.orderBy) {
        columns.add(ob.property)
      }
    }

    // 3. 从 scanLabel 提取（如果 scanLabel 不是 ALL 则适合建标签索引）
    // 标签扫描就是按 node type 扫描，已由 LabelEngine 处理，不额外建议

    // 4. RETURN 列的投影属性（高频返回的列可考虑覆盖索引）
    // 仅当列名在 props 中才纳入（跳过 id/name 等内置字段）
    if (plan.returnColumns) {
      for (const col of plan.returnColumns) {
        if (col !== '*' && col !== 'n' && !col.includes('.')) {
          columns.add(col)
        }
      }
    }

    // 5. 递归处理嵌套查询（CALL / EXISTS / WITH）
    if (plan.callQuery) {
      for (const c of this._extractAccessedColumns(plan.callQuery)) {
        columns.add(c)
      }
    }

    if (plan.existsFilters) {
      for (const ef of plan.existsFilters) {
        if (ef.edgeLabel) columns.add(`edge:${ef.edgeLabel}`)
      }
    }

    if (plan.with?.filters) {
      for (const f of plan.with.filters) {
        columns.add(f.property)
      }
    }

    return [...columns]
  }

  /**
   * 从单一访问列集合生成索引建议。
   */
  private _buildSuggestions(columns: string[], plan: QueryPlan): IndexSuggestion[] {
    const suggestions: IndexSuggestion[] = []

    for (const col of columns) {
      const freq = this._accessCount.get(col) ?? 1
      if (freq < this._minOccurrences) continue

      if (!this._isIndexed(col)) {
        suggestions.push(this._makeColSuggestion(col))
      }
    }

    // 检查 ORDER BY + WHERE 的复合索引可能
    if (plan.filters.length > 0 && plan.orderBy && plan.orderBy.length > 0) {
      const filterCols = plan.filters.map(f => f.property).filter(c => c)
      const orderCol = plan.orderBy[0].property
      // 如果过滤列 + 排序列 的组合未索引
      if (filterCols.length > 0 && !filterCols.includes(orderCol)) {
        const composite = [...filterCols, orderCol]
        if (!this._isIndexedComposite(composite)) {
          suggestions.push({
            columns: composite,
            reason: `WHERE 使用 ${filterCols.join(', ')} 且 ORDER BY ${orderCol}`,
            priority: 'recommended',
            benefit: `复合索引避免文件排序（Filesort），加速排序查询`,
          })
        }
      }
    }

    return suggestions
  }

  /**
   * 检查某列是否已有索引。
   */
  private _isIndexed(column: string): boolean {
    if (!this._lister) return false
    const existing = this._lister()
    return existing.some(idx => idx.columns.includes(column))
  }

  /**
   * 检查某组列是否已有复合索引覆盖。
   */
  private _isIndexedComposite(columns: string[]): boolean {
    if (!this._lister) return false
    const existing = this._lister()
    // 复合索引有最左前缀原则：只要现有索引的前缀匹配即算覆盖
    return existing.some(idx => {
      for (let i = 0; i < Math.min(columns.length, idx.columns.length); i++) {
        if (idx.columns[i] !== columns[i]) {
          // 允许现有索引比建议短（部分覆盖）
          if (i === 0) return false
          return true
        }
      }
      return idx.columns.length >= 1
    })
  }

  /**
   * 生成单列索引建议。
   */
  private _makeColSuggestion(col: string): IndexSuggestion {
    const freq = this._accessCount.get(col) ?? 1
    let priority: 'critical' | 'recommended' | 'nice-to-have'

    if (freq >= 10) {
      priority = 'critical'
    } else if (freq >= 3) {
      priority = 'recommended'
    } else {
      priority = 'nice-to-have'
    }

    return {
      columns: [col],
      reason: `过滤器/排序访问列 "${col}" (出现 ${freq} 次)`,
      priority,
      benefit: `加速 ${col} 的 WHERE 过滤和 ORDER BY 排序`,
    }
  }
}

/**
 * 从 EXPLAIN 结果中提取索引建议。
 * 便捷函数：一步执行 EXPLAIN + 分析。
 *
 * @param plan — 查询计划
 * @param lister — 现有索引列表函数（Optional）
 * @returns 索引建议列表
 */
export function suggestIndexes(plan: QueryPlan, lister?: IndexLister): IndexSuggestion[] {
  const advisor = new IndexAdvisor({ indexLister: lister })
  return advisor.analyze(plan)
}

/**
 * 从慢查询日志中提取索引建议。
 * 分析一组慢查询计划，生成去重后的索引建议。
 *
 * @param plans — 慢查询的查询计划列表
 * @param lister — 现有索引列表函数（Optional）
 * @returns 索引建议列表
 */
export function suggestIndexesFromSlowLog(plans: QueryPlan[], lister?: IndexLister): IndexSuggestion[] {
  const advisor = new IndexAdvisor({ indexLister: lister })
  return advisor.analyzeBatch(plans)
}
