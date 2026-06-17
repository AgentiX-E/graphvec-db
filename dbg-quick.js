// Test the WHERE extraction directly
const q = `MATCH p = (n)-[r]->()
WITH [n, r, p, '', 1, 3.14, true, null, [], {}] AS types
UNWIND range(0, size(types) - 1) AS i
UNWIND range(0, size(types) - 1) AS j
WITH types[i] AS lhs, types[j] AS rhs
WHERE i <> j
WITH lhs, rhs, lhs >= rhs AS result
WHERE result
RETURN lhs, rhs`.trim();

// Test WHERE extraction
let lastWhereText = '';
const withParts = q.split(/\bWITH\s+/i).filter(Boolean);
console.log('withParts count:', withParts.length);
withParts.forEach((p, i) => console.log('  part[' + i + ']:', p.substring(0, 80)));
if (withParts.length > 1) {
  const lastWith = withParts[withParts.length - 1];
  const whereMatch = lastWith.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is);
  console.log('lastWith:', lastWith.substring(0, 100));
  console.log('whereMatch:', whereMatch ? whereMatch[1] : 'none');
  if (whereMatch) lastWhereText = whereMatch[1].trim();
}
console.log('lastWhereText:', lastWhereText);

// Test the fallback
const globalWhereMatch = !lastWhereText ? q.match(/\bWHERE\s+(.+?)(?:\s+(?:RETURN|WITH|CREATE|MERGE|SET|DELETE|ORDER\s+BY|SKIP|LIMIT)\s|$)/is) : null;
console.log('globalWhereMatch:', globalWhereMatch ? globalWhereMatch[1] : 'none');
