import { GraphEngine } from "./src/core/graph-engine"
import { ClassicLevelStorageProvider } from "./src/core/storage-classic-level"

const storage = new ClassicLevelStorageProvider()
const ge = new GraphEngine({ path: "/tmp/ge-undir-test" }, storage)
ge.initialize()
ge.clear()

// Create 2 nodes and an undirected edge
ge.executeRaw("CREATE (:A {name:'A'})")
ge.executeRaw("CREATE (:B {name:'B'})")
ge.upsertEdge(0, 1, 0) // A->B, LOOP type

// Plan: MATCH ()--() RETURN count(*)
const plan = {
  hasMatch: true,
  scanLabel: null,
  steps: [{ source: "", targetAlias: "", direction: "any" as const, edgeLabel: null, edgeProps: null, targetLabel: null, targetProps: null }],
  filters: [],
  existsFilters: [],
  aggregate: { function: "count", column: "count(*)", type: "count", field: "*" } as any,
}

const result = (ge as any)._executeQueryPlan(plan)
console.log("GE _executeQueryPlan result:", JSON.stringify(result))
console.log("Expected: [{count: 2}]")
