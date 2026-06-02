# GAP-47: AggregationRegistry — 用户定义聚合函数

**优先级**: P3
**状态**: ✅ 已实现

## 概述

`AggregationRegistry` 提供注册和执行自定义聚合函数（UDA）的能力。
参照 `ProcedureRegistry` 设计，支持并行聚合（Accumulator/Merge/Finalize 模式）。

## 设计

### UDA 核心接口

```typescript
interface Accumulator {
  state: unknown        // 当前累加值
  accumulate(value)     // 累加一条记录
  merge(other)          // 合并另一个累加器（并行聚合）
  finalize()            // 完成聚合，返回结果
  reset()               // 重置
}

type AccumulatorFactory = () => Accumulator
```

### 内置聚合

| 名称 | 说明 |
|------|------|
| `count` | 计数 |
| `sum` | 数值求和 |
| `avg` | 算术平均（空数组返回 null） |
| `min` | 最小值（空数组返回 null） |
| `max` | 最大值（空数组返回 null） |
| `count_distinct` | 去重计数 |

### 方法

| 方法 | 说明 |
|------|------|
| `register(name, factory, description?)` | 注册自定义 UDA |
| `has(name)` | 检查是否已注册 |
| `createAccumulator(name)` | 创建累加器实例 |
| `aggregate(name, values)` | 对一组值运行聚合 |
| `groupAggregate(name, items)` | 分组聚合 |
| `list()` | 列出所有注册项 |
| `unregister(name)` | 注销 |
| `clear()` | 清除所有注册 |

### 文件

- `src/query/aggregation-registry.ts` — 实现
- `src/query/aggregation-registry.spec.ts` — 测试

### 测试覆盖

- 6 个内置聚合函数
- 自定义 UDA（collect, median, stddev）
- 分组聚合（groupAggregate）
- 寄存器管理（list/unregister/clear）
- Accumulator 生命周期（创建/合并/重置/隔离）
- 空数组/空值处理
