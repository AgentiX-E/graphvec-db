const { parseQuery, _executeQuery, initEngine } = require('./src/query/query-engine');

// Test with >= operator
var qGte = [
  'MATCH p = (n)-[r]->()',
  'WITH [n, r, p, \'\', 1, 3.14, true, null, [], {}] AS types',
  'UNWIND range(0, size(types) - 1) AS i',
  'UNWIND range(0, size(types) - 1) AS j',
  'WITH types[i] AS lhs, types[j] AS rhs',
  'WHERE i <> j',
  'WITH lhs, rhs, lhs >= rhs AS result',
  'WHERE result',
  'RETURN lhs, rhs'
].join('\n');

var qLte = [
  'MATCH p = (n)-[r]->()',
  'WITH [n, r, p, \'\', 1, 3.14, true, null, [], {}] AS types',
  'UNWIND range(0, size(types) - 1) AS i',
  'UNWIND range(0, size(types) - 1) AS j',
  'WITH types[i] AS lhs, types[j] AS rhs',
  'WHERE i <> j',
  'WITH lhs, rhs, lhs <= rhs AS result',
  'WHERE result',
  'RETURN lhs, rhs'
].join('\n');

async function runTest(label, query) {
  try {
    // Need a graph with 1 edge: CREATE ()-[:T]->()
    var plan = parseQuery(query);
    console.log(label + ' plan.with.columns:', plan.with ? plan.with.columns.length : 'null');
    console.log(label + ' plan.returnColumns:', JSON.stringify(plan.returnColumns));
    
    // Init engine
    initEngine({});
    
    // Create the required graph
    var createPlan = parseQuery('CREATE ()-[:T]->()');
    await _executeQuery(createPlan, []);
    
    // Execute the test query
    var result = await _executeQuery(plan, []);
    console.log(label + ' result count:', result.length);
    if (result.length > 0) {
      console.log(label + ' sample:', JSON.stringify(result.slice(0, 3)));
    } else {
      console.log(label + ' EMPTY RESULT');
    }
  } catch(e) {
    console.error(label + ' ERROR:', e.message);
  }
}

(async () => {
  await runTest('GTE >=', qGte);
  //await runTest('LTE <=', qLte);
})();
