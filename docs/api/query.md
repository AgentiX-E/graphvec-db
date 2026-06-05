# 查询 API 参考

> 模块路径: `src/query/query-engine.ts`
>
> AgentiX GraphVec 提供 **Cypher-lite** 查询引擎，支持 Cypher 查询语言的常用子集。
> 查询解析器基于 PEG.js，将 Cypher-lite 字符串转换为执行计划并执行。

---

## 目录

- [execQuery — 执行 Cypher 查询](#execquery--执行-cypher-查询)
- [支持的 Cypher 子集](#支持的-cypher-子集)
- [MATCH — 模式匹配](#match--模式匹配)
- [WHERE — 过滤条件](#where--过滤条件)
- [RETURN — 返回结果](#return--返回结果)
- [CREATE — 创建节点和边](#create--创建节点和边)
- [MERGE — 匹配或创建](#merge--匹配或创建)
- [DELETE — 删除](#delete--删除)
- [聚合函数](#聚合函数)
- [ORDER BY / LIMIT / SKIP](#order-by--limit--skip)
- [WITH — 管道中间投影](#with--管道中间投影)
- [集合运算](#集合运算)
- [参数化查询](#参数化查询)
- [完整示例](#完整示例)

---

## `execQuery()` — 执行 Cypher 查询

### 签名

```typescript
function execQuery(
  query: string,
  params?: Record<string, unknown> | unknown[]
): QueryPlan
```

### 参数

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `query` | `string` | ✅ | Cypher-lite 查询字符串 |
| `params` | `Record<string, unknown> \| unknown[]` | ❌ | 参数化查询参数 |

### 返回值

返回解析后的 `QueryPlan` 对象，包含查询的执行计划结构。

### 说明

`execQuery()` 负责两件事：
1. **解析**：将 Cypher-lite 字符串解析为 AST（抽象语法树）
2. **参数替换**：如果提供了 `params`，先替换占位符再解析

**注意**：`execQuery()` 本身只执行解析和参数替换，不实际运行查询。实际的查询执行由 `GraphEngine.query()` 或 `_executeQuery()` 完成。

---

## 支持的 Cypher 子集

引擎支持以下 Cypher 子集：

| 子句 | 支持情况 | 说明 |
|------|----------|------|
| `MATCH` | ✅ 完整 | 单跳和多跳模式匹配 |
| `OPTIONAL MATCH` | ✅ 支持 | 匹配不到时返回 `null` 绑定 |
| `WHERE` | ✅ 完整 | 支持 AND、OR、NOT、比较运算 |
| `RETURN` | ✅ 完整 | 支持列投影、别名、聚合 |
| `CREATE` | ✅ 支持 | 创建节点和边 |
| `MERGE` | ✅ 支持 | 匹配或创建（支持 ON CREATE / ON MATCH） |
| `DELETE` | ✅ 支持 | 删除节点和边 |
| `SET` | ✅ 支持 | 更新属性 |
| `REMOVE` | ✅ 支持 | 删除属性或标签 |
| `WITH` | ✅ 支持 | 管道中间投影和聚合 |
| `ORDER BY` | ✅ 支持 | ASC / DESC |
| `LIMIT` | ✅ 支持 | 限制结果数 |
| `SKIP` | ✅ 支持 | 跳过结果行 |
| `UNION` / `UNION ALL` | ✅ 支持 | 集合运算 |
| `INTERSECT` / `SUBTRACT` | ✅ 支持 | 交集和差集 |
| `CALL` | ✅ 支持 | 调用子查询或存储过程 |
| `USE` | ✅ 支持 | 多图命名空间切换 |
| `EXPLAIN` | ✅ 支持 | 展示执行计划但不执行 |
| `PROFILE` | ✅ 支持 | 执行并收集统计信息 |
| `LOAD CSV` | ✅ 支持 | 从 CSV 文件/URL 加载数据 |
| `HAVING` | ✅ 支持 | 聚合后过滤 |
| `FOREACH` | ✅ 支持 | 对列表元素循环执行更新 |
| `CASE` | ✅ 支持 | 条件表达式 |
| `UNWIND` | ✅ 支持 | 将列表展开为多行 |

---

## MATCH — 模式匹配

### 基本语法

```cypher
MATCH (variable:Label)
MATCH (variable:Label)-[:RELATION_TYPE]->(other)
MATCH (a)-[:RELATION]->(b)-[:RELATION2]->(c)
```

### 示例

```cypher
-- 匹配所有 Person 节点
MATCH (n:Person) RETURN n

-- 单跳匹配：查找 Alice 的朋友
MATCH (a:Person {name: 'Alice'})-[:KNOWS]->(friend) RETURN friend

-- 多跳匹配：查找 Alice 的二度关系
MATCH (a:Person {name: 'Alice'})-[:KNOWS]->()-[:KNOWS]->(friend) RETURN DISTINCT friend

-- 变长路径匹配
MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..3]->(friend) RETURN friend

-- OPTIONAL MATCH（匹配不到时返回 null）
MATCH (a:Person {name: 'Alice'})
OPTIONAL MATCH (a)-[:KNOWS]->(friend)
RETURN a.name, friend.name

-- 标签表达式：匹配 Person 或 Agent 节点
MATCH (n:Person|Agent) RETURN n

-- 排除标签：匹配非 Person 的所有节点
MATCH (n:!Person) RETURN n

-- 多图命名空间查询
USE myGraph MATCH (n) RETURN n
```

---

## WHERE — 过滤条件

### 支持的运算符

| 运算符 | 说明 | 示例 |
|--------|------|------|
| `=` | 等于 | `n.age = 30` |
| `<>` | 不等于 | `n.city <> 'Beijing'` |
| `>` / `>=` | 大于 / 大于等于 | `n.age > 18` |
| `<` / `<=` | 小于 / 小于等于 | `n.age <= 65` |
| `IN` | 在列表中 | `n.city IN ['Beijing', 'Shanghai']` |
| `STARTS WITH` | 字符串前缀 | `n.name STARTS WITH 'A'` |
| `ENDS WITH` | 字符串后缀 | `n.name ENDS WITH 'son'` |
| `CONTAINS` | 字符串包含 | `n.name CONTAINS 'li'` |
| `IS NULL` | 为空判断 | `n.email IS NULL` |
| `IS NOT NULL` | 非空判断 | `n.email IS NOT NULL` |
| `AND` / `OR` | 逻辑与/或 | `n.age > 18 AND n.city = 'Beijing'` |
| `NOT` | 逻辑非 | `NOT n.age > 60` |

### 示例

```cypher
-- 简单条件
MATCH (n:Person) WHERE n.age > 25 RETURN n

-- 复合条件
MATCH (n:Person)
WHERE n.age >= 18 AND n.age <= 60 AND n.city = 'Beijing'
RETURN n

-- IN 条件
MATCH (n:Person)
WHERE n.city IN ['Beijing', 'Shanghai', 'Shenzhen']
RETURN n

-- 字符串匹配
MATCH (n:Person) WHERE n.name CONTAINS 'a' RETURN n

-- 属性存在性检查（WHERE + 节点属性）
MATCH (n:Person) WHERE n.email IS NOT NULL RETURN n
```

---

## RETURN — 返回结果

### 语法

```cypher
RETURN expr [AS alias] [, ...]
RETURN DISTINCT expr [AS alias] [, ...]
RETURN *
```

### 示例

```cypher
-- 返回全部
MATCH (n:Person) RETURN n

-- 返回特定属性
MATCH (n:Person) RETURN n.name, n.age

-- 使用别名
MATCH (n:Person) RETURN n.name AS 姓名, n.age AS 年龄

-- 去重
MATCH (n:Person)-[:KNOWS]->(friend)
RETURN DISTINCT friend.name

-- 返回聚合结果
MATCH (n:Person)
RETURN COUNT(*) AS total, AVG(n.age) AS avgAge
```

---

## CREATE — 创建节点和边

### 语法

```cypher
CREATE (variable:Label { props })
CREATE (a)-[:RELATION_TYPE { props }]->(b)
```

### 示例

```cypher
-- 创建单个节点
CREATE (n:Person {name: 'Alice', age: 30, city: 'Beijing'})

-- 创建节点和边
CREATE (a:Person {name: 'Bob', age: 28})
       -[:KNOWS {since: 2023}]->
       (b:Person {name: 'Charlie', age: 32})

-- 创建多条
CREATE (a:Person {name: 'David'})
CREATE (b:Person {name: 'Eve'})
CREATE (a)-[:KNOWS]->(b)
```

---

## MERGE — 匹配或创建

### 语法

```cypher
MERGE (n:Label {id: value})
ON CREATE SET n.prop = value
ON MATCH SET n.prop = value
```

### 示例

```cypher
-- 如果节点不存在则创建，存在则更新
MERGE (n:Person {name: 'Alice'})
ON CREATE SET n.age = 30, n.createdAt = timestamp()
ON MATCH SET n.lastSeen = timestamp()

-- MERGE 带路径
MERGE (a:Person {name: 'Alice'})
MERGE (b:Person {name: 'Bob'})
MERGE (a)-[:KNOWS]->(b)
```

---

## DELETE — 删除

### 语法

```cypher
DELETE variable
DETACH DELETE variable
```

### 示例

```cypher
-- 删除节点（需先删除关联边）
MATCH (n:Person {name: 'Alice'})
DETACH DELETE n

-- 删除边
MATCH (a:Person {name: 'Alice'})-[r:KNOWS]->(b)
DELETE r

-- 批量删除
MATCH (n:Temporary) DETACH DELETE n
```

---

## 聚合函数

| 函数 | 签名 | 说明 | 空集返回 |
|------|------|------|----------|
| `COUNT` | `COUNT(*)` 或 `COUNT(expr)` | 计数 | `0` |
| `COUNT(DISTINCT ...)` | `COUNT(DISTINCT expr)` | 去重计数 | `0` |
| `SUM` | `SUM(expr)` | 求和 | `0` |
| `AVG` | `AVG(expr)` | 平均值 | `null` |
| `MIN` | `MIN(expr)` | 最小值 | `null` |
| `MAX` | `MAX(expr)` | 最大值 | `null` |
| `COLLECT` | `COLLECT(expr)` | 聚合并返回数组 | `[]` |

### 示例

```cypher
-- 统计总数
MATCH (n:Person) RETURN COUNT(*) AS total

-- 统计不同的城市数
MATCH (n:Person) RETURN COUNT(DISTINCT n.city) AS cityCount

-- 聚合计算
MATCH (n:Person)
RETURN
  COUNT(*) AS total,
  AVG(n.age) AS avgAge,
  MIN(n.age) AS minAge,
  MAX(n.age) AS maxAge,
  SUM(n.salary) AS totalSalary

-- 按城市分组
MATCH (n:Person)
RETURN n.city AS city, COUNT(*) AS count, AVG(n.age) AS avgAge
ORDER BY count DESC

-- COLLECT 汇聚列表
MATCH (n:Person)
RETURN n.city, COLLECT(n.name) AS names

-- HAVING 聚合后过滤
MATCH (n:Person)
RETURN n.city AS city, COUNT(*) AS cnt
HAVING cnt > 5
ORDER BY cnt DESC
```

---

## ORDER BY / LIMIT / SKIP

### 语法

```cypher
ORDER BY expr [ASC | DESC] [, ...]
LIMIT n
SKIP n
ORDER BY ... SKIP ... LIMIT ...
```

### 示例

```cypher
-- 排序
MATCH (n:Person) RETURN n.name, n.age
ORDER BY n.age DESC

-- 多字段排序
MATCH (n:Person) RETURN n.name, n.age, n.city
ORDER BY n.city ASC, n.age DESC

-- 分页
MATCH (n:Person) RETURN n.name
ORDER BY n.name ASC
SKIP 10
LIMIT 20

-- 默认 LIMIT（1000 条）
MATCH (n:Person) RETURN n.name  -- 最多返回 1000 条

-- 无限制（需显式设置）
MATCH (n:Person) RETURN n.name LIMIT 10000
```

---

## WITH — 管道中间投影

`WITH` 子句用于在查询处理管道中创建中间投影，支持在下一步之前进行过滤、聚合和排序。

### 语法

```cypher
WITH expr AS alias [, ...]
[WHERE condition]
[ORDER BY ...]
[SKIP n]
[LIMIT n]
```

### 示例

```cypher
-- WITH 过滤
MATCH (n:Person)
WITH n WHERE n.age > 25
RETURN n.name, n.age

-- WITH 聚合后处理
MATCH (n:Person)
WITH n.city AS city, COUNT(*) AS cnt
WHERE cnt > 3
RETURN city, cnt ORDER BY cnt DESC

-- WITH + ORDER BY + LIMIT
MATCH (n:Person)
WITH n ORDER BY n.age DESC LIMIT 5
RETURN n.name, n.age
```

---

## 集合运算

| 运算符 | 说明 |
|--------|------|
| `UNION` | 合并结果集并去重 |
| `UNION ALL` | 合并结果集（包含重复） |
| `INTERSECT` | 取结果集交集 |
| `SUBTRACT` | 取结果集差集（左减右） |

### 示例

```cypher
-- UNION
MATCH (a:Person) RETURN a.name AS name
UNION
MATCH (b:Company) RETURN b.name AS name

-- INTERSECT
MATCH (a:Person) WHERE a.age > 30 RETURN a.name
INTERSECT
MATCH (a:Person) WHERE a.city = 'Beijing' RETURN a.name

-- SUBTRACT
MATCH (a:Person) RETURN a.name
SUBTRACT
MATCH (a:Person) WHERE a.age < 18 RETURN a.name
```

---

## 参数化查询

`execQuery()` 支持两种参数化方式：

### 命名参数

```typescript
const plan = execQuery(
  'MATCH (n:Person) WHERE n.age > $minAge AND n.city = $city RETURN n',
  { minAge: 25, city: 'Beijing' }
)
```

### 位置参数

```typescript
const plan = execQuery(
  'MATCH (n:Person) WHERE n.age > $1 AND n.name CONTAINS $2 RETURN n',
  [30, 'son']
)
```

---

## 完整示例

### 从 GraphEngine 执行 Cypher 查询

```typescript
import { GraphEngine } from '../core/graph-engine'
import { execQuery, parseQueryCached } from '../query/query-engine'

const engine = new GraphEngine({ path: '/data/graph-demo' })
engine.open()

// 准备数据
async function seedData() {
  const alice = await engine.upsertNode(1, 'Alice', { props: { age: 30, city: 'Beijing' } })
  const bob = await engine.upsertNode(1, 'Bob', { props: { age: 28, city: 'Beijing' } })
  const charlie = await engine.upsertNode(1, 'Charlie', { props: { age: 35, city: 'Shanghai' } })
  const diana = await engine.upsertNode(1, 'Diana', { props: { age: 25, city: 'Shanghai' } })

  await engine.upsertEdge(alice, bob, 10)  // KNOWS
  await engine.upsertEdge(bob, charlie, 10)
  await engine.upsertEdge(alice, diana, 10)
}

await seedData()

// 查询：统计各城市人数
const query1 = execQuery(
  `MATCH (n:Person)
   RETURN n.city AS city, COUNT(*) AS cnt
   ORDER BY cnt DESC`
)
const cityStats = engine.query(query1, undefined)
console.log(cityStats)

// 查询：查找 Beijing 的年轻人
const query2 = execQuery(
  `MATCH (n:Person)
   WHERE n.city = $city AND n.age > $minAge
   RETURN n.name, n.age
   ORDER BY n.age DESC
   LIMIT 10`,
  { city: 'Beijing', minAge: 18 }
)
const youngBeijinger = engine.query(query2, undefined)
console.log(youngBeijinger)

// 查询：二度关系（朋友的朋友）
const query3 = execQuery(
  `MATCH (a:Person {name: 'Alice'})-[:KNOWS*1..2]->(friend)
   RETURN DISTINCT friend.name`
)
const friendsOfFriends = engine.query(query3, undefined)
console.log(friendsOfFriends)

engine.close()
```
