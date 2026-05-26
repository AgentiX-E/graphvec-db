/**
 * query-engine 单元测试
 */

import { parseQuery, execQuery } from './query-engine'

describe('parseQuery — Cypher-lite 解析 + QueryPlan 转换', () => {
  it('简单 MATCH + RETURN', () => {
    const plan = parseQuery('MATCH (n) RETURN n')
    expect(plan.scanLabel).toBeNull()
    expect(plan.steps).toEqual([])
    expect(plan.returnColumns).toEqual(['n'])
  })

  it('MATCH 带标签', () => {
    const plan = parseQuery('MATCH (n:Person) RETURN n')
    expect(plan.scanLabel).toBe('Person')
    expect(plan.returnColumns).toEqual(['n'])
  })

  it('MATCH 单跳边', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) RETURN b')
    expect(plan.steps.length).toBe(1)
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.steps[0].direction).toBe('out')
    expect(plan.steps[0].targetAlias).toBe('b')
  })

  it('MATCH 单跳边 + WHERE', () => {
    const plan = parseQuery("MATCH (a)-[:KNOWS]->(b) WHERE b.age > 30 RETURN b.name")
    expect(plan.steps.length).toBe(1)
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].property).toBe('age')
    expect(plan.filters[0].operator).toBe('GT')
    expect(plan.filters[0].value).toBe(30)
    expect(plan.returnColumns).toEqual(['name'])
  })

  it('MATCH 多跳', () => {
    const plan = parseQuery("MATCH (a)-[:KNOWS]->(b)-[:WORKS_AT]->(c) WHERE c.name = 'Acme' RETURN a.name")
    expect(plan.steps.length).toBe(2)
    expect(plan.steps[0].edgeLabel).toBe('KNOWS')
    expect(plan.steps[1].edgeLabel).toBe('WORKS_AT')
    expect(plan.filters.length).toBe(1)
  })

  it('ORDER BY + LIMIT', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age > 18 RETURN n.name ORDER BY n.age DESC LIMIT 10")
    expect(plan.orderBy.length).toBe(1)
    expect(plan.orderBy[0].direction).toBe('DESC')
    expect(plan.limit).toBe(10)
  })

  it('SKIP + LIMIT', () => {
    const plan = parseQuery("MATCH (n) RETURN n SKIP 5 LIMIT 10")
    expect(plan.skip).toBe(5)
    expect(plan.limit).toBe(10)
  })

  it('节点属性模式', () => {
    const plan = parseQuery("MATCH (n {status: 'active'}) RETURN n.name")
    expect(plan.scanLabel).toBeNull()
  })

  it('多 pattern（逗号分隔）', () => {
    const plan = parseQuery("MATCH (a:Person), (b:Company) RETURN a")
    // 目前只处理第一个 pattern
    expect(plan.scanLabel).toBe('Person')
  })

  it('WHERE AND 复合条件', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age > 18 AND n.status = 'active' RETURN n.name")
    expect(plan.filters.length).toBe(2)
    expect(plan.filters[0].operator).toBe('GT')
    expect(plan.filters[1].operator).toBe('EQ')
  })

  it('WHERE OR 条件——OR 不被 flatten', () => {
    const plan = parseQuery("MATCH (n:Person) WHERE n.age > 18 OR n.status = 'vip' RETURN n.name")
    // OR 表达式不作为简单过滤器提取（需要执行时做短路评估）
    expect(plan.filters.length).toBe(0)
  })

  it('解析错误抛出有意义的错误', () => {
    expect(() => parseQuery('SELECT * FROM users')).toThrow('Query parse error')
  })

  it('无 MATCH 抛出错误', () => {
    expect(() => parseQuery('RETURN 1')).toThrow('Query parse error')
  })

  it('字符串值正确解析', () => {
    const plan = parseQuery("MATCH (n) WHERE n.name = 'Alice' RETURN n")
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('Alice')
    expect(plan.filters[0].operator).toBe('EQ')
  })

  it('数字比较', () => {
    const plan = parseQuery('MATCH (n) WHERE n.score >= 90 RETURN n')
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe(90)
    expect(plan.filters[0].operator).toBe('GTE')
  })

  it('不等于', () => {
    const plan = parseQuery("MATCH (n) WHERE n.status != 'deleted' RETURN n")
    expect(plan.filters[0].operator).toBe('NEQ')
  })

  it('返回值别名', () => {
    const plan = parseQuery("MATCH (n:Person) RETURN n.name AS username")
    expect(plan.returnColumns).toEqual(['username'])
  })
})

// ── Item 10: Cypher-lite 注入防护 ─────────────────────────

describe('execQuery — 参数化查询（Cypher-lite 注入防护）', () => {
  // TC-10.1: 正常参数化查询
  it('正常参数化查询 — 字符串参数', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.name = $1 RETURN n", ['Alice'])
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('Alice')
    expect(plan.filters[0].operator).toBe('EQ')
  })

  it('正常参数化查询 — 数字参数', () => {
    const plan = execQuery("MATCH (n:Person) WHERE n.age > $1 RETURN n", [30])
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe(30)
    expect(plan.filters[0].operator).toBe('GT')
  })

  it('正常参数化查询 — 布尔参数', () => {
    const plan = execQuery("MATCH (n) WHERE n.active = $1 RETURN n", [true])
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe(true)
    expect(plan.filters[0].operator).toBe('EQ')
  })

  it('多个参数 $1, $2', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.age > $1 AND n.status = $2 RETURN n",
      [18, 'active']
    )
    expect(plan.filters.length).toBe(2)
    expect(plan.filters[0].value).toBe(18)
    expect(plan.filters[0].operator).toBe('GT')
    expect(plan.filters[1].value).toBe('active')
    expect(plan.filters[1].operator).toBe('EQ')
  })

  // TC-10.2: SQL注入式字符串 — 作为字面值匹配
  it('注入防护 — 单引号注入字符串作为字面值', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n",
      ["' OR 1=1 --"]
    )
    expect(plan.filters.length).toBe(1)
    // 字符串含 `'`（不含 `"`），使用双引号包裹 → 原值完整保留
    expect(plan.filters[0].value).toBe("' OR 1=1 --")
  })

  it('注入防护 — DROP 注入字符串作为字面值', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n",
      ["'; DROP TABLE users; --"]
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe("'; DROP TABLE users; --")
  })

  it('注入防护 — 含单双号两种引号的注入字符串', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n",
      ["' OR 1=1 -- \" OR 'a'='a"]
    )
    expect(plan.filters.length).toBe(1)
    // 同时含 `'` 和 `"`，两者都会被移除作为安全兜底
    // 保留的值不含任何引号，注入被彻底阻断
    expect(plan.filters[0].value).toBe(' OR 1=1 --  OR a=a')
  })

  it('注入防护 — 等号注入', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n",
      ["admin' = 'admin"]
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe("admin' = 'admin")
  })

  it('注入防护 — 闭合括号注入', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n",
      [") OR (1=1"]
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe(") OR (1=1")
  })

  // TC-10.3: 数组参数 — 序列化为数组字面值后传入解析器
  it('数组参数 — 数字数组（解析器暂不支持数组字面值）', () => {
    // Cypher-lite 解析器暂不支持 `[25, 30, 35]` 数组字面值语法，
    // 但 execQuery 能安全序列化（不会注入），解析器会抛出格式错误
    expect(() => {
      execQuery(
        "MATCH (n) WHERE n.age = $1 RETURN n",
        [[25, 30, 35]]
      )
    }).toThrow('Query parse error')
  })

  it('数组参数 — 字符串数组（解析器暂不支持数组字面值）', () => {
    expect(() => {
      execQuery(
        "MATCH (n) WHERE n.status = $1 RETURN n",
        [['active', 'pending']]
      )
    }).toThrow('Query parse error')
  })

  // TC-10.4: 参数数量不匹配
  it('参数数量不匹配 — 占位符多参数少', () => {
    expect(() => {
      execQuery(
        "MATCH (n:Person) WHERE n.age > $1 AND n.status = $2 RETURN n",
        [18] // 只有 1 个参数，但查询有 2 个占位符
      )
    }).toThrow('Parameter count mismatch')
  })

  it('参数数量不匹配 — 占位符少参数多', () => {
    expect(() => {
      execQuery(
        "MATCH (n:Person) WHERE n.name = $1 RETURN n",
        ['Alice', 'extra'] // 2 个参数，但查询有 1 个占位符
      )
    }).toThrow('Parameter count mismatch')
  })

  it('无参数时 execQuery 与 parseQuery 行为一致', () => {
    const plan1 = parseQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    const plan2 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    expect(plan2.scanLabel).toBe(plan1.scanLabel)
    expect(plan2.filters).toEqual(plan1.filters)
    expect(plan2.returnColumns).toEqual(plan1.returnColumns)
  })

  it('带 return 的参数化查询', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 RETURN n.age",
      ['Bob']
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('Bob')
    expect(plan.returnColumns).toEqual(['age'])
  })
})

// ── Item 17: Cypher-lite DML 扩展 ─────────────────────────

describe('parseQuery — DML 语句（CREATE / DELETE / SET / MERGE）', () => {
  // TC-17.1: 简单 CREATE 节点
  it('CREATE 单节点', () => {
    const plan = parseQuery('CREATE (n:Label {prop: "val"})')
    expect(plan.type).toBe('CREATE')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBe(1)
    expect(plan.createNodes![0].alias).toBe('n')
    expect(plan.createNodes![0].label).toBe('Label')
    expect(plan.createNodes![0].props).toEqual({ prop: { type: 'STRING', value: 'val' } })
  })

  // TC-17.2: CREATE 带边
  it('CREATE 带边', () => {
    const plan = parseQuery('CREATE (a)-[:KNOWS]->(b)')
    expect(plan.type).toBe('CREATE')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createEdges).toBeDefined()
    expect(plan.createNodes!.length).toBe(2) // a + b
    expect(plan.createEdges!.length).toBe(1)
    expect(plan.createEdges![0].label).toBe('KNOWS')
    expect(plan.createEdges![0].direction).toBe('out')
  })

  // TC-17.3: DELETE 节点
  it('DELETE 节点', () => {
    const plan = parseQuery('MATCH (n) DELETE n')
    expect(plan.type).toBe('DELETE')
    expect(plan.deleteTargets).toBeDefined()
    expect(plan.deleteTargets!.length).toBe(1)
    expect(plan.deleteTargets![0]).toBe('n')
  })

  it('DELETE 多个节点', () => {
    const plan = parseQuery('MATCH (a)-[:KNOWS]->(b) DELETE a, b')
    expect(plan.type).toBe('DELETE')
    expect(plan.deleteTargets!.length).toBe(2)
    expect(plan.deleteTargets![0]).toBe('a')
    expect(plan.deleteTargets![1]).toBe('b')
  })

  // TC-17.4: SET 属性
  it('SET 属性', () => {
    const plan = parseQuery("MATCH (n) SET n.name = 'new'")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses).toBeDefined()
    expect(plan.setClauses!.length).toBe(1)
    expect(plan.setClauses![0].property).toBe('name')
    expect(plan.setClauses![0].value).toBe('new')
  })

  it('SET 多属性', () => {
    const plan = parseQuery("MATCH (n) SET n.name = 'alice', n.age = 30")
    expect(plan.type).toBe('SET')
    expect(plan.setClauses!.length).toBe(2)
    expect(plan.setClauses![0].property).toBe('name')
    expect(plan.setClauses![0].value).toBe('alice')
    expect(plan.setClauses![1].property).toBe('age')
    expect(plan.setClauses![1].value).toBe(30)
  })

  // TC-17.5: MERGE 节点
  it('MERGE 节点', () => {
    const plan = parseQuery('MERGE (n:Label {id: 1})')
    expect(plan.type).toBe('MERGE')
    expect(plan.mergeNodes).toBeDefined()
    expect(plan.mergeNodes!.length).toBe(1)
    expect(plan.mergeNodes![0].alias).toBe('n')
    expect(plan.mergeNodes![0].label).toBe('Label')
  })

  // TC-17.6: 组合语句
  it('CREATE + RETURN', () => {
    const plan = parseQuery('CREATE (n) RETURN n')
    expect(plan.type).toBe('CREATE')
    expect(plan.createNodes).toBeDefined()
    expect(plan.createNodes!.length).toBe(1)
    expect(plan.createNodes![0].alias).toBe('n')
    expect(plan.returnColumns).toEqual(['n'])
  })

  // TC-17.7: 语法错误恢复
  it('语法错误 — CREAT (n)', () => {
    expect(() => parseQuery('CREAT (n)')).toThrow('Query parse error')
  })

  it('语法错误 — 非法关键字', () => {
    expect(() => parseQuery('DELET n')).toThrow('Query parse error')
  })
})
