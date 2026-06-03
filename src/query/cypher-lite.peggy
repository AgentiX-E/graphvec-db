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
 *   OPTIONAL MATCH (a)-[:TYPE]->(b) RETURN a, b
 *   WITH expr1 AS alias1, expr2 AS alias2 [ORDER BY ...] [LIMIT n] [SKIP n] WHERE condition
 *   UNWIND [a, b, c] AS x RETURN x
 *
 * 不实现（Cypher-lite 边界）：
 *   FOREACH / CALL / 子查询
 *   聚合函数 / UNION 已实现
 */

Start
  = _ stmt:DMLStatement _ { return stmt }
  / _ stmt:CallProcedureStatement _ { return stmt }
  / _ stmt:CallStatement _ { return stmt }
  / _ stmt:MatchStatement _ { return stmt }
  / _ stmt:UnwindStatement _ { return stmt }
  / _ stmt:WithStatement _ { return stmt }

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
  = optionalClauses:OptionalMatchClauseList? matchClause:MatchClause whereClause:WhereClause? withClause:WithClause? unwindClause:UnwindClause? returnClause:ReturnClause groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: whereClause,
        return: returnClause,
        groupBy: groupByClause ? groupByClause.columns : null,
        having: groupByClause ? groupByClause.having : null,
        orderBy: orderByClause,
        limit: limitSkip ? limitSkip.limit : undefined,
        skip: limitSkip ? limitSkip.skip : undefined,
      }
      if (optionalClauses && optionalClauses.length > 0) {
        stmt.optionalMatches = optionalClauses
      }
      if (withClause) {
        stmt.with = withClause
      }
      if (unwindClause) {
        stmt.unwind = unwindClause
      }
      if (unionClause) {
        stmt.unionType = unionClause.unionType
        stmt.rightQuery = unionClause.rightQuery
      }
      return stmt
    }
  / matchClause:MatchClause optionalClauses:OptionalMatchClauseList whereClause:WhereClause? withClause:WithClause? unwindClause:UnwindClause? returnClause:ReturnClause groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
      // MATCH followed by OPTIONAL MATCH (e.g., MATCH (a) OPTIONAL MATCH (a)-[:KNOWS]->(b))
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: whereClause,
        return: returnClause,
        groupBy: groupByClause ? groupByClause.columns : null,
        having: groupByClause ? groupByClause.having : null,
        orderBy: orderByClause,
        limit: limitSkip ? limitSkip.limit : undefined,
        skip: limitSkip ? limitSkip.skip : undefined,
      }
      if (optionalClauses && optionalClauses.length > 0) {
        stmt.optionalMatches = optionalClauses
      }
      if (withClause) {
        stmt.with = withClause
      }
      if (unwindClause) {
        stmt.unwind = unwindClause
      }
      if (unionClause) {
        stmt.unionType = unionClause.unionType
        stmt.rightQuery = unionClause.rightQuery
      }
      return stmt
    }
  / matchClause:MatchClause whereClause:WhereClause? withClause:WithClause? unwindClause:UnwindClause? returnClause:ReturnClause groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: whereClause,
        return: returnClause,
        groupBy: groupByClause ? groupByClause.columns : null,
        having: groupByClause ? groupByClause.having : null,
        orderBy: orderByClause,
        limit: limitSkip ? limitSkip.limit : undefined,
        skip: limitSkip ? limitSkip.skip : undefined,
      }
      if (withClause) {
        stmt.with = withClause
      }
      if (unwindClause) {
        stmt.unwind = unwindClause
      }
      if (unionClause) {
        stmt.unionType = unionClause.unionType
        stmt.rightQuery = unionClause.rightQuery
      }
      return stmt
    }
  / optionalClauses:OptionalMatchClauseList? withClause:WithClause? unwindClause:UnwindClause? returnClause:ReturnClause groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
      // Standalone WITH or OPTIONAL MATCH without MATCH
      const stmt = {
        type: 'QUERY',
        match: null,
        return: returnClause,
        groupBy: groupByClause ? groupByClause.columns : null,
        having: groupByClause ? groupByClause.having : null,
        orderBy: orderByClause,
        limit: limitSkip ? limitSkip.limit : undefined,
        skip: limitSkip ? limitSkip.skip : undefined,
      }
      if (optionalClauses && optionalClauses.length > 0) {
        stmt.optionalMatches = optionalClauses
      }
      if (withClause) {
        stmt.with = withClause
      }
      if (unwindClause) {
        stmt.unwind = unwindClause
      }
      if (unionClause) {
        stmt.unionType = unionClause.unionType
        stmt.rightQuery = unionClause.rightQuery
      }
      return stmt
    }

// ── OPTIONAL MATCH ─────────────────────────────────────────

OptionalMatchClauseList
  = head:OptionalMatchClause tail:(_ OptionalMatchClause)* {
      return [head, ...tail.map(t => t[1])]
    }

OptionalMatchClause
  = _ "OPTIONAL"i _ m:MatchClause w:WhereClause? {
      const result = {
        type: 'OPTIONAL_MATCH',
        patterns: m.patterns,
      }
      if (w) {
        result.where = w
      }
      return result
    }

// ── WITH ───────────────────────────────────────────────────

WithClause
  = _ "WITH"i _ columns:ColumnList
    where:WithWhereClause?
    orderBy:WithOrderByClause?
    limitSkip:WithLimitSkip? {
      const result = {
        type: 'WITH',
        columns: columns,
      }
      if (where) result.where = where
      if (orderBy) result.orderBy = orderBy
      if (limitSkip) {
        if (limitSkip.limit !== undefined) result.limit = limitSkip.limit
        if (limitSkip.skip !== undefined) result.skip = limitSkip.skip
      }

      // Detect aggregate functions in WITH columns
      let foundAggregate = null
      for (const col of columns) {
        if (col.type === 'AGGREGATE_COLUMN' && col.expression?.type === 'AGGREGATE') {
          const func = String(col.expression.func ?? '')
          const field = String(col.expression.field ?? '')
          const alias = col.alias
          foundAggregate = { type: func, field, alias }
        }
      }
      if (foundAggregate) {
        result.aggregate = foundAggregate
      }

      return result
    }

WithLimitSkip
  = first:LIMIT_AND_SKIP_IN_WITH { return { limit: first.limit, skip: first.skip } }
  / first:SKIP_AND_LIMIT_IN_WITH { return { limit: first.limit, skip: first.skip } }

LIMIT_AND_SKIP_IN_WITH
  = _ "LIMIT"i _ limitVal:Integer _ "SKIP"i _ skipVal:Integer { return { limit: limitVal, skip: skipVal } }
  / _ "LIMIT"i _ limitVal:Integer { return { limit: limitVal, skip: undefined } }

SKIP_AND_LIMIT_IN_WITH
  = _ "SKIP"i _ skipVal:Integer _ "LIMIT"i _ limitVal:Integer { return { limit: limitVal, skip: skipVal } }
  / _ "SKIP"i _ skipVal:Integer { return { limit: undefined, skip: skipVal } }

WithWhereClause
  = _ "WHERE"i _ expr:OrExpression { return { type: 'WHERE', expression: expr } }

WithOrderByClause
  = _ "ORDER"i _ "BY"i _ columns:WithOrderColumnList { return { type: 'ORDER_BY', columns: columns } }

WithOrderColumnList
  = head:WithOrderColumn tail:(_ "," _ WithOrderColumn)* {
      return [head, ...tail.map(t => t[3])]
    }

WithOrderColumn
  = expr:Primary dir:(_ "ASC"i / _ "DESC"i)? {
      return { type: 'ORDER_COLUMN', expression: expr, direction: dir ? dir[1].toUpperCase() : 'ASC' }
    }

// ── UNWIND ─────────────────────────────────────────────────

UnwindStatement
  = u:UnwindClause r:ReturnClause? {
      const result = {
        type: 'QUERY',
        unwind: u,
        return: r,
      }
      return result
    }

WithStatement
  = w:WithClause u:UnwindClause? r:ReturnClause? {
      const result = {
        type: 'QUERY',
        with: w,
        return: r,
      }
      if (u) result.unwind = u
      return result
    }

UnwindClause
  = _ "UNWIND"i _ list:UnwindList _ "AS"i _ name:Identifier {
      return { type: 'UNWIND', list, name }
    }
  / _ "UNWIND"i _ varName:Identifier _ "AS"i _ name:Identifier {
      return { type: 'UNWIND', var: varName, name }
    }

UnwindList
  = head:ListLiteral { return head.items }

UnwindItemList
  = head:UnwindItem tail:(_ "," _ UnwindItem)* {
      return [head, ...tail.map(t => t[3])]
    }

UnwindItem
  = v:UnwindValue { return v }
  / id:Identifier { return { type: 'IDENTIFIER', name: id } }

UnwindValue
  = s:StringLiteral { return s }
  / n:NumberLiteral { return n }
  / "true"i { return { type: 'BOOLEAN', value: true } }
  / "false"i { return { type: 'BOOLEAN', value: false } }
  / "null"i { return { type: 'IDENTIFIER', name: 'null' } }

// ── 列表字面量 ────────────────────────────────────────────

ListLiteral
  = "[" _ items:ListItemList? _ "]" {
      return { type: 'LIST', items: items || [] }
    }

ListItemList
  = head:ListItem tail:(_ "," _ ListItem)* {
      return [head, ...tail.map(t => t[3])]
    }

ListItem
  = v:UnwindValue { return v }
  / id:Identifier { return { type: 'IDENTIFIER', name: id } }

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
  = _ "DETACH"i _ "DELETE"i _ targets:IdentifierList {
      return { type: 'DELETE', targets, detach: true }
    }
  / _ "DELETE"i _ targets:IdentifierList {
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
  = _ "MERGE"i _ patterns:CreatePatternList onCreate:OnCreateSetClause? onMatch:OnMatchSetClause? {
      const result = { type: 'MERGE', patterns: patterns }
      if (onCreate) result.onCreate = onCreate
      if (onMatch) result.onMatch = onMatch
      return result
    }

OnCreateSetClause
  = _ "ON"i _ "CREATE"i _ "SET"i _ items:SetItemList {
      return { type: 'ON_CREATE', items }
    }

OnMatchSetClause
  = _ "ON"i _ "MATCH"i _ "SET"i _ items:SetItemList {
      return { type: 'ON_MATCH', items }
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
  = func:(CountFunc / SumFunc / AvgFunc / MaxFunc / MinFunc / CollectFunc) { return func }

CollectFunc
  = "collect"i _ "(" _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'collect', field: [name, prop], alias }
    }
  / "collect"i _ "(" _ "DISTINCT"i _ name:Identifier _ "." _ prop:Identifier _ ")" alias:AsClause? {
      return { func: 'collect', field: [name, prop], alias, distinct: true }
    }
  / "collect"i _ "(" _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'collect', field: [name], alias }
    }
  / "collect"i _ "(" _ "DISTINCT"i _ name:Identifier _ ")" alias:AsClause? {
      return { func: 'collect', field: [name], alias, distinct: true }
    }

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
  = _ "GROUP"i _ "BY"i _ cols:GroupByList having:HavingClause? {
      return { columns: cols, having: having ?? null }
    }

HavingClause
  = _ "HAVING"i _ expr:OrExpression { return { type: 'HAVING', expression: expr } }

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
  / expr:FunctionCall alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: expr,
        alias: alias,
      }
    }
  / expr:CaseExpression alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: expr,
        alias: alias,
      }
    }
  / expr:PropertyRef alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: expr,
        alias: alias,
      }
    }
  / list:UnwindList alias:AsClause? {
      return {
        type: 'COLUMN',
        expression: { type: 'LIST', items: list },
        alias: alias,
      }
    }
  / expr:PatternComprehension alias:AsClause? {
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
  / func:FunctionCall dir:DirClause? {
      return {
        type: 'ORDER_COLUMN',
        expression: func,
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
  / lhs:Primary _ "IN"i _ rhs:(ListLiteral / Primary) {
      return { type: 'IN_EXPRESSION', left: lhs, list: rhs }
    }
  / lhs:Primary _ op:StringPredicateOp _ rhs:(StringLiteral / PropertyRef) {
      return { type: 'STRING_PREDICATE', operator: op, left: lhs, right: rhs }
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

StringPredicateOp
  = "STARTS WITH"i { return 'STARTS_WITH' }
  / "ENDS WITH"i { return 'ENDS_WITH' }
  / "CONTAINS"i  { return 'CONTAINS' }

Primary
  = PatternComprehension
  / FunctionCall
  / ExistsExpression
  / CaseExpression
  / ParameterRef
  / PropertyRef
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / Identifier
  / "(" _ expr:OrExpression _ ")" { return expr }

// ── 参数引用 ──────────────────────────────────────────────

ParameterRef
  = "$" name:Identifier { return { type: 'PARAM', name: name } }
  / "$" digits:[0-9]+ { return { type: 'PARAM', name: digits.join('') } }

// ── 模式推导 / Pattern Comprehension ──────────────────────

PatternComprehension
  = "[" _ fromNode:NodePattern _ edge:EdgePattern _ targetNode:NodePattern _ where:(_ "WHERE"i _ cond:OrExpression { return { type: 'WHERE', expression: cond } })? _ "|" _ project:Primary _ "]" {
      return {
        type: 'PATTERN_COMPREHENSION',
        fromNode,
        edge,
        targetNode,
        where: where ? where.expression : null,
        project,
      }
    }

// ── 内置函数调用 ──────────────────────────────────────────

FunctionCall
  = name:Identifier _ "(" _ args:FunctionArgList? _ ")" {
      return {
        type: 'FUNCTION_CALL',
        name: name,
        args: args ?? [],
      }
    }

FunctionArgList
  = head:Primary tail:(_ "," _ Primary)* {
      return [head, ...tail.map(t => t[3])]
    }

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

// ── EXISTS 子查询 ──────────────────────────────────────────

ExistsExpression
  = "EXISTS"i _ "{" _ pattern:ExistsPattern _ "}" {
      return {
        type: 'EXISTS',
        source: pattern.source,
        edgeLabel: pattern.edgeLabel,
        direction: pattern.direction,
        target: pattern.target,
      }
    }

ExistsPattern
  = "(" _ sourceName:Identifier _ ")" _ edge:ExistsEdge? _ "(" _ targetName:Identifier _ ")" {
      return {
        source: sourceName,
        edgeLabel: edge ? edge.label : null,
        direction: edge ? edge.direction : 'any',
        target: targetName,
      }
    }

ExistsEdge
  = "-[" _ label:ExistsEdgeLabel _ "]->" {
      return {
        label: label,
        direction: 'out',
      }
    }
  / "<-[" _ label:ExistsEdgeLabel _ "]-" {
      return {
        label: label,
        direction: 'in',
      }
    }
  / "-[" _ label:ExistsEdgeLabel _ "]-" {
      return {
        label: label,
        direction: 'any',
      }
    }
  / "-->" {
      return { label: null, direction: 'out' }
    }
  / "<--" {
      return { label: null, direction: 'in' }
    }
  / "--" {
      return { label: null, direction: 'any' }
    }

ExistsEdgeLabel
  = ":" name:Identifier { return name }
  / "" { return null }

// ── CASE / WHEN / THEN / ELSE ────────────────────────────

CaseExpression
  = "CASE"i _ expr:Primary _ whenList:CaseWhenList elseClause:CaseElseClause? _ "END"i {
      return {
        type: 'CASE',
        caseExpr: expr,
        whens: whenList,
        elseExpr: elseClause || null,
      }
    }
  / "CASE"i _ whenList:CaseWhenList elseClause:CaseElseClause? _ "END"i {
      return {
        type: 'CASE',
        caseExpr: null,  // search CASE (no initial expression)
        whens: whenList,
        elseExpr: elseClause || null,
      }
    }

CaseWhenList
  = head:CaseWhenClause tail:(_ CaseWhenClause)* {
      return [head, ...tail.map(t => t[1])]
    }

CaseWhenClause
  = "WHEN"i _ cond:OrExpression _ "THEN"i _ result:Primary {
      return { condition: cond, result }
    }

CaseElseClause
  = _ "ELSE"i _ result:Primary { return result }

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

// ── CALL 子查询 ──────────────────────────────────────────

CallStatement
  = "CALL"i _ "{" _ subq:MatchStatement _ "}" _ tx:InTransactionsClause? _ rc:ReturnClause? _ ob:OrderByClause? _ ls:LimitSkipClause? {
      const stmt = {
        type: 'CALL',
        query: subq,
      }
      if (tx) {
        stmt.inTransactions = true
        if (tx.batchSize !== undefined) {
          stmt.inTransactionsBatchSize = tx.batchSize
        }
      }
      if (rc) stmt.return = rc
      if (ob) stmt.orderBy = ob
      if (ls) {
        stmt.limit = ls.limit
        stmt.skip = ls.skip
      }
      return stmt
    }

InTransactionsClause
  = "IN"i _ "TRANSACTIONS"i _ "OF"i _ size:Integer _ "ROWS"i {
      return { batchSize: size }
    }
  / "IN"i _ "TRANSACTIONS"i {
      return { batchSize: undefined }
    }

// ── CALL 过程调用 ────────────────────────────────────────
// 例如: CALL db.labels() YIELD label
// 例如: CALL db.index.fulltext.queryNodes("idx_name", "search_term") YIELD node, score

CallProcedureStatement
  = "CALL"i _ name:ProcedureName _ "(" _ args:ProcedureArgList? _ ")" _ yc:YieldClause? _ ob:OrderByClause? _ ls:LimitSkipClause? {
      const stmt = {
        type: 'CALL_PROCEDURE',
        procedureName: name,
        arguments: args ?? [],
      }
      if (yc) stmt.yield = yc
      if (ob) stmt.orderBy = ob
      if (ls) {
        stmt.limit = ls.limit
        stmt.skip = ls.skip
      }
      return stmt
    }

ProcedureName
  = head:Identifier tail:(_ "." _ Identifier)* {
      return [head, ...tail.map(t => t[3])].join('.')
    }

ProcedureArgList
  = head:ProcedureArg tail:(_ "," _ ProcedureArg)* {
      return [head, ...tail.map(t => t[3])]
    }

ProcedureArg
  = StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / ListLiteral
  / Identifier { return { type: 'IDENTIFIER', name: text() } }

YieldClause
  = _ "YIELD"i _ items:YieldItemList _ ob:OrderByClause? _ ls:LimitSkipClause? {
      const result = { type: 'YIELD', items: items }
      if (ob) result.orderBy = ob
      if (ls) { result.limit = ls.limit; result.skip = ls.skip }
      return result
    }

YieldItemList
  = head:YieldItem tail:(_ "," _ YieldItem)* {
      return [head, ...tail.map(t => t[3])]
    }

YieldItem
  = name:Identifier _ alias:(_ "AS"i _ Identifier)? {
      return { name: name, alias: alias ? alias[3] : null }
    }

// ── 空白与注释 ──────────────────────────────────────────

_ "whitespace"
  = [ \t\n\r]*
