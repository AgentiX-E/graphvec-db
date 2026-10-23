/**
 * 图可视化输出单元测试
 */

import { describe, test, expect } from 'vitest'
import { GraphVizFormatter, CytoscapeFormatter, VizGraph } from './graph-viz'

describe('GraphVizFormatter - DOT format', () => {
  const formatter = new GraphVizFormatter()

  test('formats undirected graph', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }],
      edges: [{ src: 1, dst: 2 }, { src: 2, dst: 3 }],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('graph G {')
    expect(dot).toContain('1 -- 2')
    expect(dot).toContain('2 -- 3')
    expect(dot).toContain('label="A"')
    expect(dot).toContain('label="B"')
    expect(dot).toContain('}')
  })

  test('formats directed graph', () => {
    const graph: VizGraph = {
      directed: true,
      nodes: [{ id: 0 }, { id: 1 }],
      edges: [{ src: 0, dst: 1, weight: 1.5 }],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('digraph G {')
    expect(dot).toContain('0 -> 1')
    expect(dot).toContain('weight=1.5')
  })

  test('includes custom graph name', () => {
    const graph: VizGraph = {
      directed: false,
      graphName: 'myGraph',
      nodes: [{ id: 1 }],
      edges: [],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('graph myGraph {')
  })

  test('includes edge label', () => {
    const graph: VizGraph = {
      directed: true,
      nodes: [{ id: 1 }, { id: 2 }],
      edges: [{ src: 1, dst: 2, label: 'knows' }],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('label="knows"')
  })

  test('includes node properties', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [{ id: 1, label: 'Server', props: { fillcolor: 'red', shape: 'box' } }],
      edges: [],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('fillcolor="red"')
    expect(dot).toContain('shape="box"')
  })

  test('escapes special characters in labels', () => {
    // An edge must reference an existing node, so both endpoints are declared.
    const fixedGraph: VizGraph = {
      directed: false,
      nodes: [
        { id: 1, label: 'Node "A"' },
        { id: 2, label: 'Node B' },
      ],
      edges: [{ src: 1, dst: 2, label: 'edge "AB"' }],
    }

    const dot = formatter.format(fixedGraph)
    expect(dot).toContain('Node \\"A\\"')
    expect(dot).toContain('edge \\"AB\\"')
  })

  test('empty graph produces valid DOT', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [],
      edges: [],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('graph G {')
    expect(dot).toContain('}')
  })

  test('formatFromAdjacency produces correct DOT', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
    }

    const dot = formatter.formatFromAdjacency(
      (n) => neighbors[n] ?? [],
      [0, 1, 2],
      false,
    )

    expect(dot).toContain('0 -- 1')
    expect(dot).toContain('0 -- 2')
    expect(dot).not.toContain('1 -- 0') // No duplicate edges
  })

  test('directed adjacency format', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [],
      2: [],
    }

    const dot = formatter.formatFromAdjacency(
      (n) => neighbors[n] ?? [],
      [0, 1, 2],
      true,
    )

    expect(dot).toContain('0 -> 1')
    expect(dot).toContain('0 -> 2')
  })

  test('includes graph-level properties', () => {
    const graph: VizGraph = {
      directed: true,
      graphName: 'M',
      graphProps: { label: 'My Graph', fontsize: 12 },
      nodes: [{ id: 1 }],
      edges: [],
    }

    const dot = formatter.format(graph)
    expect(dot).toContain('label="My Graph"')
    expect(dot).toContain('fontsize=12')
  })
})

describe('CytoscapeFormatter - JSON format', () => {
  const formatter = new CytoscapeFormatter()

  test('formats nodes', () => {
    const graph: VizGraph = {
      directed: true,
      nodes: [{ id: 1, label: 'A' }, { id: 2, label: 'B' }],
      edges: [],
    }

    const elements = formatter.format(graph)
    expect(elements).toHaveLength(2)

    const node0 = elements[0]
    expect(node0.group).toBe('nodes')
    expect(node0.data.id).toBe('1')
    expect(node0.data.label).toBe('A')
  })

  test('formats edges with weight', () => {
    const graph: VizGraph = {
      directed: true,
      nodes: [{ id: 1 }, { id: 2 }],
      edges: [{ src: 1, dst: 2, weight: 3.5, label: 'path' }],
    }

    const elements = formatter.format(graph)
    expect(elements).toHaveLength(3) // 2 nodes + 1 edge

    const edge = elements[2]
    expect(edge.group).toBe('edges')
    expect(edge.data.source).toBe('1')
    expect(edge.data.target).toBe('2')
    expect(edge.data.weight).toBe(3.5)
    expect(edge.data.label).toBe('path')
  })

  test('nodes without label use id as label', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [{ id: 42 }],
      edges: [],
    }

    const elements = formatter.format(graph)
    expect(elements[0].data.label).toBe('42')
  })

  test('edge id format', () => {
    const graph: VizGraph = {
      directed: true,
      nodes: [{ id: 10 }, { id: 20 }],
      edges: [{ src: 10, dst: 20 }],
    }

    const elements = formatter.format(graph)
    const edge = elements.find((e) => e.group === 'edges')!
    expect(edge.data.id).toBe('10->20')
  })

  test('includes node properties', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [{ id: 1, props: { age: 30, city: 'NYC', active: true } }],
      edges: [],
    }

    const elements = formatter.format(graph)
    expect(elements[0].data.age).toBe(30)
    expect(elements[0].data.city).toBe('NYC')
    expect(elements[0].data.active).toBe(true)
  })

  test('formatFromAdjacency for directed graph', () => {
    const neighbors: Record<number, number[]> = {
      0: [1],
      1: [2],
      2: [],
    }

    const elements = formatter.formatFromAdjacency(
      (n) => neighbors[n] ?? [],
      [0, 1, 2],
      true,
    )

    expect(elements.filter((e) => e.group === 'nodes')).toHaveLength(3)
    expect(elements.filter((e) => e.group === 'edges')).toHaveLength(2)
  })

  test('formatFromAdjacency for undirected graph deduplicates edges', () => {
    const neighbors: Record<number, number[]> = {
      0: [1, 2],
      1: [0],
      2: [0],
    }

    const elements = formatter.formatFromAdjacency(
      (n) => neighbors[n] ?? [],
      [0, 1, 2],
      false,
    )

    expect(elements.filter((e) => e.group === 'edges')).toHaveLength(2)
    expect(elements.filter((e) => e.group === 'nodes')).toHaveLength(3)
  })

  test('empty graph produces empty array', () => {
    const graph: VizGraph = {
      directed: false,
      nodes: [],
      edges: [],
    }

    const elements = formatter.format(graph)
    expect(elements).toHaveLength(0)
  })
})
