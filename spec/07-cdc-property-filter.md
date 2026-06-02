# GAP-60: CDC 细粒度变更推送 — 属性级过滤

**优先级**: P3
**状态**: ✅ 已实现

## 概述

在现有 `CdcAdapter` 的 `CdcFilter` 中增加按属性值过滤的能力，
支持 eq/neq/gt/gte/lt/lte/exists 操作符。

## 设计

### 1. 类型定义

```ts
type CdcPropertyOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists'

interface CdcPropertyFilter {
  op: CdcPropertyOp
  value?: string | number
}

// CdcFilter 新增字段
interface CdcFilter {
  labels?: string[]
  ops?: CdcOp[]
  entities?: CdcEntity[]
  properties?: Record<string, CdcPropertyFilter>  // 新增
}
```

### 2. 过滤逻辑

- 多个 `properties` 条件之间为 **AND** 关系（必须全部匹配）
- 对 `create/update` 事件匹配 `after` 中的属性
- 对 `delete` 事件匹配 `before` 中的属性
- `exists` 操作符检查属性是否存在且非 null
- 字符串按字典序比较，数字按数值比较
- 类型不匹配时自动尝试数值转换

### 3. 使用示例

```ts
// 只接收 age > 30 的节点变更
adapter.subscribe('my-sub', handler, {
  properties: { age: { op: 'gt', value: 30 } }
})

// 多条件 AND: status='active' AND age >= 18
adapter.subscribe('my-sub', handler, {
  properties: {
    status: { op: 'eq', value: 'active' },
    age: { op: 'gte', value: 18 },
  }
})

// 属性存在性检查
adapter.subscribe('my-sub', handler, {
  properties: { email: { op: 'exists' } }
})

// querySince 也支持属性过滤
adapter.querySince(100, {
  properties: { score: { op: 'lte', value: 50 } }
})
```

### 4. API 变更

- 新增 `CdcPropertyOp` 类型
- 新增 `CdcPropertyFilter` 接口
- `CdcFilter.properties` 字段
- `CdcAdapter._matchesPropertiesFilter()` 内部方法
- `querySince()` 增加属性过滤支持

### 5. 向后兼容

- 未设置 `properties` 时行为完全不变
- 空 `properties` 视为无过滤（匹配所有）

### 6. 测试覆盖

| 测试 | 说明 |
|------|------|
| GAP-60-01 | eq 字符串过滤 |
| GAP-60-02 | eq 数字过滤 |
| GAP-60-03 | neq 过滤 |
| GAP-60-04 | gt 数字过滤 |
| GAP-60-05 | gte 过滤 |
| GAP-60-06 | lt 过滤 |
| GAP-60-07 | lte 过滤 |
| GAP-60-08 | exists 过滤 |
| GAP-60-09 | 多条件 AND 逻辑 |
| GAP-60-10 | 属性过滤 + ops/entities 组合 |
| GAP-60-11 | delete 事件使用 before |
| GAP-60-12 | delete 事件 neq |
| GAP-60-13 | 边属性过滤 |
| GAP-60-14 | querySince 属性过滤 |
| GAP-60-15 | 缺失属性不匹配 |
| GAP-60-16 | exists 过滤缺失属性 |
