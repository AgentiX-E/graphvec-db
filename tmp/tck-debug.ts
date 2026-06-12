import { GraphEngine } from '/home/admin/openclaw/workspace/agentiX-graphvec/src/core/graph-engine'
import { parseQuery } from '/home/admin/openclaw/workspace/agentiX-graphvec/src/query/query-engine'

// Create GE and seed nodes for MatchWhere1 scenario [1]
const ge = new GraphEngine({ path: '/tmp/tck-debug-ge', denseVector: { dimension: 384 } } as any)
ge.open()

// Execute the CREATE with relationship
const createQ = "CREATE (:A {id: 0})<-[:ADMIN]-(:B {id: 1})-[:ADMIN]->(:C {id: 2, a: 'A'})"
console.log("CREATE query:", createQ)

const plan = parseQuery(createQ)
console.log("CREATE plan type:", plan?.type)
console.log("CREATE plan create:", JSON.stringify(plan?.create ?? []).substring(0, 500))

// Execute via GE internal
try {
  const raw = (ge as any)._executeQueryPlan(plan)
  console.log("GE result:", JSON.stringify(raw).substring(0, 1000))
} catch(e: any) {
  console.log("GE error:", e.message)
}

// Check if nodes exist via GE string query
try {
  const result = ge.query("MATCH (n) RETURN n")
  console.log("MATCH result:", JSON.stringify(result).substring(0, 2000))
} catch(e: any) {
  console.log("MATCH query error:", e.message)
}

// Try MATCH with relationship via GE internal
const matchPlan = parseQuery("MATCH (a)-[:ADMIN]-(b) WHERE a:A RETURN a.id, b.id")
console.log("MATCH plan type:", matchPlan?.type, "steps:", matchPlan?.steps?.length)
try {
  const raw = (ge as any)._executeQueryPlan(matchPlan)
  console.log("MATCH GE result:", JSON.stringify(raw).substring(0, 2000))
} catch(e: any) {
  console.log("MATCH GE error:", e.message)
}

ge.close()
