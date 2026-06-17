const antlr4 = require('antlr4').default;
const { CypherLexer, CypherParser } = require('@neo4j-cypher/antlr4');
var q = 'UNWIND range(0, size(types) - 1) AS i RETURN i';

var is = new antlr4.InputStream(q);
var lexer = new CypherLexer(is);
var tokens = new antlr4.CommonTokenStream(lexer);
var parser = new CypherParser(tokens);
parser.buildParseTrees = true;
var tree = parser.cypher();

// Find the unwind clause and its children
function findUnwind(node, depth) {
  if (!node || !node.children) return;
  var name = node.constructor ? node.constructor.name : '?';
  if (name === 'UnwindClauseContext') {
    // Dump this node's immediate children only
    console.log('=== UnwindClauseContext (text: ' + node.getText().substring(0, 100) + ') ===');
    node.children.forEach(function(c, i) {
      var cn = c.constructor ? c.constructor.name : '?';
      var ct = '';
      try { ct = c.getText ? c.getText().substring(0, 60) : ''; } catch(e) {}
      console.log('  child[' + i + ']: ' + cn + ' = ' + ct);
      // Also show children's children for VariableContext
      if (c.children) {
        c.children.forEach(function(cc, j) {
          var ccn = cc.constructor ? cc.constructor.name : '?';
          var cct = '';
          try { cct = cc.getText ? cc.getText().substring(0, 60) : ''; } catch(e) {}
          console.log('    child[' + j + ']: ' + ccn + ' = ' + cct);
        });
      }
    });
    return;
  }
  if (depth > 20) return;
  if (node.children) {
    node.children.forEach(function(c) { findUnwind(c, depth + 1); });
  }
}
findUnwind(tree, 0);
