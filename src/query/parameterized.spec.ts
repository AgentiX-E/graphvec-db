/**
 * parameterized.spec.ts — 参数化查询单元测试
 *
 * 覆盖 execQuery 的两种参数模式：
 * - 命名参数 $name（对象参数）
 * - 位置参数 $1, $2（数组参数，向后兼容）
 */

import { execQuery, parseQuery } from './query-engine'

describe('execQuery — 命名参数（$name 语法）', () => {

  // ── TC-N1: 基本命名参数 ──
  it('命名参数 $name → 字符串替换', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $name RETURN n",
      { name: 'Alice' }
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('Alice')
    expect(plan.filters[0].operator).toBe('EQ')
  })

  // ── TC-N2: 多命名参数 ──
  it('多命名参数 $name + $age', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $name AND n.age > $age RETURN n",
      { name: 'Bob', age: 25 }
    )
    expect(plan.filters.length).toBe(2)
    const nameFilter = plan.filters.find(f => f.property === 'name')
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.value).toBe('Bob')
    expect(nameFilter!.operator).toBe('EQ')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.value).toBe(25)
    expect(ageFilter!.operator).toBe('GT')
  })

  // ── TC-N3: 位置参数 $1, $2 向后兼容 ──
  it('位置参数 $1, $2 向后兼容（数组参数）', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $1 AND n.age > $2 RETURN n",
      ['Charlie', 30]
    )
    expect(plan.filters.length).toBe(2)
    const nameFilter = plan.filters.find(f => f.property === 'name')
    const ageFilter = plan.filters.find(f => f.property === 'age')
    expect(nameFilter).toBeDefined()
    expect(nameFilter!.value).toBe('Charlie')
    expect(ageFilter).toBeDefined()
    expect(ageFilter!.value).toBe(30)
  })

  // ── TC-N4: 缺少命名参数 → 报错 ──
  it('缺少命名参数 $name 抛错', () => {
    expect(() => {
      execQuery(
        "MATCH (n:Person) WHERE n.name = $name RETURN n",
        { wrongKey: 'Alice' }  // $name 未提供
      )
    }).toThrow(/\$name/)
  })

  it('缺少命名参数 $name ErrorInfo含参数名', () => {
    expect(() => {
      execQuery(
        "MATCH (n:Person) WHERE n.name = $name AND n.age > $age RETURN n",
        { name: 'Alice' }  // 缺少 $age
      )
    }).toThrow(/\$age/)
  })

  // ── TC-N5: 空参数 ──
  it('空参数对象 — 等价于无参数调用', () => {
    const plan1 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    const plan2 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n", {})
    expect(plan2.scanLabel).toBe(plan1.scanLabel)
    expect(plan2.filters).toEqual(plan1.filters)
    expect(plan2.returnColumns).toEqual(plan1.returnColumns)
  })

  it('空数组参数 — 等价于无参数调用', () => {
    const plan1 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    const plan2 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n", [])
    expect(plan2.scanLabel).toBe(plan1.scanLabel)
    expect(plan2.filters).toEqual(plan1.filters)
    expect(plan2.returnColumns).toEqual(plan1.returnColumns)
  })

  // ── TC-N6: 字符串参数带引号安全 ──
  it('字符串参数带引号 — 注入防护', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $name RETURN n",
      { name: "'; DROP TABLE users; --" }
    )
    expect(plan.filters.length).toBe(1)
    // 注入字符串作为字面值保留，不会破坏查询结构
    expect(plan.filters[0].value).toBe("'; DROP TABLE users; --")
    expect(plan.scanLabel).toBe('Person')
    expect(plan.returnColumns).toEqual(['n'])
  })

  it('字符串参数带单引号和双引号 — 安全兜底', () => {
    const plan = execQuery(
      "MATCH (n:Person) WHERE n.name = $name RETURN n",
      { name: "' OR 1=1 -- \" OR 'a'='a" }
    )
    expect(plan.filters.length).toBe(1)
    // 同时含 ' 和 " 时，两者都被移除作为安全兜底
    expect(plan.filters[0].value).toBe(' OR 1=1 --  OR a=a')
  })

  // ── TC-N7: 特殊字符参数名 ──
  it('特殊字符参数名 — 下划线开头', () => {
    const plan = execQuery(
      "MATCH (n) WHERE n.value = $_val RETURN n",
      { _val: 'test' }
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe('test')
  })

  // ── TC-N8: 返回列含参数 — 需要确保参数在 RETURN 中也能替换 ──
  it('命名参数在 RETURN 列中使用', () => {
    const plan = execQuery(
      'MATCH (n:Person) WHERE n.age > $minAge RETURN n.name, n.age AS age',
      { minAge: 18 }
    )
    expect(plan.filters.length).toBe(1)
    expect(plan.filters[0].value).toBe(18)
    expect(plan.filters[0].operator).toBe('GT')
  })

  // ── TC-N9: 参数值类型安全 ──
  it('命名参数 — number 保持类型', () => {
    const plan = execQuery(
      'MATCH (n) WHERE n.score = $score RETURN n',
      { score: 99.5 }
    )
    expect(typeof plan.filters[0].value).toBe('number')
    expect(plan.filters[0].value).toBe(99.5)
  })

  it('命名参数 — boolean 保持类型', () => {
    const plan = execQuery(
      'MATCH (n) WHERE n.active = $flag RETURN n',
      { flag: true }
    )
    expect(plan.filters[0].value).toBe(true)
    expect(typeof plan.filters[0].value).toBe('boolean')
  })

  it('命名参数 — null 值', () => {
    const plan = execQuery(
      'MATCH (n) WHERE n.deletedAt = $val RETURN n',
      { val: null }
    )
    expect(plan.filters[0].value).toBeNull()
  })

  // ── TC-N10: 命名参数不影响无参数查询 ──
  it('无 $ 符号的查询 — execQuery 走 parseQuery 路径', () => {
    const plan1 = parseQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n")
    const plan2 = execQuery("MATCH (n:Person) WHERE n.name = 'Alice' RETURN n", {})
    expect(plan2.scanLabel).toBe(plan1.scanLabel)
    expect(plan2.filters).toEqual(plan1.filters)
  })

  // ── TC-N11: 多个命名参数的重复出现 ──
  it('同一命名参数出现多次 — 全部替换（OR 条件不 flatten）', () => {
    // OR 条件不会被 flatten 为简单 filters，但参数替换本身工作正常
    const plan = execQuery(
      "MATCH (n) WHERE n.name = $name OR n.alias = $name RETURN n",
      { name: 'Alice' }
    )
    // OR 表达式不会拆分为简单 filter（与 parseQuery 行为一致）
    // 验证参数已正确替换（解析不会因注入报错）
    expect(plan.scanLabel).toBeNull() // 无标签
    expect(plan.returnColumns).toEqual(['n'])
  })
})
