# Ops + Security Spec Coverage Plan

## Status: ✅ Complete

## Results

### A. otel-metrics.spec.ts — ✅ CREATED (19 tests)
Covers: singleton pattern, isEnabled lifecycle, counter/histogram/gauge operations, noop when Telemetry disabled, naming, init

### B. backup-types.spec.ts — ✅ CREATED (14 tests)
Covers: BackupResult (full/incremental/verified/zero-byte), WalLsnSnapshot, PITRConfig (enabled/disabled/targetTimestamp), RecoveryPoint types

### C. audit-chain.spec.ts — ✅ THICKENED (old: 4 tests, new: 10 tests)
Added: genesis hash check, chain hash format, multi-entry chain (15), empty chain, single entry, clear + rebuild, middle entry tampering detection

### D. audit-encrypt.spec.ts — ✅ THICKENED (old: 3 tests, new: 10 tests)
Added: different keys → different ciphertext, different IV → different ciphertext, empty string roundtrip, large text roundtrip (10KB), tag tampering, IV tampering, ciphertext tampering

### E. batch-io.spec.ts — ✅ Already well-covered (22 existing tests, no change needed)

### F. Security layer — ✅ All 13 spec files already well-covered (332 tests total, no change needed)

## Verification Results
- `npx vitest run` on all 5 files: **75 tests passed**
- `npx vitest run src/ops/`: **25 files, 412 tests passed** (2 pre-existing errors in backup.spec.ts unrelated to changes)
- `npx vitest run src/security/`: **13 files, 332 tests passed**

## Notes
- No changes made to security specs — all had adequate coverage
- backup.spec.ts has pre-existing uncaught exceptions (ENOENT on backup-freeze-test tar file) — not related to these changes
- All specs use proper isolation (tmp dirs, beforeEach/afterEach cleanup, mock reset)
