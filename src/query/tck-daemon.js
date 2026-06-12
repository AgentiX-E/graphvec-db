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

console.error('[tck-daemon] GraphEngine module loaded');

// Each request gets its own isolated GraphEngine instance.
// This prevents test data pollution across tests.
function createEngine() {
  const dir = path.join('/tmp', 'tckge-' + PID + '-' + Date.now().toString(36) + '-' + crypto.randomBytes(3).toString('hex'));
  fs.mkdirSync(dir, { recursive: true });
  const ge = new GraphEngine({ path: dir, denseVector: { dimension: 384 } });
  ge.open();
  return ge;
}

function destroyEngine(ge) {
  try { ge.close(); } catch {}
  try { fs.rmSync(ge.path || ge._path, { recursive: true, force: true }); } catch {}
}

// ── 辅助函数 ──

/**
 * plan → Cypher query string（同 tck-engine-worker.js 的逻辑）
 */
function planToQuery(p) {
  if (!p) return 'MATCH (n) RETURN n';
  if (p.unionType || p.type === 'UNION') return planToQuery(p.rightPlan || p.leftPlan);
  if (p.type === 'CALL') return p.callProcedure ? 'CALL ' + p.callProcedure.name + '() YIELD *' : 'MATCH (n) RETURN n';
  if (p.type === 'CREATE' || p.type === 'DELETE' || p.type === 'MERGE') {
    if (p.scanLabel) {
      return 'MATCH (n:' + p.scanLabel + ') RETURN n';
    }
    return 'MATCH (n) RETURN n';
  }

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
          return typeof v === 'string' ? '"' + v + '"' : v;
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

  if (p.aggregate) {
    // Single aggregate: takes priority over returnColumns
    var agg = p.aggregate;
    var funcName = (agg.type || agg.func || agg.function || '').toUpperCase();
    var aggExpr = '';

    // Support both ANTLR format (column contains full expr like "count(*)")
    // and legacy PEG format (field contains just the field name)
    if (agg.column && !agg.field) {
      // ANTLR format: column = "count(*)" or "count(*) AS total" or "count(n.age)"
      var colExpr = agg.column;
      // Remove AS alias from expression
      var asMatch = colExpr.match(/^(.+?)\s+AS\s+\w+$/i);
      if (asMatch) colExpr = asMatch[1].trim();
      aggExpr = colExpr;
    } else if (funcName === 'COUNT' && (agg.field === '*' || !agg.field)) {
      aggExpr = 'count(*)';
    } else if (agg.field) {
      // e.g. sum(n.age) — field contains the expression
      aggExpr = funcName.toLowerCase() + '(' + agg.field + ')';
    } else {
      aggExpr = funcName.toLowerCase() + '(n)';
    }

    if (agg.alias && agg.alias !== '*' && agg.alias !== agg.column && agg.alias !== agg.field) {
      // Only add AS if the expression doesn't already contain AS
      if (aggExpr.indexOf(' AS ') < 0) {
        aggExpr += ' AS ' + agg.alias;
      }
    }
    // When there are GROUP BY columns, include them in the RETURN clause
    // (the daemon's generated query must include both group columns and aggregates)
    if (p.groupBy && p.groupBy.length > 0) {
      // Build: RETURN col1, col2, aggExpr GROUP BY col1, col2
      var groupCols = p.groupBy.map(function(g) { return g.replace(/^(\w+)\./, '') }).join(', ');
      q += ' RETURN ' + groupCols + ', ' + aggExpr;
      q += ' GROUP BY ' + p.groupBy.join(', ');

      // HAVING
      if (p.having && p.having.length > 0) {
        var havingParts = [];
        for (var hi = 0; hi < p.having.length; hi++) {
          var h = p.having[hi];
          var opMap = {GT: '>', GTE: '>=', LT: '<', LTE: '<=', EQ: '=', NEQ: '<>', '<>': '<>'};
          var op = opMap[h.operator] || h.operator;
          havingParts.push(h.aggregate + ' ' + op + ' ' + h.value);
        }
        q += ' HAVING ' + havingParts.join(' AND ');
      }
    } else {
      q += ' RETURN ' + aggExpr;
    }
  } else if (p.aggregates && p.aggregates.length > 0) {
    // Multiple aggregates
    var aggExprs = [];
    for (var ai = 0; ai < p.aggregates.length; ai++) {
      var a = p.aggregates[ai];
      var fn = (a.type || a.func || '').toUpperCase();
      var aArgs = a.args || [];
      var expr = fn + '(' + (aArgs.length > 0 ? aArgs.join(', ') : '*') + ')';
      if (a.alias && a.alias !== expr) expr += ' AS ' + a.alias;
      aggExprs.push(expr);
    }
    q += ' RETURN ' + aggExprs.join(', ');
    if (p.groupBy && p.groupBy.length > 0) {
      q += ' GROUP BY ' + p.groupBy.join(', ');
    }
  } else if (p.returnColumns && p.returnColumns.length > 0) {
    q += ' RETURN ' + p.returnColumns.join(', ');
  } else {
    q += ' RETURN n';
  }

  // DO NOT add ORDER BY / LIMIT / SKIP to SQL — GraphEngine doesn't support them.
  // They are handled in JS post-processing below.
  return q;
}

/**
 * Extract a property name from an orderBy item, removing node prefix.
 * e.g. "n.name" → "name", "n" → "n"
 */
function _orderByField(o) {
  var field = o.field || o.property || o.column || o.expression || o.col;
  if (!field) {
    var okeys = Object.keys(o);
    for (var ki = 0; ki < okeys.length; ki++) {
      if (okeys[ki] !== 'direction' && okeys[ki] !== 'type' && typeof o[okeys[ki]] === 'string') {
        field = o[okeys[ki]];
        break;
      }
    }
  }
  if (field) field = field.replace(/^\w+\./, '');
  return field || 'n';
}

/**
 * Extract return column names (strip node prefix), e.g. "n.name" → "name"
 */
function _returnCols(p) {
  if (!p.returnColumns || p.returnColumns.length === 0) return null;
  return p.returnColumns.map(function(c) {
    var m = c.match(/^\w+\.(\w+)$/);
    return m ? m[1] : c;
  });
}

/**
 * Post-process result array: project columns, ORDER BY, SKIP, LIMIT
 */
function _postProcess(result, plan) {
  if (!result || result.length === 0) return result;
  var p = plan;
  var processed = result.slice(); // shallow copy

  // ── Project return columns ──
  // When returnColumns exist and are property accesses (e.g. "n.name"),
  // flatten each row to just those properties
  var cols = _returnCols(p);
  if (cols && cols.length > 0 && cols.every(function(c) { return c !== 'n'; })) {
    processed = processed.map(function(row) {
      // Find the first value that's an object (the node's props)
      var props = null;
      var keys = Object.keys(row);
      for (var ki = 0; ki < keys.length; ki++) {
        if (typeof row[keys[ki]] === 'object' && row[keys[ki]] !== null) {
          props = row[keys[ki]];
          break;
        }
      }
      if (!props) return row;
      var flat = {};
      for (var ci = 0; ci < cols.length; ci++) {
        var col = cols[ci];
        flat[col] = props[col] !== undefined ? props[col] : null;
      }
      // Fallback: for columns that didn't match the key directly (e.g. "count(*)" where
      // the actual key in props is "count"), strip non-alphanumeric chars and retry.
      var needsFallback = false;
      for (var ci = 0; ci < cols.length; ci++) {
        if (flat[cols[ci]] === null) { needsFallback = true; break; }
      }
      if (needsFallback) {
        for (var ci = 0; ci < cols.length; ci++) {
          var col = cols[ci];
          if (flat[col] === null) {
            var stripped = col.replace(/[^a-zA-Z0-9]/g, '');
            for (var pkey in props) {
              if (pkey.replace(/[^a-zA-Z0-9]/g, '') === stripped && props[pkey] !== undefined) {
                flat[col] = props[pkey];
                break;
              }
            }
          }
        }
      }
      // Include _label for compat
      if (props._label) flat._label = props._label;
      // If no cols matched just the whole node, return as is
      if (Object.keys(flat).length === 0) return row;
      return flat;
    });
  }

  // ── ORDER BY ──
  if (p.orderBy && p.orderBy.length > 0) {
    processed.sort(function(a, b) {
      for (var oi = 0; oi < p.orderBy.length; oi++) {
        var o = p.orderBy[oi];
        var field = _orderByField(o);
        var dir = (o.direction || '').trim().toUpperCase();
        var va = a[field];
        var vb = b[field];
        if (va === undefined) va = null;
        if (vb === undefined) vb = null;
        var cmp = 0;
        if (va === null && vb === null) cmp = 0;
        else if (va === null) cmp = -1;
        else if (vb === null) cmp = 1;
        else if (typeof va === 'number' && typeof vb === 'number') {
          cmp = va - vb;
        } else {
          cmp = String(va).localeCompare(String(vb));
        }
        if (cmp !== 0) return dir === 'DESC' ? -cmp : cmp;
      }
      return 0;
    });
  }

  // ── HAVING ──
  // Filter rows based on having conditions (post-aggregation filter)
  if (p.having && p.having.length > 0 && processed.length > 0) {
    // For HAVING to work, the aggregate values should already be in the results.
    // The query generated by planToQuery includes both group columns and aggregate expressions.
    // We need to find the aggregate column in each row and filter.
    for (var hi = 0; hi < p.having.length; hi++) {
      var h = p.having[hi];
      // The having aggregate reference is like "count(*)" or "count(n.name)"
      // Look for a matching column key in the result row
      var aggKey = null;
      if (processed.length > 0) {
        var sampleKeys = Object.keys(processed[0]);
        var aggStripped = h.aggregate.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        for (var ski = 0; ski < sampleKeys.length; ski++) {
          var key = sampleKeys[ski];
          // The key might match the aggregate expression directly or be an alias
          if (key.toLowerCase() === h.aggregate.toLowerCase() ||
              key.toLowerCase() === aggStripped ||
              key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase() === aggStripped) {
            aggKey = key;
            break;
          }
        }
        // If no match found, try the most numeric-like column (likely the count)
        if (!aggKey) {
          for (var ski = 0; ski < sampleKeys.length; ski++) {
            var key = sampleKeys[ski];
            if (typeof processed[0][key] === 'number') {
              aggKey = key;
              break;
            }
          }
        }
      }

      var op = h.operator;
      var val = h.value;

      processed = processed.filter(function(row) {
        var rowVal = aggKey ? row[aggKey] : undefined;
        if (rowVal === undefined) return true; // can't filter, keep
        switch (op) {
          case 'GT': return rowVal > val;
          case 'GTE': return rowVal >= val;
          case 'LT': return rowVal < val;
          case 'LTE': return rowVal <= val;
          case 'EQ': return rowVal === val;
          case 'NEQ': return rowVal !== val;
          default: return true;
        }
      });
    }
  }

  // ── SKIP / LIMIT ──
  var skip = (p.skip !== undefined && p.skip !== null) ? parseInt(p.skip, 10) : 0;
  var limit = (p.limit !== undefined && p.limit !== null) ? parseInt(p.limit, 10) : undefined;
  if (skip > 0 || limit !== undefined) {
    if (skip > 0 && limit !== undefined) {
      processed = processed.slice(skip, skip + limit);
    } else if (skip > 0) {
      processed = processed.slice(skip);
    } else {
      processed = processed.slice(0, limit);
    }
  }

  return processed;
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

    // Create an isolated engine for this request
    var ge = null;
    try {
      const { plan, data } = JSON.parse(body);

      ge = createEngine();

      // ── 插入所有节点 ──
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

          var h = 0;
          for (var ci = 0; ci < label.length; ci++) {
            h = ((h << 5) - h + label.charCodeAt(ci)) | 0;
          }

          ge.upsertNode(
            Math.abs(h) % 1000 + 1,
            'req-' + reqId + '-n' + i + '-' + Math.random().toString(36).slice(2, 6),
            { props }
          );
        }
      }

      // ── 构建并执行查询 ──

      // ── SHOW LABELS：从插入的数据中提取所有不重复的 _label ──
      if (plan.show && plan.show.what === 'LABELS') {
        var labels = [];
        if (data && data.length > 0) {
          var seenLabels = {};
          for (var di = 0; di < data.length; di++) {
            var lbl = data[di]._label;
            if (lbl && !seenLabels[lbl]) {
              seenLabels[lbl] = true;
              labels.push({ label: lbl });
            }
          }
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, result: labels }));
        if (ge) destroyEngine(ge);
        return;
      }

      const q = planToQuery(plan);
      console.error('[tck-daemon] query=' + q + ' for ' + (data ? data.length : 0) + ' data items');
      const raw = ge.query(q);
      if (!raw || raw.length === 0) console.error('[tck-daemon] query=' + q + ' → EMPTY');
      console.error('[tck-daemon] raw count=' + (raw ? raw.length : 0));

      // ── 格式化结果 ──
      var result = [];
      if (raw && raw.length > 0) {
        // Simple uniform formatter: each raw graph node becomes {n: {props}}
        result = raw.map(function(r) {
          var o = {};
          o['n'] = r.props ? Object.assign({}, r.props) : r;
          return o;
        });
      }

      // ── Post-process: project columns, ORDER BY, SKIP, LIMIT ──
      result = _postProcess(result, plan);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, result: result }));

      // Clean up isolated engine
      if (ge) destroyEngine(ge);
    } catch (err) {
      if (ge) destroyEngine(ge);
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