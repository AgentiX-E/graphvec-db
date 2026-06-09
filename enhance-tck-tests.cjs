/**
 * Script to enhance TCK EXT tests with runtime _executeQuery assertions.
 * 
 * For each test('...') block matching the weak pattern:
 *   const plan = execQuery("...")
 *   expect(plan).toBeDefined()
 *   expect(plan.type).toBeDefined()
 * 
 * Adds:
 *   if (plan) { const result = _executeQuery(plan, <data>); expect(result).toBeDefined() }
 * 
 * Where <data> is determined based on the query content:
 *   - MATCH queries → mock node data
 *   - UNWIND/FOREACH with MATCH → mock node data
 *   - RETURN-only (pure expressions) → []
 */

const fs = require('fs');
const path = require('path');

const filePath = path.resolve(__dirname, 'src/query/cypher-tck/openCypher-tck.spec.ts');
let content = fs.readFileSync(filePath, 'utf-8');
const lines = content.split('\n');

const MOCK_NODE = JSON.stringify([{ _label: 'Person', name: 'Alice', age: 30, city: 'NYC', status: 'active', id: 1 }]);
const EMPTY_ARRAY = '[]';

/**
 * Determine the data argument based on the query text.
 */
function getDataForQuery(queryText) {
  // Always return the mock data for any test that might involve nodes
  // This is safe because _executeQuery with extra data just means more nodes to filter against
  // Pure expression queries (RETURN without MATCH) should work fine with any data
  
  const q = queryText.toUpperCase();
  
  // These involve graph operations that need data
  if (q.includes('MATCH ') || q.includes('MATCH(')) {
    return MOCK_NODE;
  }
  if (q.includes('UNWIND ') && q.includes('MATCH ')) {
    return MOCK_NODE;
  }
  if (q.includes('MERGE ')) {
    return MOCK_NODE;
  }
  if (q.includes('FOREACH ') && q.includes('MATCH ')) {
    return MOCK_NODE;
  }
  
  // Pure expressions / CREATE / UNWIND without MATCH work with empty data
  return EMPTY_ARRAY;
}

/**
 * Check if a query involves graph pattern matching (needs data)
 */
function needsMockData(queryText) {
  const q = queryText.toUpperCase();
  return q.includes('MATCH ') || q.includes('MATCH(') || q.includes('MERGE ') || 
         q.includes('DELETE ') || q.includes('DETACH ') ||
         q.includes('SET ') || q.includes('REMOVE ') ||
         (q.includes('UNWIND ') && q.includes('MATCH ')) ||
         (q.includes('FOREACH ') && q.includes('MATCH ')) ||
         q.includes('OPTIONAL MATCH ') ||
         q.includes('CALL ') ||
         q.includes('CREATE ') ||
         q.includes('SHOW ') ||
         q.includes('DROP ');
}

/**
 * Mock data for different query types
 */
function getMockData(queryText) {
  const q = queryText.toUpperCase();
  
  // For DDL/admin queries, still try with mock data
  // For MATCH queries
  if (q.includes('MATCH ') || q.includes('MERGE ') || q.includes('FOREACH ')) {
    return MOCK_NODE;
  }
  
  // Pure expression queries
  return EMPTY_ARRAY;
}

/**
 * Extract query text from execQuery('...') or execQuery("...")
 */
function extractQueryText(line) {
  // Match: execQuery('...') or execQuery("...")
  const singleMatch = line.match(/execQuery\s*\(\s*'([^']*)'/);
  if (singleMatch) return singleMatch[1];
  
  const doubleMatch = line.match(/execQuery\s*\(\s*"([^"]*)"/);
  if (doubleMatch) return doubleMatch[1];
  
  // Template literals (backtick)
  const backtickMatch = line.match(/execQuery\s*\(\s*`([^`]*)`/);
  if (backtickMatch) return backtickMatch[1];
  
  return null;
}

// Process the file
let result = [];
let i = 0;
let modifiedCount = 0;
let totalTestBlocks = 0;
let insideTestBlock = false;
let testBlockLines = [];
let testBlockStartIdx = -1;
let hasExecQuery = false;
let queryText = null;
let hasWeakAssertions = false;
let hasExecuteQuery = false;

function processTestBlock() {
  if (!hasExecQuery || !hasWeakAssertions) return;
  
  // Find the last assertion line
  let lastAssertIdx = -1;
  for (let j = 0; j < testBlockLines.length; j++) {
    const line = testBlockLines[j];
    if (line.includes('expect(plan).toBeDefined()') || line.includes('expect(plan.type).toBeDefined()')) {
      lastAssertIdx = j;
    }
  }
  
  if (lastAssertIdx < 0) return;
  
  const data = getMockData(queryText || '');
  
  // Build the new line(s) to insert
  // Need to match indentation of surrounding code
  const originalLine = testBlockLines[lastAssertIdx];
  const indent = originalLine.match(/^(\s*)/)[1];
  
  const newLines = [
    `${indent}if (plan) {`,
    `${indent}  const result = _executeQuery(plan, ${data})`,
    `${indent}  expect(result).toBeDefined()`,
    `${indent}}`,
  ];
  
  // Insert after the last assertion
  testBlockLines.splice(lastAssertIdx + 1, 0, ...newLines);
}

// Process line by line
while (i < lines.length) {
  const line = lines[i];
  
  // Start of a test block (only consider TCK EXT / describe blocks that use execQuery pattern)
  // We process ALL describes, but only modify tests with weak pattern
  if (line.trim().startsWith("test('") || line.trim().startsWith("it('")) {
    totalTestBlocks++;
    
    if (insideTestBlock) {
      // We were already inside a test block - process it
      processTestBlock();
    }
    
    // Start new test block
    insideTestBlock = true;
    testBlockLines = [line];
    testBlockStartIdx = result.length;
    hasExecQuery = false;
    queryText = null;
    hasWeakAssertions = false;
    hasExecuteQuery = false;
    
    // Check if this line has execQuery
    if (line.includes('execQuery(')) {
      hasExecQuery = true;
      queryText = extractQueryText(line);
    }
  } else if (line.trim() === '}, 10000)' || line.trim() === '})') {
    if (insideTestBlock) {
      testBlockLines.push(line);
      processTestBlock();
      
      // Push processed block
      result.push(...testBlockLines);
      
      insideTestBlock = false;
      testBlockLines = [];
    } else {
      result.push(line);
    }
  } else if (insideTestBlock) {
    testBlockLines.push(line);
    
    if (line.includes('execQuery(')) {
      hasExecQuery = true;
      queryText = extractQueryText(line);
    }
    if (line.includes('expect(plan).toBeDefined()') || line.includes('expect(plan.type).toBeDefined()')) {
      hasWeakAssertions = true;
    }
    if (line.includes('_executeQuery(plan')) {
      hasExecuteQuery = true;
      hasWeakAssertions = false; // Already has execute, skip
    }
  } else {
    result.push(line);
  }
  
  i++;
}

// Handle last test block
if (insideTestBlock) {
  processTestBlock();
  result.push(...testBlockLines);
}

const newContent = result.join('\n');
fs.writeFileSync(filePath, newContent, 'utf-8');

// Count changes
let oldExecQueryCalls = (content.match(/execQuery/g) || []).length;
let newExecuteQueryCalls = (newContent.match(/_executeQuery\(plan/g) || []).length;
let newIfPlanBlocks = (newContent.match(/if \(plan\) \{/g) || []).length;

console.log(`Total test blocks processed: ${totalTestBlocks}`);
console.log(`Old execQuery calls: ${oldExecQueryCalls}`);
console.log(`Total _executeQuery(plan calls: ${newExecuteQueryCalls}`);
console.log(`"if (plan) {" blocks added: ${newIfPlanBlocks}`);

// Count weak patterns remaining
const oldWeakCount = (content.match(/expect\(plan\)\.toBeDefined\(\)\s*\n\s*expect\(plan\.type\)\.toBeDefined\(\)/g) || []).length;
const newWeakCount = (newContent.match(/expect\(plan\)\.toBeDefined\(\)\s*\n\s*expect\(plan\.type\)\.toBeDefined\(\)/g) || []).length;
console.log(`Old weak patterns: ${oldWeakCount}`);
console.log(`New weak patterns: ${newWeakCount}`);

// Count lines
console.log(`\nOld line count: ${lines.length}`);
console.log(`New line count: ${result.length}`);
