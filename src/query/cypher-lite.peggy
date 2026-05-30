/**
 * cypher-lite.peggy — Cypher 查询语言的精简子集解析器
 *
 * 支持的语法：
 *   MATCH (a:Label) (WHERE expr)? RETURN cols (ORDER BY col (ASC|DESC)?)? (LIMIT n)? (SKIP n)?
 *   MATCH (a)-[r:TYPE]->(b) (WHERE expr)? RETURN cols ...
 *   MATCH (a)-[:TYPE]->(b) WHERE expr RETURN cols ...
 *   多跳: MATCH (a)-[:TYPE]->(b)-[:TYPE]->(c) ...
 *   节点属性: (n {prop: val})
 *   无标签: (n)
 *   CREATE (n:Label {prop: "val"})
 *   CREATE (a)-[:KNOWS]->(b)
 *   MATCH (n) DELETE n
 *   MATCH (n) SET n.name = "val"
 *   MERGE (n:Label {id: 1})
 *   CREATE (n) RETURN n
 *   变长路径: MATCH (a)-[:TYPE*1..5]->(b) RETURN b
 *   变长路径（精确步数）: MATCH (a)-[:TYPE*3]->(b) RETURN b
 *   变长路径（最小步数）: MATCH (a)-[:TYPE*2..]->(b) RETURN b
 *
 * 不实现（Cypher-lite 边界）：
 *   FOREACH / CALL / 子查询 / OPTIONAL MATCH
 *   聚合函数 / UNION 已实现
 */

Start
  = _ stmt:DMLStatement _ { return stmt }
  / _ stmt:MatchStatement _ { return stmt }

// ── 顶级语句 ───────────────────────────────────────────

DMLStatement
  = createClause:CreateClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', create: createClause }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / matchClause:MatchClause deleteClause:DeleteClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, delete: deleteClause }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / matchClause:MatchClause setClause:SetClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, set: setClause }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / mergeClause:MergeClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', merge: mergeClause }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }

MatchStatement
  = matchClause:MatchClause whereClause:WhereClause? returnClause:ReturnClause groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
      if (unionClause) {
        return {
          type: 'QUERY',
          match: matchClause,
          where: whereClause,
          return: returnClause,
          groupBy: groupByClause,
          orderBy: orderByClause,
          limit: limitSkip ? limitSkip.limit : undefined,
          skip: limitSkip ? limitSkip.skip : undefined,
          unionType: unionClause.unionType,
          rightQuery: unionClause.rightQuery,
        }
      }
      return {
        type: 'QUERY',
        match: matchClause,
        where: whereClause,
        return: returnClause,
        groupBy: groupByClause,
        orderBy: orderByClause,
        limit: limitSkip ? limitSkip.limit : undefined,
        skip: limitSkip ? limitSkip.skip : undefined,
      }
    }

// ── CREATE ────────────────────────────────────────────────

CreateClause
  = _ "CREATE"i _ patterns:CreatePatternList {
      return { type: 'CREATE', patterns: patterns }
    }

CreatePatternList
  = head:CreatePathPattern tail:(_ "," _ CreatePathPattern)* {
      return [head, ...tail.map(t => t[3])]
    }

CreatePathPattern
  = node:NodePattern rest:(_ EdgePattern _ NodePattern)* {
      if (rest.length === 0) {
        // 单节点 CREATE (n:Label {prop: "val"})
        return { type: 'CREATE_NODE', node }
      }
      // 带边 CREATE (a)-[:KNOWS]->(b)
      return {
        type: 'CREATE_PATH',
        node,
        edges: rest.map(r => ({ edge: r[1], node: r[3] }))
      }
    }

// ── DELETE ────────────────────────────────────────────────

DeleteClause
  = _ "DELETE"i _ targets:IdentifierList {
      return { type: 'DELETE', targets }
    }

IdentifierList
  = head:Identifier tail:(_ "," _ Identifier)* {
      return [head, ...tail.map(t => t[3])]
    }

// ── SET ───────────────────────────────────────────────────

SetClause
  = _ "SET"i _ items:SetItemList {
      return { type: 'SET', items }
    }

SetItemList
  = head:SetItem tail:(_ "," _ SetItem)* {
      return [head, ...tail.map(t => t[3])]
    }

SetItem
  = ref:PropertyRef _ "=" _ val:Primary {
      return { type: 'SET_ITEM', property: ref, value: val }
    }

// ── MERGE ──────────────────────────────────────────────────

MergeClause
  = _ "MERGE"i _ patterns:CreatePatternList {
      return { type: 'MERGE', patterns: patterns }
    }

// ── MATCH ──────────────────────────────────────────────────

MatchClause
  = _ "MATCH"i _ patterns:PatternList { return { type: 'MATCH', patterns } }

PatternList
  = head:PathPattern tail:(_ "," _ PathPattern)* {
      return [head, ...tail.map(t => t[3])]
    }

PathPattern
  = node:NodePattern rest:(_ EdgePattern _ NodePattern)* {
      const edges = rest.map(r => ({ edge: r[1], node: r[3] }))
      return { type: 'PATH', node, edges }
    }

Range
  = '*' min:Integer '..' max:Integer { return { min, max } }
  / '*' min:Integer '..' { return { min, max: null } }
  / '*' exact:Integer !'.' { return { min: exact, max: exact } }

// ── 节点模式 ─────────────────────────────────────────────

NodePattern
  = "(" _ name:Identifier _ ")" { return { type: 'NODE', name, label: null, props: null } }
  / "(" _ name:Identifier _ ":" _ label:Label _ ")" {
      return { type: 'NODE', name, label, props: null }
    }
  / "(" _ name:Identifier _ props:PropertyMap _ ")" {
      return { type: 'NODE', name, label: null, props }
    }
  / "(" _ name:Identifier _ ":" _ label:Label _ props:PropertyMap _ ")" {
      return { type: 'NODE', name, label, props }
    }

// ── 边模式 ─────────────────────────────────────────────

EdgePattern
  = "-[" _ name:Identifier _ ":" _ type:Label _ range:Range _ "]->" { return { type: 'EDGE', name, label: type, direction: 'out', range } }
  / "-[" _ ":" _ type:Label _ range:Range _ "]->" { return { type: 'EDGE', name: null, label: type, direction: 'out', range } }
  / "-[" _ name:Identifier _ ":" _ type:Label _ "]->" { return { type: 'EDGE', name, label: type, direction: 'out' } }
  / "-[" _ ":" _ type:Label _ "]->" { return { type: 'EDGE', name: null, label: type, direction: 'out' } }
  / "-[" _ name:Identifier _ ":" _ type:Label _ "]-"  { return { type: 'EDGE', name, label: type, direction: 'any' } }
  / "-[" _ ":" _ type:Label _ "]-" { return { type: 'EDGE', name: null, label: type, direction: 'any' } }
  / "-[" _ name:Identifier _ ":" _ type:Label _ "<-" { return { type: 'EDGE', name, label: type, direction: 'in' } }
  / "-[" _ ":" _ type:Label _ "<-" { return { type: 'EDGE', name: null, label: type, direction: 'in' } }
  / "-->" { return { type: 'EDGE', name: null, label: null, direction: 'out' } }
  / "-" _ name:Identifier _ "->" { return { type: 'EDGE', name: null, label: null, direction: 'out' } }

// ── WHERE ──────────────────────────────────────────────────

WhereClause
  = _ "WHERE"i _ expr:OrExpression { return { type: 'WHERE', expression: expr } }

// ── RETURN ──────────────────────────────────────────────────

ReturnClause
  = _ "RETURN"i _ agg:AggregateFunc _ {
      const field = agg.field ? agg.field.join('.') : undefined
      const aggregateClause = { type: agg.func, field, alias: agg.alias }
      return { type: 'RETURN', columns: [], aggregate: aggregateClause }
    }
  / _ "RETURN"i _ cols:ColumnList _ { return { type: 'RETURN', columns: cols } }

AggregateFunc
  = func:(CountFunc / SumFunc / AvgFunc / MaxFunc / MinFunc) { return func }

CountFunc
  = "count"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'count', field: [name, prop], alias }
    }
  / "count"i _ "(" _ "*" _ ")" alias:AsClause? {
      return { func: 'count', field: ['*'], alias }
    }
  / "count"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'count', field: [name], alias }
    }

SumFunc
  = "sum"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'sum', field: [name, prop], alias }
    }
  / "sum"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'sum', field: [name], alias }
    }

AvgFunc
  = "avg"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'avg', field: [name, prop], alias }
    }
  / "avg"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'avg', field: [name], alias }
    }

MaxFunc
  = "max"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'max', field: [name, prop], alias }
    }
  / "max"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'max', field: [name], alias }
    }

MinFunc
  = "min"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'min', field: [name, prop], alias }
    }
  / "min"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'min', field: [name], alias }
    }

// ── GROUP BY ────────────────────────────────────────────────

GroupByClause
  = _ "GROUP"i _ "BY"i _ cols:GroupByList { return cols }

GroupByList
  = head:GroupByColumn tail:(_ "," _ GroupByColumn)* {
      return [head, ...tail.map(t => t[3])]
    }

GroupByColumn
  = ref:PropertyRef { return ref }
  / name:Identifier { return { type: 'IDENTIFIER', name } }

ColumnList
  = head:Column tail:(_ "," _ Column)* {
      return [head, ...tail.map(t => t[3])]
    }

Column
  = agg:AggregateFunc {
      const field = agg.field ? agg.field.join('.') : undefined
      return {
        type: 'AGGREGATE_COLUMN',
        expression: { type: 'AGGREGATE', func: agg.func, field },
        alias: agg.alias,
      }
    }
  / expr:PropertyRef alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: expr,
        alias: alias,
      }
    }
  / name:Identifier alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: { type: 'IDENTIFIER', name },
        alias: alias,
      }
    }

AsClause
  = _ "AS"i _ name:Identifier { return name }

PropertyRef
  = name:Identifier "." prop:Identifier {
      return { type: 'PROP_REF', name, property: prop }
    }

// ── ORDER BY ──────────────────────────────────────────────

OrderByClause
  = _ "ORDER"i _ "BY"i _ cols:OrderColumnList { return { type: 'ORDER_BY', columns: cols } }

OrderColumnList
  = head:OrderColumn tail:(_ "," _ OrderColumn)* {
      return [head, ...tail.map(t => t[3])]
    }

OrderColumn
  = ref:PropertyRef dir:DirClause? {
      return {
        type: 'ORDER_COLUMN',
        expression: ref,
        direction: dir ? dir : 'ASC',
      }
    }
  / name:Identifier dir:DirClause? {
      return {
        type: 'ORDER_COLUMN',
        expression: { type: 'IDENTIFIER', name },
        direction: dir ? dir : 'ASC',
      }
    }

DirClause
  = _ dir:("ASC"i / "DESC"i) { return dir.toUpperCase() }

// ── UNION / INTERSECT / SUBTRACT ────────────────────────────

UnionClause
  = _ "UNION"i _ "ALL"i _ right:MatchStatement {
      return { unionType: 'union_all', rightQuery: right }
    }
  / _ "UNION"i _ right:MatchStatement {
      return { unionType: 'union', rightQuery: right }
    }
  / _ "INTERSECT"i _ right:MatchStatement {
      return { unionType: 'intersect', rightQuery: right }
    }
  / _ "SUBTRACT"i _ right:MatchStatement {
      return { unionType: 'subtract', rightQuery: right }
    }

// ── LIMIT / SKIP（任意顺序）──────────────────────────────────

LimitSkipClause
  = first:SKIP_AND_LIMIT { return { limit: first.limit, skip: first.skip } }
  / first:LIMIT_AND_SKIP { return { limit: first.limit, skip: first.skip } }

SKIP_AND_LIMIT
  = _ "SKIP"i _ skipVal:Integer _ "LIMIT"i _ limitVal:Integer { return { limit: limitVal, skip: skipVal } }
  / _ "SKIP"i _ skipVal:Integer { return { limit: undefined, skip: skipVal } }

LIMIT_AND_SKIP
  = _ "LIMIT"i _ limitVal:Integer _ "SKIP"i _ skipVal:Integer { return { limit: limitVal, skip: skipVal } }
  / _ "LIMIT"i _ limitVal:Integer { return { limit: limitVal, skip: undefined } }

// ── 表达式──────────────────────────────────────────────────

OrExpression
  = head:AndExpression tail:(_ "OR"i _ AndExpression)* {
      if (tail.length === 0) return head
      return { type: 'OR', left: head, right: tail.length === 1 ? tail[0][3] : tail.map(t => t[3]) }
    }

AndExpression
  = head:Comparison tail:(_ "AND"i _ Comparison)* {
      if (tail.length === 0) return head
      return { type: 'AND', left: head, right: tail.length === 1 ? tail[0][3] : tail.map(t => t[3]) }
    }

Comparison
  = lhs:Primary _ op:ComparisonOp _ rhs:Primary {
      return { type: 'COMPARISON', operator: op, left: lhs, right: rhs }
    }
  / Primary

ComparisonOp
  = ">=" { return 'GTE' }
  / "<=" { return 'LTE' }
  / "<>" { return 'NEQ' }
  / "!=" { return 'NEQ' }
  / "="  { return 'EQ' }
  / ">"  { return 'GT' }
  / "<"  { return 'LT' }

Primary
  = PropertyRef
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / Identifier
  / "(" _ expr:OrExpression _ ")" { return expr }

// ── 基础词法 ──────────────────────────────────────────────

Label
  = chars:[_a-zA-Z0-9]+ { return text() }

Identifier
  = chars:[_a-zA-Z][_a-zA-Z0-9]* { return text() }

StringLiteral
  = "'" chars:[^']* "'" { return { type: 'STRING', value: text().slice(1, -1) } }
  / '"' chars:[^"]* '"' { return { type: 'STRING', value: text().slice(1, -1) } }

NumberLiteral
  = val:Integer "." frac:[0-9]+ { return { type: 'NUMBER', value: parseFloat(text()) } }
  / val:Integer { return { type: 'NUMBER', value: val } }

BooleanLiteral
  = "true"i  { return { type: 'BOOLEAN', value: true } }
  / "false"i { return { type: 'BOOLEAN', value: false } }

Integer "integer"
  = digits:[0-9]+ { return parseInt(text(), 10) }

// ── 属性映射 ──────────────────────────────────────────────

PropertyMap
  = "{" _ head:PropertyEntry tail:(_ "," _ PropertyEntry)* _ "}" {
      const map = {}
      map[head.key] = head.value
      for (const t of tail) {
        map[t[3].key] = t[3].value
      }
      return map
    }

PropertyEntry
  = key:Identifier _ ":" _ val:Primary { return { key, value: val } }

// ── 空白与注释 ──────────────────────────────────────────

_ "whitespace"
  = [ \t\n\r]*
