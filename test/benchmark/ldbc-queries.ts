/**
 * LDBC-SNB Style Query Catalog
 *
 * 20 reference queries inspired by the LDBC Social Network Benchmark.
 * Divided into Interactive (graph traversal) and Business Intelligence (aggregation) categories.
 */

export interface LdbcQueryDef {
  id: string
  name: string
  description: string
  category: 'interactive' | 'bi'
  /** Cypher-like description of the query logic */
  cypher: string
  /** Expected return structure */
  returns: string[]
  /** Algorithm name in GraphEngine */
  engineMethod?: string
}

export const LDBC_QUERIES: LdbcQueryDef[] = [
  // ════════════════════════════════════════════════════════════
  // INTERACTIVE QUERIES — friend-of-a-friend, circle detection
  // ════════════════════════════════════════════════════════════
  {
    id: 'IQ1',
    name: 'Friend-of-a-Friend (2-hop neighbors)',
    description: 'Find friends of friends for a given person — 2-hop traversal',
    category: 'interactive',
    cypher: 'MATCH (p:Person)-[:KNOWS]->(f1:Person)-[:KNOWS]->(fof:Person) WHERE id(p) = $personId RETURN DISTINCT fof.name, fof.city',
    returns: ['friendName', 'city'],
    engineMethod: 'bfs',
  },
  {
    id: 'IQ2',
    name: 'Shortest Path Between Persons',
    description: 'Find the shortest path connecting two persons (social distance)',
    category: 'interactive',
    cypher: 'MATCH p = shortestPath((a:Person)-[:KNOWS*]-(b:Person)) WHERE id(a) = $person1 AND id(b) = $person2 RETURN length(p) AS distance',
    returns: ['distance'],
    engineMethod: 'shortestPath',
  },
  {
    id: 'IQ3',
    name: 'Common Neighbors',
    description: 'Count how many mutual friends two persons share',
    category: 'interactive',
    cypher: 'MATCH (a:Person)-[:KNOWS]-(common:Person)-[:KNOWS]-(b:Person) WHERE id(a) = $person1 AND id(b) = $person2 RETURN count(DISTINCT common) AS commonNeighbors',
    returns: ['commonNeighbors'],
    engineMethod: 'neighbors',
  },
  {
    id: 'IQ4',
    name: 'Triangle Count (Person Network)',
    description: 'Count triangles (mutual-friend triads) in the person social graph',
    category: 'interactive',
    cypher: 'MATCH (a:Person)-[:KNOWS]-(b:Person)-[:KNOWS]-(c:Person)-[:KNOWS]-(a:Person) RETURN count(DISTINCT [a.id, b.id, c.id]) / 6 AS triangles',
    returns: ['triangles'],
    engineMethod: 'triangleCount',
  },
  {
    id: 'IQ5',
    name: 'Degree Centrality (Most Connected Persons)',
    description: 'Find persons with the most KNOWS connections (social hubs)',
    category: 'interactive',
    cypher: 'MATCH (p:Person)-[:KNOWS]-() RETURN p.name, count(*) AS degree ORDER BY degree DESC LIMIT 10',
    returns: ['name', 'degree'],
    engineMethod: 'degreeCentrality',
  },
  {
    id: 'IQ6',
    name: 'Connected Components (Social Circles)',
    description: 'Identify social circles (connected components in the person graph)',
    category: 'interactive',
    cypher: 'MATCH (p:Person) RETURN p.communityId GROUP BY p.communityId',
    returns: ['componentId', 'size'],
    engineMethod: 'wcc',
  },
  {
    id: 'IQ7',
    name: 'Company Neighbors (Person Employers)',
    description: 'Find persons working at a given company',
    category: 'interactive',
    cypher: 'MATCH (p:Person)-[:WORKS_AT]->(c:Company) WHERE id(c) = $companyId RETURN p.name, p.age',
    returns: ['name', 'age'],
    engineMethod: 'neighbors',
  },
  {
    id: 'IQ8',
    name: '3-Hop Friend Recommender',
    description: 'Recommend friends-of-friends-of-friends (3-hop transitive closure)',
    category: 'interactive',
    cypher: 'MATCH (p:Person)-[:KNOWS*3]-(rec:Person) WHERE id(p) = $personId AND NOT (p)-[:KNOWS]-(rec) AND p <> rec RETURN DISTINCT rec.name, rec.city LIMIT 20',
    returns: ['name', 'city'],
    engineMethod: 'bfs',
  },
  {
    id: 'IQ9',
    name: 'Works At Same Company',
    description: 'Find persons who work at the same company as a given person',
    category: 'interactive',
    cypher: 'MATCH (p:Person)-[:WORKS_AT]->(c:Company)<-[:WORKS_AT]-(colleague:Person) WHERE id(p) = $personId RETURN colleague.name, colleague.age',
    returns: ['colleagueName', 'age'],
    engineMethod: 'neighbors',
  },
  {
    id: 'IQ10',
    name: 'Person Graph BFS Traversal',
    description: 'BFS traversal to discover the neighborhood around a person',
    category: 'interactive',
    cypher: 'MATCH (p:Person) CALL bfs(p, $maxDepth) YIELD node, distance RETURN node.name, distance',
    returns: ['name', 'distance'],
    engineMethod: 'bfs',
  },

  // ════════════════════════════════════════════════════════════
  // BUSINESS INTELLIGENCE QUERIES — aggregation, grouping, stats
  // ════════════════════════════════════════════════════════════
  {
    id: 'BI1',
    name: 'Age Distribution of Persons',
    description: 'Show age histogram of all persons',
    category: 'bi',
    cypher: 'MATCH (p:Person) RETURN p.age AS age, count(*) AS count GROUP BY p.age ORDER BY age',
    returns: ['age', 'count'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI2',
    name: 'Person Count by City',
    description: 'Count persons grouped by city',
    category: 'bi',
    cypher: 'MATCH (p:Person) RETURN p.city AS city, count(*) AS count GROUP BY city ORDER BY count DESC',
    returns: ['city', 'count'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI3',
    name: 'Company Employee Count',
    description: 'Count employees per company',
    category: 'bi',
    cypher: 'MATCH (p:Person)-[:WORKS_AT]->(c:Company) RETURN c.name AS company, count(*) AS employees GROUP BY company ORDER BY employees DESC',
    returns: ['company', 'employees'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI4',
    name: 'Industry Distribution',
    description: 'Count companies by industry sector',
    category: 'bi',
    cypher: 'MATCH (c:Company) RETURN c.industry AS industry, count(*) AS count GROUP BY industry ORDER BY count DESC',
    returns: ['industry', 'count'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI5',
    name: 'Average Age by City',
    description: 'Average age of persons grouped by city',
    category: 'bi',
    cypher: 'MATCH (p:Person) RETURN p.city AS city, avg(p.age) AS avgAge, count(*) AS pop GROUP BY city ORDER BY pop DESC',
    returns: ['city', 'avgAge', 'population'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI6',
    name: 'Most Connected Companies',
    description: 'Companies ordered by number of employees (WORKS_AT edges)',
    category: 'bi',
    cypher: 'MATCH (p:Person)-[:WORKS_AT]->(c:Company) RETURN c.name, count(p) AS employees ORDER BY employees DESC LIMIT 10',
    returns: ['company', 'employees'],
    engineMethod: 'neighbors',
  },
  {
    id: 'BI7',
    name: 'Person Age Stats',
    description: 'Statistics on person ages (min, max, avg, median)',
    category: 'bi',
    cypher: 'MATCH (p:Person) RETURN min(p.age) AS youngest, max(p.age) AS oldest, avg(p.age) AS average',
    returns: ['youngest', 'oldest', 'average'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI8',
    name: 'Friendship Density',
    description: 'Density of KNOWS edges: ratio of actual edges to possible edges',
    category: 'bi',
    cypher: 'MATCH (p1:Person), (p2:Person) WHERE id(p1) < id(p2) OPTIONAL MATCH (p1)-[:KNOWS]-(p2) RETURN count(DISTINCT p1) AS persons, count(*) AS possibleEdges, count(DISTINCT knowsEdge) AS actualEdges',
    returns: ['persons', 'possibleEdges', 'actualEdges'],
    engineMethod: 'scanAllNodes',
  },
  {
    id: 'BI9',
    name: 'Cross-Industry Employee Flow',
    description: 'Persons whose employer changed industry (approximation via shared persons)',
    category: 'bi',
    cypher: 'MATCH (p:Person)-[:WORKS_AT]->(c1:Company), (p)-[:WORKS_AT]->(c2:Company) WHERE c1.industry <> c2.industry RETURN p.name, c1.industry, c2.industry',
    returns: ['person', 'industry1', 'industry2'],
    engineMethod: 'neighbors',
  },
  {
    id: 'BI10',
    name: 'Top 5 Social Hubs per City',
    description: 'In each city, find the 5 most connected persons',
    category: 'bi',
    cypher: 'MATCH (p:Person)-[:KNOWS]-() RETURN p.city, p.name, count(*) AS degree ORDER BY p.city, degree DESC',
    returns: ['city', 'name', 'degree'],
    engineMethod: 'degreeCentrality',
  },
]

/**
 * Get all interactive queries
 */
export function getInteractiveQueries(): LdbcQueryDef[] {
  return LDBC_QUERIES.filter(q => q.category === 'interactive')
}

/**
 * Get all BI queries
 */
export function getBiQueries(): LdbcQueryDef[] {
  return LDBC_QUERIES.filter(q => q.category === 'bi')
}

/**
 * Get query by id
 */
export function getQueryById(id: string): LdbcQueryDef | undefined {
  return LDBC_QUERIES.find(q => q.id === id)
}
