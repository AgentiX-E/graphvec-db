// Test MW1[11] through _executeViaGraphEngine
// This uses the full executor path including whereBody processing

async function main() {
  // First, let me check how tests actually run queries.
  // Looking at the split spec files for how execQuery works
  const fs = await import('fs')
  const path = await import('path')

  // Find a working test to see how execQuery is set up
  const testFile = 'src/query/cypher-tck/split/tck-TCK___EDGE_边操作.spec.ts'
  console.log('=== Reading test setup pattern ===')
  const content = fs.readFileSync(testFile, 'utf-8')
  // Show first 50 lines
  const lines = content.split('\n').slice(0, 80)
  console.log(lines.join('\n'))
}

main().catch(e => { console.error(e); process.exit(1) })
