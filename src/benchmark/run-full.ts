/**
 * run-full.ts — Full mode entry point
 */
import { full } from './runner'

async function main() {
  try {
    const baseline = await full()
    process.exit(0)
  } catch (err) {
    console.error('[full] Error:', err)
    process.exit(1)
  }
}

main()
