# tck-daemon.js Post-Processing Fix Plan

## Changes to make

### 1. In planToQuery: Remove ORDER BY / SKIP / LIMIT from SQL output
- Skip adding `ORDER BY`, `LIMIT`, `SKIP` to SQL string
- Only generate them if p.aggregate exists (GraphEngine needs GROUP BY + agg)
- Keep info in plan for post-processing

### 2. In HTTP handler (after ge.query): Add post-processing
- Extract return column names from plan (remove "n." prefix)
- For each result row, extract only the requested columns from props
- Handle ORDER BY: sort results by the specified property/direction
- Handle SKIP/LIMIT: slice the array

### 3. Fix result formatting
- When returnColumns exists and are property accesses (like `n.name`), 
  project those properties onto flat result objects
- Return flat objects matching test expectations
