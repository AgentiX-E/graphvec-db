import { parseQuery } from '../src/query/query-engine'

// MW2[2] plan details
const query2 = "MATCH (advertiser)-[:ADV_HAS_PRODUCT]->(out)-[:AP_HAS_VALUE]->(red)<-[:AA_HAS_VALUE]-(a) WHERE advertiser.id = $1 AND a.id = $2 AND red.name = 'red' AND out.name = 'product1' RETURN out.name"
const plan2 = parseQuery(query2, { '1': 0, '2': 1 })

console.log('=== MW2[2] Full Plan ===')
console.log(JSON.stringify(plan2, null, 2))

console.log('\n=== Filter details ===')
for (const f of plan2.filters!) {
  console.log(`  source=${f.source}, property=${f.property}, op=${f.operator}, value=${f.value}`)
}

console.log('\n=== Step details ===')
for (let i = 0; i < plan2.steps!.length; i++) {
  const s = plan2.steps![i]
  console.log(`  step[${i}]: source=${s.source}, direction=${s.direction}, edgeLabel=${s.edgeLabel}, targetAlias=${s.targetAlias}, targetLabel=${s.targetLabel}`)
}

// MW2[1] plan details
const query1 = "MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE a.id = 1 AND c.id = 2 RETURN d"
const plan1 = parseQuery(query1)
console.log('\n=== MW2[1] Full Plan ===')
console.log(JSON.stringify(plan1, null, 2))
