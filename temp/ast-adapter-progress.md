# AST → QueryPlan 转换器进度

## Batch 1: MATCH + RETURN + WHERE (基础)
- [ ] MATCH (n:Label) RETURN n
- [ ] MATCH (n) WHERE n.prop > val RETURN n
- [ ] MATCH (a)-[:REL]->(b) RETURN a, b
- [ ] MATCH (n) RETURN n.prop AS alias
- [ ] MATCH (n) RETURN count(*) AS cnt
- [ ] MATCH (n) RETURN n ORDER BY n.prop
- [ ] MATCH (n) RETURN n LIMIT 10

## Batch 2: CREATE / DELETE / MERGE / SET / REMOVE
- [ ] CREATE / DETACH DELETE
- [ ] MERGE / SET / REMOVE

## Batch 3: UNWIND / FOREACH / WITH / OPTIONAL MATCH
- [ ] UNWIND / FOREACH
- [ ] WITH / OPTIONAL MATCH

## Batch 4: SET_OPS / SUBQUERY / CALL / INDEX
- [ ] UNION / INTERSECT / SUBTRACT
- [ ] CALL / EXISTS subquery
- [ ] SHOW / INDEX / CONSTRAINT
