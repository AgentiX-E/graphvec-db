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
      <button data-tab="editor">🌐 Editor</button>
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
        <span id="topo-sampled-badge" style="display:none;color:#f59e0b;background:#1e293b;padding:2px 8px;border-radius:4px;font-size:12px;">📊 Sampled</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <button onclick="topoSearch()" style="background:#475569;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;">🔍 Search</button>
        <button onclick="topoResetZoom()" style="background:#475569;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;">⊞ Reset Zoom</button>
        <button onclick="loadTopoSnapshot()" style="background:#0ea5e9;color:#fff;border:none;padding:6px 14px;border-radius:6px;cursor:pointer;">↻ Reload</button>
      </div>
      <div id="topo-cy"></div>
      <div class="topo-tooltip" id="topo-tooltip"></div>
    </div>

    <div id="editor" class="tab-content">
      <div class="topo-info">
        <span>⚡ Editor Mode</span>
        <span>Nodes: <strong id="editor-node-count">0</strong></span>
        <span>Edges: <strong id="editor-edge-count">0</strong></span>
        <span id="editor-mode-badge" style="background:#f59e0b;color:#000;padding:2px 8px;border-radius:4px;font-size:12px;">Select</span>
      </div>
      <div style="display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
        <button class="editor-btn" data-tool="select" style="background:#3b82f6;">↖ Select</button>
        <button class="editor-btn" data-tool="add-node" style="background:#22c55e;">+ Node</button>
        <button class="editor-btn" data-tool="add-edge" style="background:#a855f7;">+ Edge</button>
        <button class="editor-btn" data-tool="delete" style="background:#ef4444;">🗑 Delete</button>
        <button onclick="saveEditorGraph()" style="background:#2563eb;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:500;">💾 Save</button>
        <button onclick="resetEditorGraph()" style="background:#475569;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:500;">↺ Reset</button>
      </div>
      <div id="editor-cy" style="width:100%;height:500px;background:#0f172a;border:1px solid #334155;border-radius:8px;"></div>
      <div id="editor-props-panel" style="margin-top:12px;background:#1e293b;border:1px solid #334155;border-radius:8px;padding:16px;display:none;">
        <h4 style="color:#e2e8f0;margin-bottom:8px;">Properties Editor</h4>
        <div style="color:#94a3b8;font-size:13px;margin-bottom:8px;">
          Editing: <code id="editor-edit-id" style="color:#e2e8f0;">—</code>
          (<span id="editor-edit-type" style="color:#94a3b8;">node</span>)
        </div>
        <div id="editor-props-fields"></div>
        <div style="margin-top:8px;display:flex;gap:8px;">
          <button onclick="addEditorPropField()" style="background:#475569;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;">+ Add Prop</button>
          <button onclick="applyEditorProps()" style="background:#22c55e;color:#fff;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;">✓ Apply</button>
        </div>
      </div>
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

    function topoSearch() {
      const q = prompt('Search node by ID or label:')
      if (!q) return
      if (!cy) return
      // 先用 id 精确匹配
      let target = cy.getElementById(q)
      if (target.length === 0) {
        // 再用 label 包含匹配
        const all = cy.nodes()
        for (let i = 0; i < all.length; i++) {
          const label = String(all[i].data('label') || '')
          if (label.toLowerCase().includes(q.toLowerCase())) {
            target = all[i]
            break
          }
        }
      }
      if (target.length > 0) {
        cy.fit(target, 50)       // 缩放到选中节点
        target.addClass('highlighted')
        setTimeout(() => target.removeClass('highlighted'), 3000)
      } else {
        alert('No node found matching: ' + q)
      }
    }

    function topoResetZoom() {
      if (cy) {
        cy.fit(undefined, 30)
        cy.reset()
      }
    }

    function loadTopoSnapshot() {
      fetch('/api/admin/graph-live?maxNodes=200')
        .then(r => r.json())
        .then(r => r.json())
        .then(data => {
          const elements = data.elements || []
          document.getElementById('topo-node-count').textContent = elements.filter(e => e.group === 'nodes').length
          document.getElementById('topo-edge-count').textContent = elements.filter(e => e.group === 'edges').length
          // sampled badge
          const badge = document.getElementById('topo-sampled-badge')
          if (data.sampled) {
            badge.textContent = '📊 Sampled (total ' + (data.total || '?') + ' elements)'
            badge.style.display = 'inline'
          } else {
            badge.style.display = 'none'
          }

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

    // ── Graph Editor ──────────────────────────────────────
    let editorCy = null;
    let editorTool = 'select';
    let editorEdgeSource = null;
    let editorSelectedEl = null;
    let editorChangeCount = 0;

    function initEditor() {
      const container = document.getElementById('editor-cy');
      if (!container) return;

      editorCy = cytoscape({
        container: container,
        style: [
          { selector: 'node', style: { 'background-color': '#3b82f6', 'label': 'data(label)', 'color': '#e2e8f0', 'font-size': '12px', 'text-valign': 'bottom', 'text-halign': 'center', 'width': 30, 'height': 30 } },
          { selector: 'node[typeId]', style: { 'shape': function(el) { const t = parseInt(el.data('typeId')); return t % 3 === 0 ? 'rectangle' : t % 3 === 1 ? 'diamond' : 'ellipse'; } } },
          { selector: 'edge', style: { 'width': 2, 'line-color': '#64748b', 'target-arrow-color': '#64748b', 'target-arrow-shape': 'triangle', 'curve-style': 'bezier' } },
          { selector: ':selected', style: { 'border-width': 3, 'border-color': '#fbbf24' } },
        ],
        layout: { name: 'grid', fit: true, padding: 30 },
        wheelSensitivity: 0.5,
        userZoomingEnabled: true,
        userPanningEnabled: true,
        boxSelectionEnabled: true,
      });

      editorLoadFromTopo();

      editorCy.on('tap', function(evt) {
        const target = evt.target;
        const isBg = target === editorCy;

        if (editorTool === 'add-node' && isBg) {
          const pos = evt.position || evt.renderedPosition || { x: 100, y: 100 };
          const id = 'n' + Date.now();
          const typeId = 1 + (editorCy.nodes().length % 5);
          editorCy.add({ group: 'nodes', data: { id: id, label: 'Node' + (editorCy.nodes().length + 1), typeId: typeId } });
          editorCy.getElementById(id).position({ x: pos.x, y: pos.y });
          editorUpdateCounts();
          editorChangeCount++;
          return;
        }

        if (editorTool === 'add-edge' && target.isNode()) {
          if (!editorEdgeSource) {
            editorEdgeSource = target;
            target.style({ 'border-width': 3, 'border-color': '#a855f7' });
          } else {
            const src = editorEdgeSource;
            const dst = target;
            src.style({ 'border-width': 0 });
            const edgeId = 'e' + Date.now();
            if (src.id() !== dst.id()) {
              editorCy.add({ group: 'edges', data: { id: edgeId, source: src.id(), target: dst.id(), label: '' } });
              editorChangeCount++;
            }
            editorEdgeSource = null;
            editorUpdateCounts();
          }
          return;
        }

        if (editorTool === 'delete' && target !== editorCy) {
          target.remove();
          editorUpdateCounts();
          editorChangeCount++;
          return;
        }

        if (editorTool === 'select' && target !== editorCy) {
          editorSelectedEl = target;
          const isNode = target.isNode();
          const data = target.data();
          document.getElementById('editor-props-panel').style.display = 'block';
          document.getElementById('editor-edit-id').textContent = data.id;
          document.getElementById('editor-edit-type').textContent = isNode ? 'node' : 'edge';
          renderEditorProps(target);
        }
      });

      editorCy.on('dragfree', 'node', function() {
        editorChangeCount++;
      });
    }

    function editorSetTool(tool) {
      editorTool = tool;
      if (tool === 'select') {
        editorCy.nodes().style({ 'border-width': 0 });
        editorEdgeSource = null;
      }
      document.getElementById('editor-mode-badge').textContent =
        tool === 'select' ? 'Select' :
        tool === 'add-node' ? 'Add Node' :
        tool === 'add-edge' ? 'Add Edge' :
        tool === 'delete' ? 'Delete' : tool;
    }

    function editorLoadFromTopo() {
      if (!editorCy) return;
      fetch('/api/admin/graph-live')
        .then(r => r.json())
        .then(data => {
          const els = data.elements || [];
          editorCy.elements().remove();
          for (const el of els) {
            if (el.group === 'nodes' && el.data.id !== 'placeholder') {
              editorCy.add(el);
            } else if (el.group === 'edges') {
              editorCy.add(el);
            }
          }
          editorCy.layout({ name: 'cose', fit: true, padding: 30 }).run();
          editorUpdateCounts();
        })
        .catch(e => console.error('Editor load error:', e));
    }

    function editorUpdateCounts() {
      if (!editorCy) return;
      document.getElementById('editor-node-count').textContent = editorCy.nodes().length;
      document.getElementById('editor-edge-count').textContent = editorCy.edges().length;
    }

    function renderEditorProps(el) {
      const container = document.getElementById('editor-props-fields');
      const data = el.data();

      let html = '';
      html += '<div style="margin-bottom:6px;"><label style="color:#94a3b8;font-size:12px;display:block;">Label</label>';
      html += '<input id="editor-prop-label" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;" value="' + escAttr(data.label || '') + '" /></div>';
      html += '<div style="margin-bottom:6px;"><label style="color:#94a3b8;font-size:12px;display:block;">TypeId</label>';
      html += '<input id="editor-prop-typeid" style="width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;" value="' + escAttr(String(data.typeId ?? '')) + '" /></div>';
      for (const key in data) {
        if (key === 'id' || key === 'source' || key === 'target' || key === 'label' || key === 'typeId' || key === 'group') continue;
        html += '<div style="display:flex;gap:6px;margin-bottom:6px;align-items:center;">';
        html += '<input class="editor-prop-key" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;font-size:12px;" placeholder="key" value="' + escAttr(key) + '" />';
        html += '<input class="editor-prop-val" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;font-size:12px;" placeholder="value" value="' + escAttr(String(data[key] ?? '')) + '" />';
        html += '<button onclick="this.parentElement.remove()" style="background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:18px;">×</button>';
        html += '</div>';
      }
      container.innerHTML = html;
    }

    function escAttr(s) {
      return String(s).replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function addEditorPropField() {
      const container = document.getElementById('editor-props-fields');
      const div = document.createElement('div');
      div.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center;';
      div.innerHTML =
        '<input class="editor-prop-key" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;font-size:12px;" placeholder="key" />' +
        '<input class="editor-prop-val" style="flex:1;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:6px 10px;border-radius:4px;font-size:12px;" placeholder="value" />' +
        '<button onclick="this.parentElement.remove()" style="background:transparent;border:none;color:#ef4444;cursor:pointer;font-size:18px;">×</button>';
      container.appendChild(div);
    }

    function applyEditorProps() {
      if (!editorSelectedEl) return;
      const el = editorSelectedEl;
      const newData = {};

      const label = document.getElementById('editor-prop-label').value || String(el.data('id'));
      newData.label = label;
      const typeId = parseInt(document.getElementById('editor-prop-typeid').value);
      if (!isNaN(typeId)) newData.typeId = typeId;

      const keyInputs = document.querySelectorAll('#editor-props-fields .editor-prop-key');
      const valInputs = document.querySelectorAll('#editor-props-fields .editor-prop-val');
      for (let i = 0; i < keyInputs.length; i++) {
        const k = keyInputs[i].value.trim();
        const v = valInputs[i].value.trim();
        if (k) {
          const num = Number(v);
          newData[k] = v === '' ? '' : (isNaN(v) ? v : (v.includes('.') ? num : (v === 'true' ? true : v === 'false' ? false : (isNaN(num) ? v : num))));
        }
      }

      el.data(newData);
      editorChangeCount++;
      renderEditorProps(el);
    }

    function saveEditorGraph() {
      const elements = editorCy.elements().jsons().map(function(e) {
        const d = Object.assign({}, e.data);
        if (d.group === 'nodes') {
          const pos = e.position || { x: 0, y: 0 };
          d._pos = pos;
        }
        return { group: e.group, data: d };
      });

      fetch('/api/admin/graph-save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ elements: elements }),
      })
      .then(r => r.json())
      .then(res => {
        if (res.success) {
          editorChangeCount = 0;
          alert('Graph saved successfully!');
        } else {
          alert('Save failed: ' + (res.error || 'unknown error'));
        }
      })
      .catch(e => alert('Save error: ' + e.message));
    }

    function resetEditorGraph() {
      if (editorChangeCount > 0 && !confirm('Unsaved changes will be lost. Continue?')) return;
      editorLoadFromTopo();
      editorChangeCount = 0;
    }

    document.addEventListener('click', function(e) {
      const btn = e.target.closest('.editor-btn');
      if (btn) {
        editorSetTool(btn.dataset.tool);
      }
    });

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
    /** CDC 事件订阅（Optional） */
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
      const { globalRegistry } = await import('../query/procedure-registry')
      return globalRegistry.listProcedures()
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

  // Graph Save endpoint — receives edited topology from the graph editor (GAP-66)
  app.post('/api/admin/graph-save', async (req: FastifyRequest, reply: FastifyReply) => {
    const body = req.body as { elements: CyElement[] }
    if (!body || !Array.isArray(body.elements)) {
      reply.code(400)
      return { success: false, error: 'Missing "elements" array' }
    }

    try {
      for (const el of body.elements) {
        if (el.group === 'nodes') {
          stream.push({
            type: 'node_upsert',
            id: parseInt(el.data.id as string) || (el.data.id as any),
            data: {
              id: parseInt(el.data.id as string) || (el.data.id as any),
              label: el.data.label as string | undefined,
              typeId: el.data.typeId as number | undefined,
              props: el.data.props as Record<string, unknown> | undefined,
            },
            timestamp: Date.now(),
          })
        } else if (el.group === 'edges') {
          const sourceId = parseInt(el.data.source as string) || (el.data.source as any)
          const targetId = parseInt(el.data.target as string) || (el.data.target as any)
          stream.push({
            type: 'edge_upsert',
            id: parseInt(el.data.id as string) || (el.data.id as any),
            data: {
              id: parseInt(el.data.id as string) || (el.data.id as any),
              label: el.data.label as string | undefined,
              source: sourceId,
              target: targetId,
              props: el.data.props as Record<string, unknown> | undefined,
            },
            timestamp: Date.now(),
          })
        }
      }

      stream.push({
        type: 'node_upsert',
        id: 0,
        data: { id: 0, label: '__save_checkpoint__' },
        timestamp: Date.now(),
      })

      return { success: true, accepted: body.elements.length }
    } catch (err) {
      reply.code(500)
      return { success: false, error: (err as Error).message }
    }
  })

  // Graph Live endpoint — returns full topology snapshot
  app.get('/api/admin/graph-live', async (req: FastifyRequest, reply: FastifyReply) => {
    const maxNodes = parseInt((req.query as Record<string, string>)?.['maxNodes'] ?? '200', 10)
    let topology = graph.getTopology ? graph.getTopology() : []

    // 大图采样：超过 maxNodes 时只返回部分节点
    let sampled = false
    if (topology.length > maxNodes && maxNodes > 0) {
      const nodes = topology.filter((el: any) => el.group === 'nodes')
      const edges = topology.filter((el: any) => el.group === 'edges')
      // 按 typeId 分层采样
      const byType = new Map<string, any[]>()
      for (const n of nodes) {
        const typeId = String(n.data?.typeId ?? '0')
        if (!byType.has(typeId)) byType.set(typeId, [])
        byType.get(typeId)!.push(n)
      }
      // 每层等比例采样
      const targetNodeCount = Math.max(50, maxNodes)
      const sampledNodes: any[] = []
      const nodeIds = new Set<string>()
      for (const [, group] of byType) {
        const ratio = targetNodeCount / nodes.length
        const take = Math.max(1, Math.floor(group.length * ratio))
        for (let i = 0; i < take && sampledNodes.length < targetNodeCount; i++) {
          const n = group[i % group.length]
          if (!nodeIds.has(n.data.id)) {
            nodeIds.add(n.data.id)
            sampledNodes.push(n)
          }
        }
      }
      // 只保留连接采样节点的边
      const sampledEdges = edges.filter((e: any) =>
        nodeIds.has(String(e.data?.source)) && nodeIds.has(String(e.data?.target))
      )
      topology = [...sampledNodes, ...sampledEdges]
      sampled = true
    }

    const elements = topology.length > 0
      ? topology
      : [{ group: 'nodes', data: { id: 'placeholder', label: 'No Data' } }]
    return {
      elements,
      total: graph.getTopology ? (graph.getTopology() as any[]).length : elements.length,
      sampled,
      timestamp: Date.now(),
    }
  })

  // ── Admin Dashboard routes ───────────────────────────

  // GET /admin/stats — JSON statistics (same data as /api/admin/stats)
  app.get('/admin/stats', async (req: FastifyRequest, reply: FastifyReply) => {
    return {
      nodeCount: graph.getNodeCount ? graph.getNodeCount() : 0,
      edgeCount: graph.getEdgeCount ? graph.getEdgeCount() : 0,
      nodeTypeCount: 0, // simplified — can be extended
      shardCount: 1,     // simplified
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    }
  })

  // GET /admin — HTML dashboard page with inline CSS/JS
  app.get('/admin', async (req: FastifyRequest, reply: FastifyReply) => {
    const nodeCount = graph.getNodeCount ? graph.getNodeCount() : 0
    const edgeCount = graph.getEdgeCount ? graph.getEdgeCount() : 0

    const adminHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentiX Admin Dashboard</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; padding: 24px; }
    h1 { font-size: 24px; margin-bottom: 24px; display: flex; align-items: center; gap: 12px; }
    h1 .badge { background: #3b82f6; color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 4px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 8px; padding: 20px; }
    .card h3 { font-size: 14px; color: #94a3b8; text-transform: uppercase; letter-spacing: .5px; margin-bottom: 8px; }
    .card .value { font-size: 28px; font-weight: 700; }
    .card .value.blue { color: #3b82f6; }
    .card .value.green { color: #22c55e; }
    .card .value.yellow { color: #eab308; }
    .section { margin-bottom: 24px; }
    .section h2 { font-size: 18px; margin-bottom: 12px; color: #94a3b8; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid #334155; font-size: 14px; }
    th { color: #94a3b8; font-weight: 500; text-transform: uppercase; letter-spacing: .5px; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 3px; font-size: 13px; }
    .loading { opacity: .5; }
    .nav { display: flex; gap: 8px; margin-bottom: 24px; }
    .nav a { color: #94a3b8; text-decoration: none; padding: 6px 14px; border-radius: 6px; font-size: 14px; }
    .nav a.active { background: #1e293b; color: #e2e8f0; border: 1px solid #334155; }
    .nav a:hover { color: #e2e8f0; }
  </style>
</head>
<body>
  <h1>AgentiX GraphVec <span class="badge">Admin</span></h1>

  <div class="nav">
    <a href="/admin" class="active">Dashboard</a>
    <a href="/">Topology</a>
  </div>

  <div class="grid">
    <div class="card">
      <h3>Nodes</h3>
      <div class="value blue" id="stat-nodes">${nodeCount}</div>
    </div>
    <div class="card">
      <h3>Edges</h3>
      <div class="value blue" id="stat-edges">${edgeCount}</div>
    </div>
    <div class="card">
      <h3>Node Types</h3>
      <div class="value yellow" id="stat-types">—</div>
    </div>
    <div class="card">
      <h3>Shards</h3>
      <div class="value green" id="stat-shards">—</div>
    </div>
    <div class="card">
      <h3>Uptime</h3>
      <div class="value" id="stat-uptime">${Math.round(process.uptime())}s</div>
    </div>
  </div>

  <div class="section">
    <h2>Recent Queries</h2>
    <table>
      <thead><tr><th>#</th><th>Query</th><th>Time</th></tr></thead>
      <tbody id="query-history">
        <tr><td colspan="3" style="color:#64748b;text-align:center;">No query history available</td></tr>
      </tbody>
    </table>
  </div>

  <div class="section">
    <h2>Shard Information</h2>
    <table>
      <thead><tr><th>Shard ID</th><th>Status</th><th>Nodes</th><th>Edges</th></tr></thead>
      <tbody>
        <tr><td><code>0</code></td><td style="color:#22c55e;">Active</td><td>${nodeCount}</td><td>${edgeCount}</td></tr>
      </tbody>
    </table>
  </div>

  <script>
    async function refreshStats() {
      try {
        const res = await fetch('/admin/stats')
        const data = await res.json()
        document.getElementById('stat-nodes').textContent = data.nodeCount ?? '—'
        document.getElementById('stat-edges').textContent = data.edgeCount ?? '—'
        document.getElementById('stat-types').textContent = data.nodeTypeCount ?? '—'
        document.getElementById('stat-shards').textContent = data.shardCount ?? '—'
        document.getElementById('stat-uptime').textContent = Math.round(data.uptime) + 's'
      } catch (e) {
        console.error('Stats refresh failed:', e)
      }
    }
    setInterval(refreshStats, 5000)
  </script>
</body>
</html>`

    reply.type('text/html').send(adminHtml)
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
