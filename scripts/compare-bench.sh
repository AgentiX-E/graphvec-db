#!/usr/bin/env bash
# compare-bench.sh — 对比两次基准运行的差异
# 使用方式:
#   bash scripts/compare-bench.sh <baseline.json> <current.json>
#   bash scripts/compare-bench.sh               # 交互选择
#   bash scripts/compare-bench.sh last          # 对比最近两次
#
# 依赖: jq

set -euo pipefail
cd "$(dirname "$0")/.."

BOLD='\033[1m'; GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[0;33m'; CYAN='\033[0;36m'; NC='\033[0m'

BENCH_DIR="bench-results"

if [ ! -d "$BENCH_DIR" ]; then
  echo -e "${RED}错误: ${BENCH_DIR}/ 目录不存在${NC}"
  exit 1
fi

# ── 解析参数 ──
if [ $# -eq 2 ]; then
  BASELINE="$1"; CURRENT="$2"
elif [ $# -eq 1 ] && [ "$1" = "last" ]; then
  FILES=($(ls -1 "$BENCH_DIR"/*.json 2>/dev/null | sort))
  if [ ${#FILES[@]} -lt 2 ]; then
    echo -e "${RED}错误: bench-results/ 中至少需要 2 个 JSON 文件${NC}"
    exit 1
  fi
  CURRENT="${FILES[-1]}"
  BASELINE="${FILES[-2]}"
else
  echo -e "可用基准结果:"
  FILES=($(ls -1 "$BENCH_DIR"/*.json 2>/dev/null))
  if [ ${#FILES[@]} -eq 0 ]; then
    echo -e "${RED}错误: bench-results/ 为空${NC}"
    exit 1
  fi
  for i in "${!FILES[@]}"; do
    ts=$(cat "${FILES[$i]}" | jq -r '.timestamp // "unknown"' 2>/dev/null)
    echo -e "  ${CYAN}[$((i+1))]${NC} ${FILES[$i]}  (${ts})"
  done
  echo ""
  read -p "选择 baseline 编号: " b_idx
  read -p "选择 current 编号: " c_idx
  BASELINE="${FILES[$((b_idx-1))]}"
  CURRENT="${FILES[$((c_idx-1))]}"
fi

echo -e "\n${BOLD}═══════════════════════════════════════════${NC}"
echo -e "  Baseline: ${BASELINE}"
echo -e "  Current:  ${CURRENT}"
echo -e "${BOLD}═══════════════════════════════════════════${NC}"

if [ ! -f "$BASELINE" ] || [ ! -f "$CURRENT" ]; then
  echo -e "${RED}错误: 文件不存在${NC}"
  exit 1
fi

# ── 提取指标对比 ──
echo ""
echo -e "${BOLD}性能回归对比${NC}"
echo ""
echo "| 类别 | 指标 | 基线 (ms) | 当前 (ms) | 变化 | 结论 |"
echo "|------|------|----------|----------|------|------|"

TOTAL_REGRESSIONS=0
TOTAL_IMPROVEMENTS=0

compare_section() {
  local label="$1" prefix="$2"
  local base_keys; base_keys=$(jq -r ".\"${prefix}\" | keys[]" "$BASELINE" 2>/dev/null || true)
  local curr_keys; curr_keys=$(jq -r ".\"${prefix}\" | keys[]" "$CURRENT" 2>/dev/null || true)
  local all_keys; all_keys=$(echo -e "${base_keys}\n${curr_keys}" | sort -u)

  for key in $all_keys; do
    local bv cv
    bv=$(jq ".\"${prefix}\"[\"${key}\"]" "$BASELINE" 2>/dev/null || echo "null")
    cv=$(jq ".\"${prefix}\"[\"${key}\"]" "$CURRENT" 2>/dev/null || echo "null")

    local bv_fmt cv_fmt
    bv_fmt=$(printf "%.3f" "$bv" 2>/dev/null || echo "N/A")
    cv_fmt=$(printf "%.3f" "$cv" 2>/dev/null || echo "N/A")

    local verdict=""
    local change_str=""
    if [ "$bv" != "null" ] && [ "$cv" != "null" ] && [ "$bv" != "0" ]; then
      local diff; diff=$(echo "scale=2; (($cv - $bv) / $bv) * 100" | bc 2>/dev/null || echo "0")
      local diff_abs; diff_abs=$(echo "$diff" | sed 's/^-//')
      if (( $(echo "$diff > 5" | bc -l) )); then
        verdict="${RED}⚠ 退化${NC}"
        TOTAL_REGRESSIONS=$((TOTAL_REGRESSIONS + 1))
      elif (( $(echo "$diff < -5" | bc -l) )); then
        verdict="${GREEN}✓ 改善${NC}"
        TOTAL_IMPROVEMENTS=$((TOTAL_IMPROVEMENTS + 1))
      else
        verdict="✓ 稳定"
      fi
      change_str="$(echo "scale=1; $diff" | bc)%"
    else
      change_str="—"
      if [ "$bv" = "null" ] && [ "$cv" != "null" ]; then
        verdict="${YELLOW}新指标${NC}"
      elif [ "$bv" != "null" ] && [ "$cv" = "null" ]; then
        verdict="${YELLOW}已移除${NC}"
      else
        verdict="—"
      fi
    fi

    echo -e "| ${label} | ${key} | ${bv_fmt} | ${cv_fmt} | ${change_str} | ${verdict} |"
  done
}

# 对比各 section
for section in "ge-native" "call-subquery" "match-scan" "throughput"; do
  case "$section" in
    ge-native)     label="GE 原生 API" ;;
    call-subquery) label="CALL 子句" ;;
    match-scan)    label="MATCH 扫描" ;;
    throughput)    label="吞吐量" ;;
  esac
  compare_section "$label" "$section"
done

# ── 汇总 ──
echo ""
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
echo -e "  退化: ${TOTAL_REGRESSIONS}  改善: ${TOTAL_IMPROVEMENTS}"
if [ "$TOTAL_REGRESSIONS" -gt 0 ]; then
  echo -e "  ${RED}⚠ 存在性能退化，建议检查最近改动${NC}"
else
  echo -e "  ${GREEN}✓ 未发现性能退化${NC}"
fi
echo -e "${BOLD}═══════════════════════════════════════════${NC}"
