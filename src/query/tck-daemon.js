/**
 * tck-daemon.js — 持久化 GraphEngine daemon
 *
 * 纯 CJS，node 直接跑，不需要 tsx。
 * 启动 HTTP server，接收 POST /query 请求，执行 GraphEngine 查询，返回 JSON 结果。
 *
 * 用法:
 *   node src/query/tck-daemon.js [PORT]
 *   node src/query/tck-daemon.js 0     # 自动选择端口，写入端口文件
 */

const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// ── 解析参数 ──
const portArg = parseInt(process.argv[2], 10) || 0;
const portFile = process.argv[3] || null;

// ── 启动 GraphEngine 单例 ──
const { GraphEngine } = require(
  path.resolve(__dirname, '../../dist/src/core/graph-engine.js')
);

const PID = process.pid;
const DB_DIR = path.join('/tmp', 'tckdaemon-' + PID);

// 清理旧数据目录（如果存在）
try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
fs.mkdirSync(DB_DIR, { recursive: true });

const engine = new GraphEngine({ path: DB_DIR, denseVector: { dimension: 384 } });
engine.open();

console.error('[tck-daemon] GraphEngine opened at ' + DB_DIR);

// ── 辅助函数 ──

/**
 * plan → Cypher query string（同 tck-engine-worker.js 的逻辑）
 */
function planToQuery(p) {
  if (!p) return 'MATCH (n) RETURN n';
  if (p.unionType || p.type === 'UNION') return planToQuery(p.rightPlan || p.leftPlan);
  if (p.type === 'CALL') return p.callProcedure ? 'CALL ' + p.callProcedure.name + '() YIELD *' : 'MATCH (n) RETURN n';
  if (p.type === 'CREATE' || p.type === 'DELETE' || p.type === 'MERGE') return 'MATCH (n) RETURN n';

  var q = '', sv = 'n';
  if (p.scanLabel) {
    q = 'MATCH (n:' + p.scanLabel + ')';
  } else if (p.steps && p.steps.length > 0) {
    var s = p.steps[0]; sv = s.source || 'a';
    var f = s.direction === 'in' ? '<-[:' : '-[:';
    var t = s.direction === 'in' ? ']-' : ']->';
    q = 'MATCH (' + sv + ')' + f + (s.edgeLabel || '') + t + '(' + (s.targetAlias || 'b') + ')';
  } else {
    q = 'MATCH (n)';
  }

  if (p.filters && p.filters.length > 0) {
    var cs = [];
    for (var fi = 0; fi < p.filters.length; fi++) {
      var f = p.filters[fi];
      var op = f.operator;
      var cypherOp = op;
      // Map PEG internal operators to Cypher syntax
      var opMap = {
        'EQ': '=',
        'NEQ': '<>',
        'GT': '>',
        'GTE': '>=',
        'LT': '<',
        'LTE': '<=',
        'IN': 'IN',
        'IS_NULL': 'IS NULL',
        'IS_NOT_NULL': 'IS NOT NULL',
        'CONTAINS': 'CONTAINS',
        'STARTS_WITH': 'STARTS WITH',
        'ENDS_WITH': 'ENDS WITH',
        '=': '=',
        '>': '>',
        '<': '<',
        '>=': '>=',
        '<=': '<=',
        '<>': '<>',
      };
      cypherOp = (opMap[op] !== undefined) ? opMap[op] : op;

      var left = (f.source || sv) + '.' + f.property;
      var val = f.value;

      if (op === 'IS_NULL' || op === 'IS NOT NULL') {
        cs.push(left + ' ' + cypherOp);
      } else if (op === 'IN' && Array.isArray(val)) {
        var items = val.map(function(v) {
          return typeof v === 'string' ? "'" + v + "'" : v;
        }).join(', ');
        cs.push(left + ' IN [' + items + ']');
      } else if (op === 'IN' && typeof val === 'string') {
        // val might be a literal list string like "[1, 2]"
        cs.push(left + ' IN ' + val);
      } else if (typeof val === 'string') {
        cs.push(left + ' ' + cypherOp + " '" + val + "'");
      } else if (typeof val === 'boolean') {
        cs.push(left + ' ' + cypherOp + ' ' + val);
      } else {
        cs.push(left + ' ' + cypherOp + ' ' + val);
      }
    }
    q += ' WHERE ' + cs.join(' AND ');
  }

  if (p.returnColumns && p.returnColumns.length > 0) {
    q += ' RETURN ' + p.returnColumns.join(', ');
  } else {
    q += ' RETURN n';
  }

  if (p.orderBy && p.orderBy.length > 0) {
    var os = [];
    for (var oi = 0; oi < p.orderBy.length; oi++) {
      var o = p.orderBy[oi];
      // Extract actual field name from orderBy item
      var orderField = o.field || o.column || o.property || o.expression;
      if (!orderField) {
        // Try first non-direction key
        var keys = Object.keys(o);
        for (var ki = 0; ki < keys.length; ki++) {
          if (keys[ki] !== 'direction' && typeof o[keys[ki]] === 'string') {
            orderField = o[keys[ki]];
            break;
          }
        }
      }
      os.push((orderField || 'n') + ' ' + (o.direction || ''));
    }
    q += ' ORDER BY ' + os.join(', ');
  }

  if (p.limit !== undefined) q += ' LIMIT ' + p.limit;
  if (p.skip !== undefined) q += ' SKIP ' + p.skip;
  return q;
}

function getVarNames(p) {
  var s = ['n'];
  if (p.returnColumns) {
    for (var ci = 0; ci < p.returnColumns.length; ci++) {
      var c = p.returnColumns[ci];
      if (typeof c === 'string' && /^\w+$/.test(c) && s.indexOf(c) < 0) s.push(c);
    }
  }
  if (p.steps) {
    for (var si = 0; si < p.steps.length; si++) {
      var st = p.steps[si];
      if (st.source && s.indexOf(st.source) < 0) s.push(st.source);
      if (st.targetAlias && s.indexOf(st.targetAlias) < 0) s.push(st.targetAlias);
    }
  }
  return s;
}

/**
 * 为请求生成唯一名称前缀，隔离不同测试的数据
 */
function uniquePrefix() {
  return 'd-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

// ── HTTP Server ──

let requestCount = 0;

const server = http.createServer((req, res) => {
  // 健康检查
  if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, requests: requestCount }));
    return;
  }

  // 关闭 daemon
  if (req.method === 'POST' && req.url === '/shutdown') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    server.close(() => {
      console.error('[tck-daemon] Shutting down...');
      try { engine.close(); } catch {}
      try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
      process.exit(0);
    });
    return;
  }

  if (req.method !== 'POST' || req.url !== '/query') {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: 'Not found. Use POST /query' }));
    return;
  }

  let body = '';
  req.on('data', function(d) { body += d; });
  req.on('end', function() {
    requestCount++;

    var reqId = requestCount;

    try {
      const { plan, data } = JSON.parse(body);

      // ── 插入所有节点（使用唯一前缀隔离不同请求）──
      const prefix = uniquePrefix();
      var nodesInserted = 0;
      if (data && data.length > 0) {
        for (var i = 0; i < data.length; i++) {
          const item = data[i];
          var label = item._label || 'Default';
          var props = {};
          var keys = Object.keys(item);
          for (var ki = 0; ki < keys.length; ki++) {
            if (keys[ki] !== '_label') props[keys[ki]] = item[keys[ki]];
          }
          props._label = label;

          // simple hash for typeId
          var h = 0;
          for (var ci = 0; ci < label.length; ci++) {
            h = ((h << 5) - h + label.charCodeAt(ci)) | 0;
          }

          engine.upsertNode(
            Math.abs(h) % 1000 + 1,
            prefix + '-' + i + '-tk-' + Math.random().toString(36).slice(2, 6),
            { props }
          );
          nodesInserted++;
        }
      }

      // ── 构建并执行查询 ──
      const q = planToQuery(plan);
      const raw = engine.query(q);

      // ── 格式化结果 ──
      var result = [];
      if (raw && raw.length > 0) {
        var vars = getVarNames(plan);
        if (vars.length <= 1) {
          result = raw.map(function(r) {
            var o = {};
            o[vars[0] || 'n'] = r.props ? Object.assign({}, r.props) : r;
            return o;
          });
        } else if (vars.length >= 2 && raw.length >= 2) {
          for (var ri = 0; ri + 1 < raw.length; ri += 2) {
            var row = {};
            row[vars[0]] = raw[ri] && raw[ri].props
              ? Object.assign({}, raw[ri].props)
              : raw[ri];
            row[vars[1]] = raw[ri + 1] && raw[ri + 1].props
              ? Object.assign({}, raw[ri + 1].props)
              : raw[ri + 1];
            result.push(row);
          }
        } else {
          result = raw;
        }
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result }));
    } catch (err) {
      console.error('[tck-daemon] Request #' + reqId + ' error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
  });
});

// ── 启动监听 ──
server.listen(portArg, '127.0.0.1', function() {
  const addr = server.address();
  const actualPort = addr.port;

  // 写入端口文件
  const pf = portFile || ('/tmp/tck-daemon-port-' + PID);
  fs.writeFileSync(pf, String(actualPort));

  // 输出 READY 信号到 stdout
  process.stdout.write('TCK_DAEMON_READY:' + actualPort + '\n');

  console.error('[tck-daemon] Listening on http://127.0.0.1:' + actualPort +
    ', port file: ' + pf);
});

// ── 优雅退出 ──
function shutdown() {
  console.error('[tck-daemon] Received signal, shutting down...');
  server.close(function() {
    try { engine.close(); } catch {}
    try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch {}
    process.exit(0);
  });
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('uncaughtException', function(err) {
  console.error('[tck-daemon] Uncaught exception:', err.message);
  shutdown();
});