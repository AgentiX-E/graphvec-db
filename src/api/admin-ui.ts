/**
 * admin-ui.ts — Lightweight Web Admin UI for AgentiX GraphVec
 *
 * Provides:
 *   - Static file server for a minimal admin dashboard
 *   - Admin API endpoints:
 *       GET  /api/admin/health        → Node health status
 *       GET  /api/admin/stats         → Graph statistics
 *       GET  /api/admin/procedures    → List registered procedures
 *       POST /api/admin/query         → Run a Cypher query and return results
 *       GET  /api/admin/graph-live    → Full topology snapshot (Cytoscape JSON)
 *       WS   /api/admin/graph-live    → Real-time topology change stream
 *
 * Usage:
 *   import { startAdminUI } from './admin-ui'
 *   const server = await startAdminUI(graphConfig, { port: 8080 })
 *   // Later:
 *   await server.close()
 */

import Fastify, { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify'
import { readFileSync, existsSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { WebSocketServer, WebSocket } from 'ws'

// ── Types ─────────────────────────────────────────────────

export interface AdminUIOptions {
  port?: number
  host?: string
  staticDir?: string
}

/**
 * 拓扑变更事件 —— 由外部 CDC 事件流推送
 */
export interface TopoChangeEvent {
  type: 'node_upsert' | 'node_delete' | 'edge_upsert' | 'edge_delete'
  /** 节点/边 ID */
  id: number
  /** 节点/边数据（upsert 时携带） */
  data?: {
    id: number
    label?: string
    typeId?: number
    props?: Record<string, unknown>
    /** 边特有的源/目标节点 */
    source?: number
    target?: number
  }
  /** 时间戳 */
  timestamp: number
}

/**
 * Cytoscape.js 元素格式
 */
export interface CyElement {
  group: 'nodes' | 'edges'
  data: {
    id: string
    label?: string
    typeId?: number
    /** 边特有 */
    source?: string
    target?: string
    /** 属性 */
    [key: string]: unknown
  }
}

/**
 * GraphLiveStream — 实时拓扑流管理
 */
interface GraphLiveStream {
  /** 所有连接的 WS 客户端 */
  clients: Set<WebSocket>
  /** 推送变更事件到所有客户端 */
  push(event: TopoChangeEvent): void
  /** 当前连接的客户端数 */
  clientCount: number
}

// ── HTML dashboard (inline, no extra build step) ──────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentiX GraphVec Admin</title>
  <script src="https://unpkg.com/cytoscape/dist/cytoscape.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #334155; }
    header h1 { font-size: 24px; font-weight: 600; }
    header .badge { background: #3b82f6; color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 4px; }
    header .topo-indicator { font-size: 12px; color: #94a3b8; margin-left: auto; display: flex; align-items: center; gap: 6px; }
    header .topo-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }
    .topo-dot.connected { background: #22c55e; }
    .topo-dot.disconnected { background: #ef4444; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
    .card h3 { font-size: 14px; color: #94a3b8; margin-bottom: 8px; text-transform: uppercase; letter-spacing: .5px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .value.green { color: #22c55e; }
    .card .value.yellow { color: #eab308; }
    .card .value.red { color: #ef4444; }
    .card .value.blue { color: #3b82f6; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 14px; }
    th { color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }
    pre { background: #0f172a; padding: 12px; border-radius: 6px; overflow-x: auto; font-size: 13px; }
    .query-box { display: flex; gap: 8px; margin-bottom: 16px; }
    .query-box input { flex: 1; background: #1e293b; border: 1px solid #334155; color: #e2e8f0; padding: 10px 14px; border-radius: 6px; font-family: monospace; font-size: 14px; }
    .query-box button { background: #3b82f6; color: #fff; border: none; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 500; }
    .query-box button:hover { background: #2563eb; }
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; flex-wrap: wrap; }
    .tabs button { background: transparent; border: 1px solid transparent; color: #94a3b8; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .tabs button.active { background: #1e293b; border-color: #334155; color: #e2e8f0; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .error { color: #ef4444; }
    .loading { opacity: .5; }
    #topo-cy { width: 100%; height: 600px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; }
    .topo-info { display: flex; gap: 16px; margin-bottom: 12px; font-size: 13px; color: #94a3b8; }
    .topo-info span { display: flex; align-items: center; gap: 4px; }
    .topo-tooltip { position: absolute; background: #1e293b; border: 1px solid #334155; border-radius: 6px; padding: 10px 14px; font-size: 13px; pointer-events: none; z-index: 1000; max-width: 300px; display: none; }
    .topo-tooltip h4 { color: #e2e8f0; margin-bottom: 4px; }
    .topo-tooltip p { color: #94a3b8; margin: 2px 0; }
    .topo-tooltip code { background: #0f172a; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>AgentiX GraphVec</h1>
      <span class="badge">Admin</span>
      <div class="topo-indicator" id="topo-status">
        <span class="topo-dot disconnected" id="topo-dot"></span>
        <span id="topo-status-text">Topo disconnected</span>
      </div>
    </header>

    <div class="tabs">
      <button class="active" data-tab="dashboard">Dashboard</button>
      <button data-tab="topology">Topology</button>
      <button data-tab="procedures">Procedures</button>
      <button data-tab="query">Query</button>
    </div>

    <div id="dashboard" class="tab-content active">
      <div class="grid" id="stats-grid">
        <div class="card"><h3>Status</h3><div class="value loading" id="stat-status">—</div></div>
        <div class="card"><h3>Nodes</h3><div class="value blue" id="stat-nodes">—</div></div>
        <div class="card"><h3>Edges</h3><div class="value blue" id="stat-edges">—</div></div>
        <div class="card"><h3>Uptime</h3><div class="value" id="stat-uptime">—</div></div>
      </div>
    </div>

    <div id="topology" class="tab-content">
      <div class="topo-info">
        <span>Nodes: <strong id="topo-node-count">0</strong></span>
        <span>Edges: <strong id="topo-edge-count">0</strong></span>
        <span>WS: <span id="topo-ws-status" style="color:#eab308;">pending</span></span>
        <span>Last event: <span id="topo-last-event">—</span></span>
      </div>
      <div id="topo-cy"></div>
      <div class="topo-tooltip" id="topo-tooltip"></div>
    </div>

    <div id="procedures" class="tab-content">
      <table>
        <thead><tr><th>Name</th><th>Description</th></tr></thead>
        <tbody id="procedure-list"></tbody>
      </table>
    </div>

    <div id="query" class="tab-content">
      <div class="query-box">
        <input id="query-input" type="text" placeholder="MATCH (n) RETURN n LIMIT 10" value="MATCH (n:Person) RETURN n LIMIT 10" />
        <button onclick="runQuery()">Run</button>
      </div>
      <div id="query-result"><pre style="color:#64748b;">Run a query to see results...</pre></div>
    </div>
  </div>

  <script>
    // ── Tab switching ──
    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'))
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'))
        btn.classList.add('active')
        document.getElementById(btn.dataset.tab).classList.add('active')
        if (btn.dataset.tab === 'topology' && window.cy) { window.cy.resize(); window.cy.fit(); }
      })
    })

    // ── Helper ──
    async function fetchJSON(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    }

    // ── Dashboard ──
    async function loadDashboard() {
      try {
        const health = await fetchJSON('/api/admin/health')
        const stats = await fetchJSON('/api/admin/stats')

        const statusEl = document.getElementById('stat-status')
        statusEl.textContent = health.status || (health.alive ? 'Healthy' : 'Unhealthy')
        statusEl.className = 'value ' + (health.alive ? 'green' : 'red')

        document.getElementById('stat-nodes').textContent = stats.nodeCount ?? '—'
        document.getElementById('stat-edges').textContent = stats.edgeCount ?? '—'
        document.getElementById('stat-uptime').textContent = (health.uptime != null) ? Math.round(health.uptime) + 's' : '—'
      } catch (e) {
        document.querySelectorAll('#stats-grid .value').forEach(el => { el.textContent = 'Error'; el.className = 'value error' })
      }
    }

    // ── Procedures ──
    async function loadProcedures() {
      try {
        const procs = await fetchJSON('/api/admin/procedures')
        const tbody = document.getElementById('procedure-list')
        tbody.innerHTML = procs.map(p => '<tr><td><code>' + p.name + '</code></td><td>' + (p.description || '') + '</td></tr>').join('')
      } catch (e) {}
    }

    // ── Query ──
    async function runQuery() {
      const input = document.getElementById('query-input')
      const resultEl = document.getElementById('query-result')
      resultEl.innerHTML = '<pre class="loading">Running...</pre>'
      try {
        const res = await fetch('/api/admin/query', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ query: input.value })
        })
        const data = await res.json()
        resultEl.innerHTML = '<pre>' + JSON.stringify(data, null, 2) + '</pre>'
      } catch (e) {
        resultEl.innerHTML = '<pre class="error">' + e.message + '</pre>'
      }
    }

    // ── Topology ─────────────────────────────────────────
    let cy = null
    let topoWs = null

    function initTopology() {
      const container = document.getElementById('topo-cy')

      cy = window.cy = cytoscape({
        container: container,
        style: [
          { selector: 'node', style: { 'background-color': '#3b82f6', 'label': 'data(label)', 'color': '#e2e8f0', 'font-size': '12px', 'text-valign': 'bottom', 'text-halign': 'center', 'width': 30, 'height': 30 } },
          { selector: 'node[typeId]', style: { 'shape': function(el) { const t = parseInt(el.data('typeId')); return t % 3 === 0 ? 'rectangle' : t % 3 === 1 ? 'diamond' : 'ellipse'; } } },
          { selector: 'edge', style: { 'width': 2, 'line-color': '#64748b', 'target-arrow-color': '#64748b', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
          { selector: ':selected', style: { 'border-width': 3, 'border-color': '#fbbf24' } },
        ],
        layout: { name: 'cose', animate: true, animationDuration: 500, fit: true, padding: 30 },
        wheelSensitivity: 0.5,
      })

      // Tooltip on hover
      const tooltip = document.getElementById('topo-tooltip')
      cy.on('mouseover', 'node', function(evt) {
        const n = evt.target
        const d = n.data()
        tooltip.innerHTML = '<h4>' + (d.label || d.id) + '</h4><p>ID: <code>' + d.id + '</code></p><p>Type: <code>' + (d.typeId ?? '—') + '</code></p>'
        tooltip.style.display = 'block'
      })
      cy.on('mouseover', 'edge', function(evt) {
        const e = evt.target
        const d = e.data()
        tooltip.innerHTML = '<h4>Edge: ' + d.source + ' → ' + d.target + '</h4><p>ID: <code>' + d.id + '</code></p>'
        tooltip.style.display = 'block'
      })
      cy.on('mousemove', function(evt) {
        const pos = evt.originalEvent
        tooltip.style.left = (pos.clientX + 12) + 'px'
        tooltip.style.top = (pos.clientY + 12) + 'px'
      })
      cy.on('mouseout', 'node, edge', function() {
        tooltip.style.display = 'none'
      })

      // Pan & zoom with mouse/trackpad
      cy.on('zoom', function() { tooltip.style.display = 'none' })
    }

    function loadTopoSnapshot() {
      fetch('/api/admin/graph-live')
        .then(r => r.json())
        .then(data => {
          const elements = data.elements || []
          document.getElementById('topo-node-count').textContent = elements.filter(e => e.group === 'nodes').length
          document.getElementById('topo-edge-count').textContent = elements.filter(e => e.group === 'edges').length

          if (cy) {
            cy.elements().remove()
            cy.add(elements)
            cy.layout({ name: 'cose', animate: true, animationDuration: 500, fit: true, padding: 30 }).run()
          }
        })
        .catch(e => console.error('Topo snapshot error:', e))
    }

    function connectTopoWebSocket() {
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
      const wsUrl = proto + '//' + location.host + '/api/admin/graph-live'

      try {
        topoWs = new WebSocket(wsUrl)
      } catch(e) {
        document.getElementById('topo-ws-status').textContent = 'error'
        setTimeout(connectTopoWebSocket, 5000)
        return
      }

      topoWs.onopen = function() {
        document.getElementById('topo-ws-status').textContent = 'connected'
        document.getElementById('topo-ws-status').style.color = '#22c55e'
        document.getElementById('topo-dot').className = 'topo-dot connected'
        document.getElementById('topo-status-text').textContent = 'Topo connected'
      }

      topoWs.onmessage = function(evt) {
        try {
          const event = JSON.parse(evt.data)
          document.getElementById('topo-last-event').textContent = event.type + ' [' + new Date(event.timestamp || Date.now()).toLocaleTimeString() + ']'

          if (!cy) return

          if (event.type === 'node_upsert' && event.data) {
            const id = String(event.data.id)
            if (cy.getElementById(id).length > 0) {
              cy.getElementById(id).data(event.data)
              cy.getElementById(id).addClass('highlighted')
            } else {
              cy.add({ group: 'nodes', data: { id: id, label: event.data.label || String(id), typeId: event.data.typeId } })
            }
            setTimeout(function() { cy.getElementById(id).removeClass('highlighted') }, 1500)
          } else if (event.type === 'node_delete') {
            cy.getElementById(String(event.id)).remove()
          } else if (event.type === 'edge_upsert' && event.data) {
            const id = String(event.data.id)
            if (cy.getElementById(id).length > 0) {
              cy.getElementById(id).data(event.data)
              cy.getElementById(id).addClass('highlighted')
            } else {
              cy.add({ group: 'edges', data: { id: id, source: String(event.data.source), target: String(event.data.target), label: event.data.label || '' } })
            }
            setTimeout(function() { cy.getElementById(id).removeClass('highlighted') }, 1500)
          } else if (event.type === 'edge_delete') {
            cy.getElementById(String(event.id)).remove()
          }

          // update counts
          document.getElementById('topo-node-count').textContent = cy.nodes().length
          document.getElementById('topo-edge-count').textContent = cy.edges().length
        } catch(e) {
          console.error('WS msg error:', e)
        }
      }

      topoWs.onclose = function() {
        document.getElementById('topo-ws-status').textContent = 'disconnected'
        document.getElementById('topo-ws-status').style.color = '#ef4444'
        document.getElementById('topo-dot').className = 'topo-dot disconnected'
        document.getElementById('topo-status-text').textContent = 'Topo disconnected'
        setTimeout(connectTopoWebSocket, 5000)
      }

      topoWs.onerror = function() {
        topoWs.close()
      }
    }

    // ── Init ──
    loadDashboard()
    loadProcedures()
    initTopology()
    loadTopoSnapshot()
    connectTopoWebSocket()
  </script>
</body>
</html>`

// ── Admin UI server ───────────────────────────────────────

/**
 * Start the admin UI server.
 * Returns the Fastify instance so the caller can close() it.
 *
 * GAP-36: 新增 graph-live 端点（REST + WebSocket）推送实时拓扑变更。
 */
export async function startAdminUI(
  graph: {
    getNodeCount?: () => number;
    getEdgeCount?: () => number;
    getHealth?: () => { alive: boolean; uptime: number };
    query?: (q: string) => unknown;
    /** 获取全量拓扑快照（Cytoscape.js 格式） */
    getTopology?: () => CyElement[];
    /** CDC 事件订阅（可选） */
    onTopoChange?: (handler: (event: TopoChangeEvent) => void) => () => void;
  },
  options: AdminUIOptions = {},
): Promise<FastifyInstance> {
  const port = options.port ?? 8080
  const host = options.host ?? '0.0.0.0'

  const app = Fastify({ logger: { level: 'info' } })

  // ── WebSocket graph-live stream ──────────────────────
  const stream: GraphLiveStream = { clients: new Set(), clientCount: 0, push: (event: TopoChangeEvent) => { /* assigned after WSS creation */ } }
  const wss = new WebSocketServer({ noServer: true })

  // hijack Fastify upgrade for /api/admin/graph-live
  app.server.on('upgrade', (request: any, socket: any, head: any) => {
    const url = request.url ?? ''
    if (url === '/api/admin/graph-live') {
      wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
        stream.clients.add(ws)
        stream.clientCount = stream.clients.size

        ws.on('close', () => {
          stream.clients.delete(ws)
          stream.clientCount = stream.clients.size
        })

        ws.on('error', () => {
          stream.clients.delete(ws)
          stream.clientCount = stream.clients.size
        })
      })
    }
  })

  // 实现 push
  stream.push = (event: TopoChangeEvent) => {
    const payload = JSON.stringify(event)
    const clients = Array.from(stream.clients)
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(payload)
      } else {
        stream.clients.delete(client)
      }
    }
    stream.clientCount = stream.clients.size
  }

  // 订阅外部 CDC 事件（如提供）
  let unsubscribeTopo: (() => void) | null = null
  if (graph.onTopoChange) {
    unsubscribeTopo = graph.onTopoChange((event: TopoChangeEvent) => {
      stream.push(event)
    })
  }

  // ── cleanup on close ──
  app.addHook('onClose', async () => {
    if (unsubscribeTopo) unsubscribeTopo()
    const clients = Array.from(stream.clients)
    for (const ws of clients) { ws.close() }
    stream.clients.clear()
    wss.close()
  })

  // ── Admin API routes ──────────────────────────────────

  // Health endpoint
  app.get('/api/admin/health', async (req: FastifyRequest, reply: FastifyReply) => {
    const health = graph.getHealth ? graph.getHealth() : { alive: true, uptime: process.uptime() }
    return {
      alive: health.alive ?? true,
      status: health.alive ? 'Healthy' : 'Unhealthy',
      uptime: health.uptime ?? process.uptime(),
      timestamp: new Date().toISOString(),
    }
  })

  // Stats endpoint
  app.get('/api/admin/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    return {
      nodeCount: graph.getNodeCount ? graph.getNodeCount() : 0,
      edgeCount: graph.getEdgeCount ? graph.getEdgeCount() : 0,
    }
  })

  // Procedures endpoint
  app.get('/api/admin/procedures', async (req: FastifyRequest, reply: FastifyReply) => {
    // Try to import procedure registry dynamically (avoids hard dependency)
    try {
      const { procedureRegistry } = await import('../query/procedure-registry')
      return procedureRegistry.listProcedures()
    } catch {
      return [{ name: 'N/A', description: 'Procedure registry not available' }]
    }
  })

  // Query endpoint
  app.post('/api/admin/query', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { query: string }
    if (!body || typeof body.query !== 'string') {
      reply.code(400)
      return { error: 'Missing "query" field' }
    }

    try {
      if (graph.query) {
        const result = await graph.query(body.query)
        return { success: true, result }
      }
      return { success: true, result: 'Query execution not available' }
    } catch (err) {
      reply.code(500)
      return { error: (err as Error).message }
    }
  })

  // Graph Live endpoint — returns full topology snapshot
  app.get('/api/admin/graph-live', async (req: FastifyRequest, reply: FastifyReply) => {
    const topology = graph.getTopology ? graph.getTopology() : []
    const elements = topology.length > 0
      ? topology
      : [{ group: 'nodes', data: { id: 'placeholder', label: 'No Data' } }]
    return {
      elements,
      timestamp: Date.now(),
    }
  })

  // Index route — serve the dashboard HTML
  app.get('/', async (req: FastifyRequest, reply: FastifyReply) => {
    reply.type('text/html').send(DASHBOARD_HTML)
  })

  // Fallback: redirect unknown API routes to /
  app.setNotFoundHandler((req: FastifyRequest, reply: FastifyReply) => {
    if (req.url.startsWith('/api/')) {
      reply.code(404).send({ error: `Route not found: ${req.url}` })
    } else {
      // Serve dashboard for non-API routes
      reply.type('text/html').send(DASHBOARD_HTML)
    }
  })

  await app.listen({ port, host })
  return app
}
