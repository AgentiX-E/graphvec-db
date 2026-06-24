/**
 * run-perf.ts — Perf mode entry point
 */
import { perf } from './runner'

async function main() {
  try {
    const baseline = await perf()
    process.exit(0)
  } catch (err) {
    console.error('[perf] Error:', err)
    process.exit(1)
  }
}

main()
