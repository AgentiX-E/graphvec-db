// tck-engine-worker.js — 纯 CJS，node 直接跑，不需要 tsx
// 通过临时文件读入 JSON payload，执行 GraphEngine 查询，输出结果到临时文件。

const path = require('path')
const fs = require('fs')

function main() {
  const inFile = process.argv[2]
  const outFile = process.argv[3]
  if (!inFile || !outFile) {
    process.stdout.write(JSON.stringify({ ok: false, error: 'Usage: worker INPUT_FILE OUTPUT_FILE' }))
    return
  }

  const input = fs.readFileSync(inFile, 'utf8')
  const { plan, data } = JSON.parse(input)

  try { fs.unlinkSync(inFile) } catch {}

  const { GraphEngine } = require(
    path.resolve(__dirname, '../../dist/src/core/graph-engine.js')
  )

  const dir = '/tmp/tckge-' + process.pid
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  fs.mkdirSync(dir, { recursive: true })

  const e = new GraphEngine({ path: dir, denseVector: { dimension: 384 } })
  e.open()

  // Insert all nodes
  for (const item of data) {
    var label = item._label || 'Default'
    var props = {}
    for (var k of Object.keys(item))
      if (k !== '_label') props[k] = item[k]
    props._label = label
    var h = 0
    for (var i = 0; i < label.length; i++) h = ((h << 5) - h + label.charCodeAt(i)) | 0
    e.upsertNode(Math.abs(h) % 1000 + 1, 'tk-' + Math.random().toString(36).slice(2, 6), { props })
  }

  // Build and execute query
  const q = planToQuery(plan)
  const raw = e.query(q)

  // Format result
  var result = []
  if (raw && raw.length > 0) {
    var vars = getVarNames(plan)
    if (vars.length <= 1) {
      result = raw.map(function(r) {
        var o = {}; o[vars[0] || 'n'] = r.props ? Object.assign({}, r.props) : r; return o
      })
    } else if (vars.length >= 2 && raw.length >= 2) {
      for (var i = 0; i + 1 < raw.length; i += 2) {
        var row = {}
        row[vars[0]] = raw[i] && raw[i].props ? Object.assign({}, raw[i].props) : raw[i]
        row[vars[1]] = raw[i + 1] && raw[i + 1].props ? Object.assign({}, raw[i + 1].props) : raw[i + 1]
        result.push(row)
      }
    } else {
      result = raw
    }
  }

  // Cleanup
  try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  try { e.close() } catch {}

  // Write result to output file
  fs.writeFileSync(outFile, JSON.stringify({ ok: true, result: result }))
}

function planToQuery(p) {
  if (!p) return 'MATCH (n) RETURN n'
  if (p.unionType || p.type === 'UNION') return planToQuery(p.rightPlan || p.leftPlan)
  if (p.type === 'CALL') return p.callProcedure ? 'CALL ' + p.callProcedure.name + '() YIELD *' : 'MATCH (n) RETURN n'
  if (p.type === 'CREATE' || p.type === 'DELETE' || p.type === 'MERGE') return 'MATCH (n) RETURN n'
  var q = '', sv = 'n'
  if (p.scanLabel) q = 'MATCH (n:' + p.scanLabel + ')'
  else if (p.steps && p.steps.length > 0) {
    var s = p.steps[0]; sv = s.source || 'a'
    var f = s.direction === 'in' ? '<-[:' : '-[:'
    var t = s.direction === 'in' ? ']-' : ']->'
    q = 'MATCH (' + sv + ')' + f + (s.edgeLabel || '') + t + '(' + (s.targetAlias || 'b') + ')'
  } else q = 'MATCH (n)'
  if (p.filters && p.filters.length > 0) {
    var cs = []
    for (var fi = 0; fi < p.filters.length; fi++) {
      var f = p.filters[fi]
      cs.push((f.source || sv) + '.' + f.property + ' ' + f.operator + ' ' + (typeof f.value === 'string' ? "'" + f.value + "'" : f.value))
    }
    q += ' WHERE ' + cs.join(' AND ')
  }
  if (p.returnColumns && p.returnColumns.length > 0) q += ' RETURN ' + p.returnColumns.join(', '); else q += ' RETURN n'
  if (p.orderBy && p.orderBy.length > 0) {
    var os = []
    for (var oi = 0; oi < p.orderBy.length; oi++) {
      var o = p.orderBy[oi]
      os.push((o.column || o.property || o.expression) + ' ' + (o.direction || ''))
    }
    q += ' ORDER BY ' + os.join(', ')
  }
  if (p.limit !== undefined) q += ' LIMIT ' + p.limit
  if (p.skip !== undefined) q += ' SKIP ' + p.skip
  return q
}

function getVarNames(p) {
  var s = ['n']
  if (p.returnColumns) for (var ci = 0; ci < p.returnColumns.length; ci++) { var c = p.returnColumns[ci]; if (typeof c === 'string' && /^\w+$/.test(c) && s.indexOf(c) < 0) s.push(c) }
  if (p.steps) for (var si = 0; si < p.steps.length; si++) { var st = p.steps[si]; if (st.source && s.indexOf(st.source) < 0) s.push(st.source); if (st.targetAlias && s.indexOf(st.targetAlias) < 0) s.push(st.targetAlias) }
  return s
}

try {
  main()
} catch (err) {
  try { fs.writeFileSync(process.argv[3] || '/dev/null', JSON.stringify({ ok: false, error: err.message })) } catch {}
}
