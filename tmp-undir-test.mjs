// Direct test of GE _executeQueryPlan for undirected match
import { parseQuery } from "./src/query/query-engine"

// Step 1: parse to understand plan
const plan = parseQuery("MATCH ()--() RETURN count(*)")
console.log("Plan analysis:")
console.log("  hasMatch:", plan.hasMatch)
console.log("  scanLabel:", plan.scanLabel)
console.log("  steps:", JSON.stringify(plan.steps))
console.log("  aggregate:", JSON.stringify(plan.aggregate))
console.log("  returnColumns:", plan.returnColumns)
