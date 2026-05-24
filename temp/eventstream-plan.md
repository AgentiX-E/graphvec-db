# EventStream 执行计划

创建时间: 2026-05-24 08:45

## 目标

EventBus 上增加可靠投递层：至少送达一次 + 去重 + 离线追赶。

## 设计确认

1. **ACK 通道**: 通过 EventBus 自身的 `event:ack` 消息类型，不新增 ZeroMQ 连接
2. **StreamWal**: 独立实现，二进制格式，按消息维度管理
3. **离线追赶**: 核心（Phase 2）中就做

## 步骤

### Phase 1: src/core/stream-wal.ts
- [x] StreamWal 类：append / readPending / acknowledge / prune / close
- [x] 二进制格式：flags(1B) + msgIdLen(4B) + msgId + dataLen(4B) + JSON data
- [x] 单元测试

### Phase 2: src/core/event-stream.ts
- [x] EventStream 类，组合 EventBus
- [x] emit(event): StreamWal.append → EventBus.emit(event-stream)
- [x] _onRemoteMessage(msg): 去重 → ACK → StreamWal.markConsumed → 回调
- [x] 后台扫描 pending 重试线程
- [x] 离线追赶（SYNC）
- [x] 新增 `event:ack` / `event:sync` / `event:sync-batch` 事件类型
- [x] 单元测试

### Phase 3: 验证
- [x] tsc 0 errors
- [x] 820/820 不破
- [x] EventStream 新增测试通过

## 当前进度

- [x] Phase 1: src/core/stream-wal.ts — 11/11 测试通过
- [x] Phase 2: src/core/event-stream.ts — 13/13 测试通过
- [ ] Phase 3: 全量验证（进行中）
