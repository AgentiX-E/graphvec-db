/**
 * 图可视化输出工具
 *
 * 支持两种格式：
 *   - GraphVizFormatter → DOT 格式 (.dot)
 *   - CytoscapeFormatter → Cytoscape.js JSON 格式 (.json)
 *
 * 支持有向/无向图、节点标签和属性、边权重和标签。
 */

import { NodeId } from '../types'

// ──────────────────────────────────────────
// Types
// ──────────────────────────────────────────

export interface VizNode {
  id: NodeId
  label?: string
  props?: Record<string, string | number | boolean>
}

export interface VizEdge {
  src: NodeId
  dst: NodeId
  weight?: number
  label?: string
  props?: Record<string, string | number | boolean>
}

export interface VizGraph {
  directed: boolean
  nodes: VizNode[]
  edges: VizEdge[]
  graphName?: string
  graphProps?: Record<string, string | number | boolean>
}

export interface CytoscapeElement {
  group: 'nodes' | 'edges'
  data: {
    id?: string
    source?: string
    target?: string
    label?: string
    weight?: number
    [key: string]: string | number | boolean | undefined
  }
}

// ──────────────────────────────────────────
// GraphViz (DOT) Formatter
// ──────────────────────────────────────────

export class GraphVizFormatter {
  /**
   * 将图格式化为 DOT 字符串
   *
   * @param graph - 图数据
   * @returns DOT 格式字符串
   */
  public format(graph: VizGraph): string {
    const lines: string[] = []

    // Header
    const graphType = graph.directed ? 'digraph' : 'graph'
    const name = graph.graphName ?? 'G'
    lines.push(`${graphType} ${name} {`)

    // Graph properties
    if (graph.graphProps) {
      for (const [key, val] of Object.entries(graph.graphProps)) {
        lines.push(`  ${key}=${_quoteProp(val)};`)
      }
    }

    // Defaults
    lines.push(`  rankdir=LR;`)
    lines.push(`  node [shape=ellipse, style=filled, fillcolor=lightgray];`)

    // Nodes
    for (const node of graph.nodes) {
      const attrs: string[] = []
      if (node.label) {
        attrs.push(`label="${_escapeDOT(node.label)}"`)
      } else {
        attrs.push(`label="${node.id}"`)
      }

      // Additional attributes from props
      if (node.props) {
        for (const [key, val] of Object.entries(node.props)) {
          attrs.push(`${key}=${_quoteProp(val)}`)
        }
      }

      const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : ''
      lines.push(`  ${node.id}${attrStr};`)
    }

    // Edges
    const edgeOp = graph.directed ? ' -> ' : ' -- '
    for (const edge of graph.edges) {
      const attrs: string[] = []

      if (edge.weight !== undefined) {
        attrs.push(`weight=${edge.weight}`)
      }
      if (edge.label) {
        attrs.push(`label="${_escapeDOT(edge.label)}"`)
      }

      // Additional edge properties
      if (edge.props) {
        for (const [key, val] of Object.entries(edge.props)) {
          attrs.push(`${key}=${_quoteProp(val)}`)
        }
      }

      const attrStr = attrs.length > 0 ? ` [${attrs.join(', ')}]` : ''
      lines.push(`  ${edge.src}${edgeOp}${edge.dst}${attrStr};`)
    }

    lines.push('}')
    return lines.join('\n')
  }

  /**
   * 从邻接表快速生成 DOT 格式
   *
   * @param getNeighbors - 邻居查询函数
   * @param vertices - 节点列表
   * @param directed - 是否有向
   * @returns DOT 格式字符串
   */
  public formatFromAdjacency(
    getNeighbors: (nodeId: NodeId) => NodeId[],
    vertices: NodeId[],
    directed?: boolean,
  ): string {
    const nodeSet = new Set(vertices)
    const nodes: VizNode[] = vertices.map((id) => ({ id }))
    const edges: VizEdge[] = []

    for (const src of vertices) {
      for (const dst of getNeighbors(src)) {
        if (nodeSet.has(dst)) {
          if (!directed && src >= dst) continue
          edges.push({ src, dst })
        }
      }
    }

    return this.format({ directed: directed ?? false, nodes, edges })
  }
}

// ──────────────────────────────────────────
// Cytoscape.js JSON Formatter
// ──────────────────────────────────────────

export class CytoscapeFormatter {
  /**
   * 将图转换为 Cytoscape.js JSON 格式
   *
   * Cytoscape.js 使用 `elements` 数组，
   * 每个元素有 `group` (nodes/edges) 和 `data` (属性)。
   *
   * @param graph - 图数据
   * @returns Cytoscape.js 元素数组
   */
  public format(graph: VizGraph): CytoscapeElement[] {
    const elements: CytoscapeElement[] = []

    // Nodes
    for (const node of graph.nodes) {
      const data: CytoscapeElement['data'] = {
        id: String(node.id),
        label: node.label ?? String(node.id),
      }

      if (node.props) {
        for (const [key, val] of Object.entries(node.props)) {
          data[key] = val
        }
      }

      elements.push({ group: 'nodes', data })
    }

    // Edges
    for (const edge of graph.edges) {
      const data: CytoscapeElement['data'] = {
        id: `${edge.src}->${edge.dst}`,
        source: String(edge.src),
        target: String(edge.dst),
        label: edge.label ?? '',
      }

      if (edge.weight !== undefined) {
        data.weight = edge.weight
      }

      if (edge.props) {
        for (const [key, val] of Object.entries(edge.props)) {
          data[key] = val
        }
      }

      elements.push({ group: 'edges', data })
    }

    return elements
  }

  /**
   * 从邻接表快速生成 Cytoscape.js JSON
   *
   * @param getNeighbors - 邻居查询函数
   * @param vertices - 节点列表
   * @param directed - 是否有向
   * @returns Cytoscape.js 元素数组
   */
  public formatFromAdjacency(
    getNeighbors: (nodeId: NodeId) => NodeId[],
    vertices: NodeId[],
    directed?: boolean,
  ): CytoscapeElement[] {
    const nodeSet = new Set(vertices)
    const nodes: VizNode[] = vertices.map((id) => ({ id }))
    const edges: VizEdge[] = []

    for (const src of vertices) {
      for (const dst of getNeighbors(src)) {
        if (nodeSet.has(dst)) {
          if (!directed && src >= dst) continue
          edges.push({ src, dst })
        }
      }
    }

    return this.format({ directed: directed ?? false, nodes, edges })
  }
}

// ──────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────

function _escapeDOT(str: string): string {
  return str.replace(/"/g, '\\"').replace(/\n/g, '\\n')
}

function _quoteProp(val: string | number | boolean): string {
  if (typeof val === 'string') {
    return `"${_escapeDOT(val)}"`
  }
  return String(val)
}
