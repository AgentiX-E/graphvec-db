import { parseQuery } from "../src/query/query-parser";
import { _executeQuery } from "../src/query/query-executor";

const createQ = "CREATE (n1), (n2), (n3) CREATE (n1)-[:R]->(n2) CREATE (n2)-[:R]->(n3)";
const matchQ = "MATCH (a)-[*]-(b) DETACH DELETE a, b RETURN count(*) AS c";

async function test() {
  const ge = new (await import("../src/core/graph-engine")).GraphEngine();
  await (ge as any).query(createQ);
  const nodes = await (ge as any).query("MATCH (n) RETURN n");

  for (let i = 0; i < nodes.length; i++) {
    const edges = (nodes[i] as any).__edges || [];
    console.log(`node[${i}] label=${(nodes[i] as any)._label} edges=`,
      edges.map((e:any) => `${e.srcIdx}->${e.dstIdx}`));
  }

  const plan = parseQuery(matchQ);
  console.log("plan steps:", plan.steps?.length);
  console.log("plan.steps[0].range:", JSON.stringify((plan.steps?.[0] as any).range));
  const result = await _executeQuery(plan, nodes as any, matchQ);
  console.log("result:", JSON.stringify(result));
}
test().catch(e => console.error(e));
