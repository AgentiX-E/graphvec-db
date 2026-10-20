/**
 * admin-ui-graph-editor.spec.ts — Tests for the Admin UI Graph Editor (GAP-66)
 *
 * Tests the graph editor API endpoints and verifies the editor HTML/JS is present.
 * The editor is purely client-side cytoscape.js — we test the server-side API
 * that handles save requests and verify that the HTML contains the editor UI.
 */

import { describe, it, expect, afterAll, beforeAll } from 'vitest'
import { startAdminUI } from './admin-ui'
import type { FastifyInstance } from 'fastify'

// ── Mock graph ────────────────────────────────────────────

const MOCK_TOPOLOGY = [
  { group: 'nodes' as const, data: { id: '1', label: 'Node1', typeId: 1 } },
  { group: 'nodes' as const, data: { id: '2', label: 'Node2', typeId: 2 } },
  { group: 'edges' as const, data: { id: 'e1', source: '1', target: '2', label: 'connects' } },
]

function createMockGraph() {
  return {
    getNodeCount: () => 42,
    getEdgeCount: () => 137,
    getHealth: () => ({ alive: true, uptime: 3600 }),
    query: async (q: string) => ({ results: [{ query: q }] }),
    getTopology: () => MOCK_TOPOLOGY,
    onTopoChange: (handler: any) => {
      return () => {} // unsubscribe no-op
    },
  }
}

// ── Tests ─────────────────────────────────────────────────

describe('Admin UI Graph Editor (GAP-66)', () => {
  let server: FastifyInstance
  let baseUrl: string

  beforeAll(async () => {
    server = await startAdminUI(createMockGraph(), { port: 0, host: '127.0.0.1' })
    const addr = server.addresses()[0] as { address: string; port: number }
    baseUrl = `http://${addr.address}:${addr.port}`
  })

  afterAll(async () => {
    if (server) {
      await server.close()
    }
  })

  describe('API endpoint: POST /api/admin/graph-save', () => {
    it('should accept valid node elements', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [
            { group: 'nodes', data: { id: 'n1', label: 'EditorNode1', typeId: 3 } },
            { group: 'nodes', data: { id: 'n2', label: 'EditorNode2', typeId: 1 } },
            { group: 'edges', data: { id: 'e1', source: 'n1', target: 'n2', label: 'connected' } },
          ],
        }),
      })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.accepted).toBe(3)
    })

    it('should accept empty elements array', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: [] }),
      })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.accepted).toBe(0)
    })

    it('should return 400 when elements is missing', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      // Fastify returns 400 because body validation fails
      const data = await res.json()
      expect(data.success).toBe(false)
      expect(data.error).toBeTruthy()
    })

    it('should return 400 when elements is not an array', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: 'not-array' }),
      })
      const data = await res.json()
      expect(data.success).toBe(false)
    })

    it('should handle single node element', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [
            { group: 'nodes', data: { id: 'standalone', label: 'Solo', typeId: 2 } },
          ],
        }),
      })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.accepted).toBe(1)
    })

    it('should handle edge-only elements', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-save`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          elements: [
            { group: 'edges', data: { id: 'lonely-edge', source: 'a', target: 'b' } },
          ],
        }),
      })
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data.success).toBe(true)
      expect(data.accepted).toBe(1)
    })
  })

  describe('Dashboard HTML contains editor components', () => {
    it('should have the Editor tab button', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('data-tab="editor"')
    })

    it('should have the editor tab content container', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('id="editor"')
      expect(html).toContain('editor-cy')
    })

    it('should include editor tool buttons', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('editor-btn')
      expect(html).toContain('data-tool="add-node"')
      expect(html).toContain('data-tool="add-edge"')
      expect(html).toContain('data-tool="delete"')
      expect(html).toContain('data-tool="select"')
    })

    it('should include editor properties panel', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('editor-props-panel')
      expect(html).toContain('editor-props-fields')
      expect(html).toContain('editor-edit-id')
    })

    it('should include save and reset buttons', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('saveEditorGraph')
      expect(html).toContain('resetEditorGraph')
    })

    it('should include the Editor tab label', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('🌐 Editor')
    })

    it('should include key JavaScript functions for the editor', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('function initEditor')
      expect(html).toContain('function editorSetTool')
      expect(html).toContain('function saveEditorGraph')
      expect(html).toContain('function resetEditorGraph')
      expect(html).toContain('function renderEditorProps')
      expect(html).toContain('function applyEditorProps')
    })

    it('should have editor mode badge', async () => {
      const res = await fetch(`${baseUrl}/`)
      const html = await res.text()
      expect(html).toContain('editor-mode-badge')
    })
  })

  describe('Topology data integration', () => {
    it('should return topology via graph-live endpoint', async () => {
      const res = await fetch(`${baseUrl}/api/admin/graph-live`)
      expect(res.ok).toBe(true)
      const data = await res.json()
      expect(data).toHaveProperty('elements')
      // Use Array.isArray rather than instanceof Array: the response body is
      // parsed by the fetch/undici worker realm, whose Array constructor is a
      // different realm from the test file's Array, so instanceof fails even
      // though the value is a genuine array. Array.isArray checks the internal
      // [[ArrayData]] slot and is realm-agnostic.
      expect(Array.isArray(data.elements)).toBe(true)
      expect(data.elements.length).toBeGreaterThan(0)
    })
  })
})
