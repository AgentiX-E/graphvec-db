#!/usr/bin/env bash
# accept-gate.sh — Per-module coverage acceptance gate.
#
# Runs vitest with coverage ENABLED for a single module and asserts that every
# coverage dimension (statements, branches, functions, lines) meets the given
# threshold (default 95). Exits non-zero with a readable gap report otherwise.
#
# This is the authoritative "iteration accepted?" check. It is deliberately
# per-module (never `vitest run src/`) because the full tree contains
# stability/benchmark suites that take 6-10 hours and external-dep modules that
# hang. See scripts/HARD-RULES.md.
#
# Usage:
#   bash scripts/accept-gate.sh <module-dir> [threshold]
#   e.g.  bash scripts/accept-gate.sh src/query 95
#
# Output: four coverage percentages + PASS/FAIL.

set -uo pipefail

MODULE="${1:-}"
THRESHOLD="${2:-95}"
REPORT_DIR="${TMPDIR:-/tmp}/accept-gate-${$}"

if [[ -z "$MODULE" ]]; then
  echo "usage: accept-gate.sh <module-dir> [threshold]" >&2
  exit 2
fi

MODULE_GLOB="${MODULE}/**/*.ts"
SPEC_EXCLUDE="${MODULE}/**/*.spec.ts"

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "  Acceptance gate: ${MODULE}  (threshold ${THRESHOLD}%)"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

npx vitest run "${MODULE}" \
  --coverage.enabled=true \
  --coverage.provider=v8 \
  --coverage.include="${MODULE_GLOB}" \
  --coverage.exclude="${SPEC_EXCLUDE}" \
  --coverage.reporter=json \
  --coverage.reporter=text-summary \
  --coverage.reportsDirectory="${REPORT_DIR}" \
  >/dev/null 2>&1

COVERAGE_JSON="${REPORT_DIR}/coverage-final.json"
if [[ ! -f "$COVERAGE_JSON" ]]; then
  echo "  ❌ No coverage report produced for ${MODULE}" >&2
  exit 3
fi

# Aggregate the four dimensions from the v8 JSON coverage report.
node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.env.COV_JSON, "utf8"));
const t = { s: 0, ts: 0, b: 0, tb: 0, f: 0, tf: 0, l: 0, tl: 0 };
for (const d of Object.values(c)) {
  const sm = d.statementMap || {};
  const s = d.s || {};
  t.s += Object.values(s).filter(v => v > 0).length;
  t.ts += Object.keys(s).length;
  const bv = Object.values(d.b || {}).flat();
  t.b += bv.filter(v => v > 0).length;
  t.tb += bv.length;
  t.f += Object.values(d.f || {}).filter(v => v > 0).length;
  t.tf += Object.keys(d.f || {}).length;
  // lines: count statement lines covered without counting a line twice
  const coveredLines = new Set();
  const totalLines = new Set();
  for (const [k, v] of Object.entries(s)) {
    const m = sm[k];
    if (!m) continue;
    totalLines.add(m.start.line);
    if (v > 0) coveredLines.add(m.start.line);
  }
  t.l += coveredLines.size;
  t.tl += totalLines.size;
}
const pct = (c, tot) => (tot ? (100 * c / tot) : 100);
const dims = { statements: pct(t.s, t.ts), branches: pct(t.b, t.tb), functions: pct(t.f, t.tf), lines: pct(t.l, t.tl) };
const threshold = Number(process.env.THRESHOLD);
const pass = Object.values(dims).every(v => v >= threshold);
for (const [k, v] of Object.entries(dims)) {
  console.log(`  ${k.padEnd(12)} ${v.toFixed(2)}%  (${v >= threshold ? "✅" : "❌ below " + threshold + "%"})`);
}
process.exit(pass ? 0 : 1);
' 2>&1

RC=$?
rm -rf "$REPORT_DIR"

if [[ $RC -eq 0 ]]; then
  echo "  ✅ ACCEPTED: all dimensions ≥ ${THRESHOLD}%"
else
  echo "  ❌ REJECTED: one or more dimensions below ${THRESHOLD}%"
fi

exit $RC
