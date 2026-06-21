import { GraphEngine } from "./src/core/graph-engine"

const g = new GraphEngine()
g.initialize()

// Scenario [3]: CREATE (:A)-[:LOOP]->(:B), MATCH ()--() RETURN count(*)
g.executeRaw("CREATE (:A {name:'A'})")
g.executeRaw("CREATE (:B {name:'B'})")
g.upsertEdge(0, 1, 0) // edge type 0 = LOOP

console.log("All nodes:", JSON.stringify(g.getAllNodes()))
console.log("neighbors(0):", JSON.stringify((g as any).storage.neighbors(0)))
console.log("neighbors(1):", JSON.stringify((g as any).storage.neighbors(1)))
console.log("neighbors(0, any):", JSON.stringify((g as any).storage.neighbors(0, {direction:'any'})))
console.log("neighbors(1, any):", JSON.stringify((g as any).storage.neighbors(1, {direction:'any'})))

// Direct GE query
const res = g.query("MATCH ()--() RETURN count(*) AS count")
console.log("\nGE query result:", JSON.stringify(res))
