# WAL → LmdbWal 迁移指南

## 背景

从 V14 起，`src/consensus/wal.ts`（`WAL` 类）已被标记为 `@deprecated`。
推荐使用 `src/consensus/lmdb-wal.ts`（`LmdbWal` 类）作为替代。

## 为什么迁移？

| 特性 | WAL (已废弃) | LmdbWal (推荐) |
|------|-------------|----------------|
| 存储引擎 | 自定义二进制格式 | LMDB (内存映射数据库) |
| 事务支持 | 无 | ACID 事务 |
| 并发写入 | 文件锁 + fsync | LMDB 原生支持 |
| 读取性能 | 全量读取后过滤 | 按 key/index 直接查找 |
| CRC 校验 | 内置 CRC32 | LMDB 自带校验 |
| 大日志场景 | 全量文件重写 | 原地更新，O(1) |

## 迁移步骤

### 1. 替换 WAL 导入

**旧代码：**
```typescript
import { WAL, LogEntry } from './wal'
```

**新代码：**
```typescript
import { LmdbWal, type WALEntry } from './lmdb-wal'
```

### 2. API 映射

| WAL API | LmdbWal API | 说明 |
|---------|-------------|------|
| `new WAL(walPath)` | `new LmdbWal(dbPath)` | 路径语义不同（WAL=文件, LmdbWal=目录） |
| `await wal.open()` | 构造函数自动打开 | LmdbWal 无需手动 open |
| `await wal.append(term, data)` | `wal.append(term, data)` | 签名相同，返回类型不同 |
| `wal.readAll()` | `wal.readAll()` | 签名相同，返回 `WALEntry[]` |
| `wal.getEntry(index)` | `wal.get(index)` | 签名相同 |
| `wal.getEntriesFrom(start)` | `wal.getFrom(start)` | 签名相同 |
| `wal.truncate(lastIndex)` | `wal.truncate(toIndex)` | 签名类似，语义相同 |
| `wal.truncateBefore(index)` | `wal.deleteBefore(index)` | 签名相同 |
| `wal.entriesCount()` | `wal.size()` | 方法名不同 |
| `wal.getLastIndex()` | `wal.getLastIndex()` | 相同 |
| `wal.getLastTerm()` | `wal.getLastTerm()` | 相同 |
| `wal.persistMeta(k, v)` | `wal.setMeta(k, v)` | 方法名不同 |
| `wal.loadMeta(k)` | `wal.getMeta(k)` | 方法名不同 |
| `wal.sync()` | 无需（LMDB 自动落盘） | LmdbWal 可选 |
| `wal.close()` | `wal.close()` | 相同 |
| `wal.destroy()` | `wal.destroy()` | 相同 |

### 3. 类型映射

```typescript
// 旧
import { LogEntry } from './wal'
// type LogEntry = { index: number; term: number; data: Uint8Array }

// 新
import type { WALEntry } from './lmdb-wal'
// type WALEntry = { index: number; term: number; data: Buffer }
```

### 4. 实例化对比

**旧（WAL）：**
```typescript
const wal = new WAL(path.join(dataDir, 'raft.wal'))
await wal.open()
```

**新（LmdbWal）：**
```typescript
const wal = new LmdbWal(path.join(dataDir, 'raft-lmdb'))
// 构造函数自动打开，无需手动调用 open()
```

### 5. Group Commit

**WAL** 有内置的 Group Commit（通过 `setGroupCommit()` 控制），在批量写入时聚合多个 append 为一次 fsync。

**LmdbWal** 通过 LMDB 原生事务机制实现批量写入：
```typescript
wal.beginBatch()
try {
  wal.append(1, data1)
  wal.append(1, data2)
  wal.commitBatch()
} catch (err) {
  wal.abortBatch()
}
```

## 验证迁移

迁移后运行以下测试确认：

```bash
# LmdbWal 测试
npx vitest run src/consensus/lmdb-wal.spec.ts

# 原有 raft 测试（确保不依赖 WAL）
npx vitest run src/consensus/raft-logic*
npx vitest run src/consensus/raft-integration*

# 原有 consensus 测试
npx vitest run --config vitest.config.ts --root . src/consensus --exclude="src/consensus/(raft-logic|raft-integration|raft-install|raft-transport)*"
```

## 废弃时间线

| 版本 | 状态 |
|------|------|
| V14  | `@deprecated` 标记，保留向后兼容 |
| V15  | 仍可用（计划清理） |
| V16+ | 可能移除，请在此之前完成迁移 |
