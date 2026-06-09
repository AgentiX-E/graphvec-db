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
 *   MATCH (n) SET n.name = "val", n.age = 30
 *   MATCH (n) REMOVE n.name
 *   MATCH (n) REMOVE n:Person
 *   MATCH (n) SET n.name = "val" REMOVE n.label
 *   WHERE n.name IS NULL
 *   WHERE n.age IS NOT NULL
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
  = _ hint:PeriodicCommitHint? _ stmt:(ExplainStatement / ShowStatement / DropConstraintStatement / ConstraintRule / UseStatement / DMLStatement / CallProcedureStatement / CallStatement / MatchStatement / UnwindStatement / WithStatement / TransactionStatement / ForEachStatement / CreateIndexStatement / DropIndexStatement / LoadCsvStatement) _ {
      if (hint) {
        stmt.periodicCommitHint = hint
      }
      return stmt
    }

// ── PERIODIC COMMIT 提示 ──────────────────────────────

PeriodicCommitHint
  = "USING"i _ "PERIODIC"i _ "COMMIT"i _ size:Integer {
      return { type: 'PERIODIC_COMMIT_HINT', batchSize: size }
    }
  / "USING"i _ "PERIODIC"i _ "COMMIT"i {
      return { type: 'PERIODIC_COMMIT_HINT', batchSize: undefined }
    }

// ── SHOW 元数据 ──────────────────────────────────────────

ShowStatement
  = "SHOW"i _ kind:ShowKind {
      return { type: 'SHOW', show: kind }
    }

ShowKind
  = "CONSTRAINTS"i { return 'constraints' }
  / "INDEXES"i { return 'indexes' }
  / "PROCEDURES"i { return 'procedures' }
  / "FUNCTIONS"i { return 'functions' }
  / "LABELS"i { return 'labels' }
  / "RELATIONSHIPTYPES"i { return 'relationshiptypes' }
  / "SCHEMA"i { return 'schema' }

// ── EXPLAIN / PROFILE / DESCRIBE ────────────────────────────

ExplainStatement
  = ("EXPLAIN"i / "PROFILE"i / "DESCRIBE"i) _ query:Start {
      return {
        type: 'EXPLAIN',
        explainMode: text().match(/^EXPLAIN/i) ? 'text' :
                     text().match(/^PROFILE/i) ? 'profile' :
                     text().match(/^DESCRIBE/i) ? 'describe' : 'text',
        innerStatement: query,
      }
    }

// ── DROP CONSTRAINT ──────────────────────────────────────────

DropConstraintStatement
  = "DROP"i _ "CONSTRAINT"i _ "ON"i _ "(" _ name:Identifier ":" label:LabelName _ ")" _ "ASSERT"i _ prop:PropertyRef _ "IS"i _ "UNIQUE"i {
      return { type: 'DROP_CONSTRAINT', label: label, property: prop.property }
    }

// ── CREATE CONSTRAINT ──────────────────────────────────

ConstraintRule
  = "CREATE"i _ "CONSTRAINT"i _ "ON"i _ "(" _ name:Identifier ":" label:LabelName _ ")" _ "ASSERT"i _ prop:PropertyRef _ "IS"i _ "UNIQUE"i {
      return { type: 'CREATE_CONSTRAINT', label: label, property: prop.property }
    }

// ── USE 语句 ────────────────────────────────────────────

UseStatement
  = "USE"i _ name:Identifier {
      return { type: 'USE', name }
    }

// ── CREATE INDEX / DROP INDEX ──────────────────────────

CreateIndexStatement
  = "CREATE"i _ "INDEX"i _ "ON"i _ ":" label:LabelName "(" prop:PropertyName ")" {
      return { type: 'CREATE_INDEX', label, property: prop }
    }

DropIndexStatement
  = "DROP"i _ "INDEX"i _ "ON"i _ ":" label:LabelName "(" prop:PropertyName ")" {
      return { type: 'DROP_INDEX', label, property: prop }
    }

// ── 顶级语句 ───────────────────────────────────────────

DMLStatement
  = createClause:CreateClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', create: createClause }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / matchClause:MatchClause deleteClause:DeleteClause limitSkip:LimitSkipClause? returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, delete: deleteClause }
      if (limitSkip) { stmt.limit = limitSkip.limit; stmt.skip = limitSkip.skip }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / matchClause:MatchClause deleteClause:DeleteClause deleteLimitSkip:LimitSkipClause? {
      const stmt = { type: 'QUERY', match: matchClause, delete: deleteClause }
      if (deleteLimitSkip) { stmt.limit = deleteLimitSkip.limit; stmt.skip = deleteLimitSkip.skip }
      return stmt
    }
  / matchClause:MatchClause setClause:SetClause removeClause:RemoveClause? returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, set: setClause }
      if (removeClause) stmt.remove = removeClause
      if (returnClause) stmt.return = returnClause
      return stmt
    }
  / matchClause:MatchClause removeClause:RemoveClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, remove: removeClause }
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
  // ── FOREACH ───────────────────────────────────────────
  / forEachClause:ForEachClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', forEach: forEachClause }
      if (returnClause) stmt.return = returnClause
      return stmt
    }
  / matchClause:MatchClause whereClause:WhereClause? forEachClause:ForEachClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, forEach: forEachClause }
      if (whereClause) stmt.where = whereClause
      if (returnClause) stmt.return = returnClause
      return stmt
    }

MatchStatement
  = optionalClauses:OptionalMatchClauseList? matchClause:MatchClause whereClause:WhereClause? withClause:WithClause? unwindClause:UnwindClause? forEachClause:ForEachClause? returnClause:ReturnClause? groupByClause:GroupByClause? orderByClause:OrderByClause? limitSkip:LimitSkipClause? unionClause:UnionClause? {
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
            if (forEachClause) {
        stmt.forEach = forEachClause
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
  // ── 复合 MATCH + CREATE + SET + REMOVE + RETURN ─────
  / matchClause:MatchClause where:WhereClause? createClause:CreateClause setClause:SetClause removeClause:RemoveClause? returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        create: createClause,
        set: setClause,
      }
      if (removeClause) {
        stmt.remove = removeClause
      }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  // ── 复合 MATCH + CREATE + REMOVE + RETURN ────────────
  / matchClause:MatchClause where:WhereClause? createClause:CreateClause removeClause:RemoveClause returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        create: createClause,
        remove: removeClause,
      }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  // ── 复合 MATCH + SET + REMOVE + RETURN ───────────────
  / matchClause:MatchClause where:WhereClause? setClause:SetClause removeClause:RemoveClause? returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        set: setClause,
      }
      if (removeClause) {
        stmt.remove = removeClause
      }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  // ── 复合 MATCH + WHERE + DELETE + RETURN ─────────────
  / matchClause:MatchClause where:WhereClause? deleteClause:DeleteClause limitSkip:LimitSkipClause? orderByClause:OrderByClause? returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        delete: deleteClause,
      }
      if (limitSkip) { stmt.limit = limitSkip.limit; stmt.skip = limitSkip.skip }
      if (orderByClause) stmt.orderBy = orderByClause
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  / matchClause:MatchClause where:WhereClause? deleteClause:DeleteClause limitSkip:LimitSkipClause? returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        delete: deleteClause,
      }
      if (limitSkip) { stmt.limit = limitSkip.limit; stmt.skip = limitSkip.skip }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  // ── 复合 MATCH + WHERE + CREATE + RETURN ─────────────
  / matchClause:MatchClause where:WhereClause? optionalClauses:OptionalMatchClauseList? createClause:CreateClause returnClause:ReturnClause? {
      const stmt = {
        type: 'QUERY',
        match: matchClause,
        where: where,
        create: createClause,
      }
      if (optionalClauses && optionalClauses.length > 0) {
        stmt.optionalMatches = optionalClauses
      }
      if (returnClause) {
        stmt.return = returnClause
      }
      return stmt
    }
  // ── 子查询用 (MATCH + WHERE, 无 RETURN) ──────────────
  / matchClause:MatchClause whereClause:WhereClause? {
      const stmt = { type: 'QUERY', match: matchClause }
      if (whereClause) { stmt.where = whereClause }
      return stmt
    }
  // ── MATCH + FOREACH ───────────────────────────────────
  / matchClause:MatchClause whereClause:WhereClause? forEachClause:ForEachClause returnClause:ReturnClause? {
      const stmt = { type: 'QUERY', match: matchClause, forEach: forEachClause }
      if (whereClause) stmt.where = whereClause
      if (returnClause) stmt.return = returnClause
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
  = u:UnwindClause whereClause:WhereClause returnClause:ReturnClause orderByClause:OrderByClause? limitSkip:LimitSkipClause? {
      return { type: 'QUERY', unwind: u, where: whereClause, return: returnClause, orderBy: orderByClause, limit: limitSkip?.limit, skip: limitSkip?.skip }
    }
  / u:UnwindClause matchClause:MatchClause whereClause:WhereClause? returnClause:ReturnClause orderByClause:OrderByClause? limitSkip:LimitSkipClause? {
      return { type: 'QUERY', unwind: u, match: matchClause, where: whereClause, return: returnClause, orderBy: orderByClause, limit: limitSkip?.limit, skip: limitSkip?.skip }
    }
  / u:UnwindClause matchClause:MatchClause returnClause:ReturnClause orderByClause:OrderByClause? limitSkip:LimitSkipClause? {
      return { type: 'QUERY', unwind: u, match: matchClause, return: returnClause, orderBy: orderByClause, limit: limitSkip?.limit, skip: limitSkip?.skip }
    }
  / u:UnwindClause createClause:CreateClause returnClause:ReturnClause? {
      return { type: 'QUERY', unwind: u, create: createClause, return: returnClause }
    }
  / u:UnwindClause r:ReturnClause? {
      return { type: 'QUERY', unwind: u, return: r }
    }

// ── 事务语句 (BEGIN / COMMIT / ROLLBACK) ───────────────────

TransactionStatement
  = _ "BEGIN"i _ { return { type: 'BEGIN' } }
  / _ "COMMIT"i _ { return { type: 'COMMIT' } }
  / _ "ROLLBACK"i _ { return { type: 'ROLLBACK' } }

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
  / pc:PatternComprehension { return pc }
  / fc:FunctionCall { return [fc] }

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

// ── REMOVE ─────────────────────────────────────────────────

RemoveClause
  = _ "REMOVE"i _ items:RemoveItemList {
      return { type: 'REMOVE', items }
    }

RemoveItemList
  = head:RemoveItem tail:(_ "," _ RemoveItem)* {
      return [head, ...tail.map(t => t[3])]
    }

RemoveItem
  = prop:PropertyRef { return { type: 'REMOVE_PROP', property: prop.name, name: prop.property } }
  / ref:Identifier ":" label:LabelName { return { type: 'REMOVE_LABEL', ref: ref, label: label } }

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
  = _ "MATCH"i _ name:Identifier _ "=" _ pattern:PathPattern {
      const m = { type: 'MATCH', patterns: [pattern] }
      return m
    }
  / _ "MATCH"i _ patterns:PatternList { return { type: 'MATCH', patterns } }

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
  / '*' '..' max:Integer { return { min: null, max } }
  / '*' min:Integer '..' { return { min, max: null } }
  / '*' exact:Integer !'.' { return { min: exact, max: exact } }

// ── 节点模式 ─────────────────────────────────────────────

NodePattern
  = "(" _ ")" { return { type: 'NODE', name: null, label: null, labelExpr: null, props: null } }
  / "(" _ expr:LabelExpression _ ")" {
      return { type: 'NODE', name: null, label: null, labelExpr: expr, props: null }
    }
  / "(" _ props:PropertyMap _ ")" {
      return { type: 'NODE', name: null, label: null, labelExpr: null, props }
    }
  / "(" _ expr:LabelExpression _ props:PropertyMap _ ")" {
      return { type: 'NODE', name: null, label: null, labelExpr: expr, props }
    }
  / "(" _ name:Identifier _ ")" { return { type: 'NODE', name, label: null, labelExpr: null, props: null } }
  / "(" _ name:Identifier _ expr:LabelExpression _ ")" {
      return { type: 'NODE', name, label: null, labelExpr: expr, props: null }
    }
  / "(" _ name:Identifier _ props:PropertyMap _ ")" {
      return { type: 'NODE', name, label: null, labelExpr: null, props }
    }
  / "(" _ name:Identifier _ expr:LabelExpression _ props:PropertyMap _ ")" {
      return { type: 'NODE', name, label: null, labelExpr: expr, props }
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
  / "-[" _ name:Identifier _ "]-" { return { type: 'EDGE', name, label: null, direction: 'any' } }
  / "-[]-" { return { type: 'EDGE', name: null, label: null, direction: 'any' } }
  / "--" { return { type: 'EDGE', name: null, label: null, direction: 'any' } }

// ── WHERE ──────────────────────────────────────────────────

WhereClause
  = _ "WHERE"i _ expr:OrExpression { return { type: 'WHERE', expression: expr } }

// ── RETURN ──────────────────────────────────────────────────

ReturnClause
  = _ "RETURN"i _ "DISTINCT"i _ cols:ColumnList _ {
      return { type: 'RETURN', columns: cols, distinct: true }
    }
  / _ "RETURN"i _ agg:AggregateFunc _ {
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
  / expr:Additive alias:AsClause? {
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

AsClause
  = _ "AS"i _ name:Identifier { return name }

PropertyRef
  = name:Identifier "." prop:Identifier {
      return { type: 'PROP_REF', name, property: prop }
    }
  / name:Identifier "." digits:[0-9]+ {
      return { type: 'PROP_REF', name, property: '$' + digits.join('') }
    }
  / name:Identifier "." param:ParameterRef {
      return { type: 'PROP_REF_DYNAMIC', name, property: param.name }
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
  / caseExpr:CaseExpression dir:DirClause? {
      return {
        type: 'ORDER_COLUMN',
        expression: caseExpr,
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
  = _ "UNION"i _ "ALL"i _ right:(CallProcedureStatement / CallStatement / MatchStatement) {
      return { unionType: 'union_all', rightQuery: right }
    }
  / _ "UNION"i _ right:(CallProcedureStatement / CallStatement / MatchStatement) {
      return { unionType: 'union', rightQuery: right }
    }
  / _ "INTERSECT"i _ right:MatchStatement {
      return { unionType: 'intersect', rightQuery: right }
    }
  / _ "SUBTRACT"i _ right:MatchStatement {
      return { unionType: 'subtract', rightQuery: right }
    }
  / _ "EXCEPT"i _ right:MatchStatement {
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
  = "NOT"i _ expr:Comparison { return { type: 'NOT', expr } }
  / expr:Additive _ "IS"i _ nullNot:("NOT"i)? _ "NULL"i {
      return { type: 'NULL_PREDICATE', expr: expr, not: nullNot ? true : false }
    }
  / lhs:Additive _ op:ComparisonOp _ rhs:Additive {
      return { type: 'COMPARISON', operator: op, left: lhs, right: rhs }
    }
  / lhs:Additive _ "IN"i _ rhs:(ListLiteral / Additive) {
      return { type: 'IN_EXPRESSION', left: lhs, list: rhs }
    }
  / lhs:Additive _ op:StringPredicateOp _ rhs:(Additive) {
      return { type: 'STRING_PREDICATE', operator: op, left: lhs, right: rhs }
    }
  / lhs:Additive _ "=~"i _ rhs:Additive {
      return { type: 'REGEX_MATCH', left: lhs, right: rhs }
    }
  / Additive

// ── 幂运算（右结合）────────────────────────────────────

Power
  = head:Unary tail:(_ "^" _ Unary)+ {
      let result = head
      for (const t of tail) {
        result = { type: 'POWER', left: result, right: t[3] }
      }
      return result
    }
  / Unary

// ── 一元运算（负号）────────────────────────────────────

Unary
  = "-" _ expr:Unary { return { type: 'UNARY_MINUS', expr } }
  / "+" _ expr:Unary { return expr }
  / ListSubscript

// ── 乘法 / 除法 / 取模 ──────────────────────────────────

Multiplicative
  = head:Power tail:(_ op:("*" / "/" / "%") _ Power)* {
      if (tail.length === 0) return head
      let result = head
      for (const t of tail) {
        const op = t[1]
        if (op === '*') result = { type: 'MULTIPLY', left: result, right: t[3] }
        else if (op === '/') result = { type: 'DIVIDE', left: result, right: t[3] }
        else result = { type: 'MODULO', left: result, right: t[3] }
      }
      return result
    }

// ── 加法 / 减法 / 列表拼接 ─────────────────────────────

Additive
  = head:Multiplicative tail:(_ op:("+" / "-") _ Multiplicative)* {
      if (tail.length === 0) return head
      let result = head
      for (const t of tail) {
        const op = t[1]
        if (op === '+') result = { type: 'ADD', left: result, right: t[3] }
        else result = { type: 'SUBTRACT', left: result, right: t[3] }
      }
      return result
    }

// ── 列表下标 & 切片 ────────────────────────────────────────

ListSubscript
  = expr:Primary "[" _ index:OrExpression _ "]" { return { type: 'SUBSCRIPT', expr, index } }
  / expr:Primary "[" _ start:OrExpression _ ".." _ end:OrExpression _ "]" { return { type: 'SLICE', expr, start, end } }
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
  / ExistsExpression
  / "NOT" _ ExistsExpression
  / CountSubquery
  / CaseExpression
  / ParameterRef
  / PropertyRef
  / StringLiteral
  / NumberLiteral
  / BooleanLiteral
  / ListLiteral
  / FunctionCall
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
  = head:Unary tail:(_ "," _ Unary)* {
      return [head, ...tail.map(t => t[3])]
    }

// ── 基础词法 ──────────────────────────────────────────────

Label
  = chars:[_a-zA-Z0-9]+ { return text() }

// ── 标签表达式 ──────────────────────────────────────────
// 支持: :Person|Animal, :!Person, :Person|!Animal, :Person
LabelExpression
  = ":" head:LabelPart rest:("|" part:LabelPart)* {
      const items = [head].concat(rest.map(r => r[1]))
      return { type: 'LABEL_EXPR', items }
    }

LabelPart
  = excl:"!"? label:LabelName { return { exclude: !!excl, name: label } }

LabelName
  = [A-Za-z_][A-Za-z0-9_]* { return text() }

PropertyName
  = [A-Za-z_][A-Za-z0-9_]* { return text() }

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
  = "EXISTS"i _ "{" _ subq:MatchStatement _ "}" {
      return {
        type: 'EXISTS_SUBQUERY',
        query: subq,
      }
    }
  / "EXISTS"i _ "{" _ pattern:ExistsPattern _ "}" {
      return {
        type: 'EXISTS',
        source: pattern.source,
        edgeLabel: pattern.edgeLabel,
        direction: pattern.direction,
        target: pattern.target,
      }
    }
  / "NOT"i _ "EXISTS"i _ "{" _ subq:MatchStatement _ "}" {
      return {
        type: 'NOT_EXISTS_SUBQUERY',
        query: subq,
      }
    }
  / "NOT"i _ "EXISTS"i _ "{" _ pattern:ExistsPattern _ "}" {
      return {
        type: 'NOT_EXISTS',
        source: pattern.source,
        edgeLabel: pattern.edgeLabel,
        direction: pattern.direction,
        target: pattern.target,
        targetLabel: pattern.targetLabel,
        sourceLabel: pattern.sourceLabel,
      }
    }
  / "COUNT"i _ "{" _ subq:MatchStatement _ "}" {
      return {
        type: 'COUNT_SUBQUERY',
        query: subq,
      }
    }

ExistsPattern
  = "(" _ sourceName:Identifier _ ")" _ edge:ExistsEdge? _ "(" _ ":" _ targetLabel:LabelName _ ")" {
      return { source: sourceName, sourceLabel: null, edgeLabel: edge ? edge.label : null, direction: edge ? edge.direction : 'any', target: null, targetLabel: targetLabel.name }
    }
  / "(" _ sourceName:Identifier _ ")" _ edge:ExistsEdge? _ "(" _ targetName:Identifier _ ")" {
      return { source: sourceName, sourceLabel: null, edgeLabel: edge ? edge.label : null, direction: edge ? edge.direction : 'any', target: targetName, targetLabel: null }
    }
  / "(" _ sourceName:Identifier _ ")" _ edge:ExistsEdge? _ "(" _ _ ")" {
      return { source: sourceName, sourceLabel: null, edgeLabel: edge ? edge.label : null, direction: edge ? edge.direction : 'any', target: null, targetLabel: null }
    }
  / "(" _ ":" _ sourceLabel:LabelName _ ")" _ edge:ExistsEdge? _ "(" _ targetName:Identifier _ ")" {
      return { source: null, sourceLabel: sourceLabel.name, edgeLabel: edge ? edge.label : null, direction: edge ? edge.direction : 'any', target: targetName, targetLabel: null }
    }
  / "(" _ _ ")" _ edge:ExistsEdge? _ "(" _ targetName:Identifier _ ")" {
      return { source: null, sourceLabel: null, edgeLabel: edge ? edge.label : null, direction: edge ? edge.direction : 'any', target: targetName, targetLabel: null }
    }

ExistsEdge
  = "-[" _ label:ExistsEdgeLabel _ range:ExistsEdgeRange? _ "]->" {
      return {
        label: label,
        direction: 'out',
        range: range,
      }
    }
  / "<-[" _ label:ExistsEdgeLabel _ range:ExistsEdgeRange? _ "]-" {
      return {
        label: label,
        direction: 'in',
        range: range,
      }
    }
  / "-[" _ label:ExistsEdgeLabel _ range:ExistsEdgeRange? _ "]-" {
      return {
        label: label,
        direction: 'any',
        range: range,
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

ExistsEdgeRange
  = '*' min:Integer '..' max:Integer { return { min, max } }
  / '*' '..' max:Integer { return { min: null, max } }
  / '*' min:Integer '..' { return { min, max: null } }
  / '*' exact:Integer !'.' { return { min: exact, max: exact } }

// ── COUNT 子查询 ─────────────────────────────────────────

CountSubquery
  = "COUNT"i _ "{" _ subq:MatchStatement _ "}" {
      return {
        type: 'COUNT_SUBQUERY',
        query: subq,
      }
    }

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
  = "CALL"i _ name:ProcedureName _ "(" _ args:ProcedureArgList? _ ")" _ yc:YieldClause? _ wc:WithClause? _ rc:ReturnClause? _ ob:OrderByClause? _ ls:LimitSkipClause? _ uc:UnionClause? {
      const stmt = {
        type: 'CALL_PROCEDURE',
        procedureName: name,
        arguments: args ?? [],
      }
      if (yc) stmt.yield = yc
      if (wc) stmt.with = wc
      if (rc) stmt.return = rc
      if (ob) stmt.orderBy = ob
      if (ls) {
        stmt.limit = ls.limit
        stmt.skip = ls.skip
      }
      if (uc) {
        stmt.unionType = uc.unionType
        stmt.rightQuery = uc.rightQuery
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
  / Unary
  / Identifier { return { type: 'IDENTIFIER', name: text() } }

YieldClause
  = _ "YIELD"i _ items:YieldItemList _ wc:WhereClause? _ ob:OrderByClause? _ ls:LimitSkipClause? {
      const result = { type: 'YIELD', items: items }
      if (wc) result.where = wc
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


// ── LOAD CSV ─────────────────────────────────────────────

LoadCsvStatement
  = "LOAD"i _ "CSV"i _ headers:("WITH"i _ "HEADERS"i)? _ "FROM"i _ url:StringLiteral _ "AS"i _ rowName:Identifier _ terminator:FieldTerminatorClause? _ rest:.* {
      return {
        type: 'LOAD_CSV',
        withHeaders: headers !== null,
        url: url,
        rowName,
        fieldTerminator: terminator,
      }
    }

FieldTerminatorClause
  = _ "FIELDTERMINATOR"i _ delim:StringLiteral { return delim }

// ── FOREACH ────────────────────────────────────────────────

ForEachStatement
  = forClause:ForEachClause {
      return { type: 'QUERY', forEach: forClause }
    }

ForEachClause
  = _ "FOREACH"i _ "(" _ varName:Identifier _ "IN"i _ list:UnwindList _ "|" _ body:ForEachBody _ ")" {
      return {
        type: 'FOREACH',
        variable: varName,
        list: list,
        body: body,
      }
    }

ForEachBody
  = nested:ForEachClause { return { type: 'FOREACH_BODY', forEach: nested } }
  / createClause:CreateClause { return { type: 'FOREACH_BODY', create: createClause } }
  / setClause:SetClause { return { type: 'FOREACH_BODY', set: setClause } }
  / delClause:DeleteClause { return { type: 'FOREACH_BODY', delete: delClause } }
  / removeClause:RemoveClause { return { type: 'FOREACH_BODY', remove: removeClause } }
