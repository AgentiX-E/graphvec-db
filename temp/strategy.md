// ==== V5: Minimal precise comma-expansion ====
// Strategy: 
// 1. _ceComma detection (source gap or targetAlias reuse)
// 2. boundedTargetIndices guard for comma case
// 3. Comma expansion: extract real source var from query text, walk 1 step, 
//    add variant rows that are NOT already covered by the chain walk

// Query for MW2[1]: MATCH (a)--(b)--(c)--(d)--(a), (b)--(d) WHERE ...
// Comma-step is (b)--(d), needs source='b' not 'a'
// Regex: /,\s*\(([a-zA-Z_]\w*)\)\s*--\s*\(d\)/i → captures 'b'
