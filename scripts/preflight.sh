#!/bin/bash
# ── preflight — 在执行任何操作前检查自身状态 ──
# 比 AGENTS.md 的 flush protocol 更激进：只要 context > 60% 就 flush

# 读取 session_status 的 context 百分比
# 无法直接获取，只能用规则约束：每条 message 前人工检查

# ── 硬边界 ──
# 1. 长的回复（>20行）必须先写文件再回复
# 2. spawn sub-agent + yield 是唯一的"等待"方式
# 3. 永远不在主 session 跑超过 5s 的任务
# 4. 回复长度 = 3 句内，要详情说"详情见 file.md"
