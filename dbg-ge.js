// Debug: what does GE return for (n)-[r]->()?
const { initEngine, parseQuery } = require('./src/query/query-engine');

(async () => {
  initEngine({});
  // Create a graph with 1 edge
  var plan1 = parseQuery('CREATE ()-[:T]->()');
  await require('./src/query/query-engine')._executeQuery(plan1, []);
  
  // Check GE directly for MATCH (n)-[r]->()
  const ge = require('./src/core/graph-engine').getInstance?.() || require('./src/core/graph-engine').default;
  // Actually let's use _executeViaGraphEngine
  var plan2 = parseQuery('MATCH (n)-[r]->() RETURN n AS x');
  try {
    await require('./src/query/query-engine')._executeQuery(plan2, []);
  } catch(e) {
    console.log('Error:', e.message);
  }
})();
