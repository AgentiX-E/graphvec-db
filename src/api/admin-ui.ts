/**
 * admin-ui.ts — Lightweight Web Admin UI for AgentiX GraphVec
 *
 * Provides:
 *   - Static file server for a minimal admin dashboard
 *   - Admin API endpoints:
 *       GET  /api/admin/health     → Node health status
 *       GET  /api/admin/stats      → Graph statistics
 *       GET  /api/admin/procedures → List registered procedures
 *       POST /api/admin/query      → Run a Cypher query and return results
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

// ── Types ─────────────────────────────────────────────────

export interface AdminUIOptions {
  port?: number
  host?: string
  staticDir?: string
}

// ── HTML dashboard (inline, no extra build step) ──────────

const DASHBOARD_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AgentiX GraphVec Admin</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f172a; color: #e2e8f0; }
    .container { max-width: 1200px; margin: 0 auto; padding: 24px; }
    header { display: flex; align-items: center; gap: 16px; margin-bottom: 32px; padding-bottom: 16px; border-bottom: 1px solid #334155; }
    header h1 { font-size: 24px; font-weight: 600; }
    header .badge { background: #3b82f6; color: #fff; font-size: 12px; padding: 2px 8px; border-radius: 4px; }
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
    .tabs { display: flex; gap: 4px; margin-bottom: 16px; }
    .tabs button { background: transparent; border: 1px solid transparent; color: #94a3b8; padding: 8px 16px; border-radius: 6px; cursor: pointer; font-size: 14px; }
    .tabs button.active { background: #1e293b; border-color: #334155; color: #e2e8f0; }
    .tab-content { display: none; }
    .tab-content.active { display: block; }
    .error { color: #ef4444; }
    .loading { opacity: .5; }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <h1>AgentiX GraphVec</h1>
      <span class="badge">Admin</span>
    </header>

    <div class="tabs">
      <button class="active" data-tab="dashboard">Dashboard</button>
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
      })
    })

    // ── Load initial data ──
    async function fetchJSON(url) {
      const res = await fetch(url)
      if (!res.ok) throw new Error(await res.text())
      return res.json()
    }

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

    async function loadProcedures() {
      try {
        const procs = await fetchJSON('/api/admin/procedures')
        const tbody = document.getElementById('procedure-list')
        tbody.innerHTML = procs.map(p => '<tr><td><code>' + p.name + '</code></td><td>' + (p.description || '') + '</td></tr>').join('')
      } catch (e) {}
    }

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

    loadDashboard()
    loadProcedures()
  </script>
</body>
</html>`

// ── Admin UI server ───────────────────────────────────────

/**
 * Start the admin UI server.
 * Returns the Fastify instance so the caller can close() it.
 */
export async function startAdminUI(
  graph: { getNodeCount?: () => number; getEdgeCount?: () => number; getHealth?: () => { alive: boolean; uptime: number }; query?: (q: string) => unknown },
  options: AdminUIOptions = {},
): Promise<FastifyInstance> {
  const port = options.port ?? 8080
  const host = options.host ?? '0.0.0.0'

  const app = Fastify({ logger: { level: 'info' } })

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
