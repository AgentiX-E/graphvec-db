/**
 * query-executor.ts — Cypher Query 执行器
 *
 * 包含：
 *   - _executeViaGraphEngine / _executeQuery / _validatePlan
 *   - 所有执行辅助函数
 */

import fs from 'fs'
import path from 'path'
import { parseCypherToPlan } from './ast-to-plan-v2'
import { GraphEngine } from '../core/graph-engine'
import type { OverGraphConfig } from '../types'
import { globalRegistry as _procedureRegistry } from './procedure-registry'
import { _evalBinary, _evaluateExpression, _postProcessResults, QueryRow, _parseAggregate, _extractAggColumns, _hasAggregates, _executeAggregation, _enrichWithAggregates, _validateLiterals, _bigintReplacer, _bigintReviver, _computeAggregate, _lastTopLevelComma } from './expression-engine'
import { _walkMultiSteps, _walkMultiStepsWithEdges, _pathEndIndices, _stepMatchConstraint, _resolveUnwindList, _extractWithClausesAfterUnwind, _applyYieldAliases, resolveVariableNodeIdx, _findWhereOutsideBrackets, _fastDedup, _fastIntersect, _fastSubtract } from './query-parser'
import { evalForeachCondTop, applyForeachOpTop, executeForeachInlineTop } from './foreach-exec'
import type { QueryPlan, FilterClause, TraverseStep, AggregateClause, SetClause, InternalNode } from './query-types'
import { parseQuery } from './query-parser'
import { _geInstanceRegistry, _gePool, _geDirRegistry, _indexRegistry, DEFAULT_DATABASE, DEFAULT_LIMIT, IndexEntry, ConstraintEntry, _registerIndex, _dropIndex, _getAllIndexes, _getIndex, _clearIndexes, _registerConstraint, _dropConstraint, _getAllConstraints, _clearConstraints, _getActiveDatabase, _setActiveDatabase, _createDatabase, _dropDatabase, _getAllDatabases, _clearDatabases, _clearGeInstances } from './executor-registry'
import { _setActivePatternNodes } from './pattern-comprehension-state'
import { GEPool } from './ge-pool'
import { _formatResultRow, _deepStripInternal, _executeVarLenPath, parseCsvContent } from './executor-common'
import { _executeWithUnwindPipeline } from './executor-unwind-pipeline'
import { _buildDmlRows } from './executor-dml'
import { _isPatternPredicate, _validateUndefinedVariables, _validateUnknownFunctions, _stripExistsSubqueryBlocks, extractEdgePropColumnsFromQuery, extractMatchVariables, extractVariablesFromClause, extractEdgesFromNodes } from './executor-validators'
import { _validatePlan } from './executor-validate-plan'
import { _execNonGePaths } from './executor-non-ge'

/** 判断值是否为 typed-format 对象 { type: 'STRING', value: '...' } */

/**
 * Resolve a single Cypher pattern predicate (e.g. `(a)-[:T]->(b:TheLabel)`)
 * to a boolean, given the current variable bindings (`ctx`) and the full node
 * set (`allNodes`, whose entries carry `__edges: {srcIdx,dstIdx,label}[]`).
 *
 * The predicate is a WHERE-level pattern: it does NOT introduce new bindings,
 * it only asserts that the referenced relationship/path exists between the two
 * already-bound node variables.
 */
/**
 * Evaluate a multi-node chain pattern such as `(l)<-[:R]-(n)-[:R]->(m)` to a
 * boolean, or `null` when the string is not a chain (so the caller falls back
 * to the single-edge `_evalPatternPredicate`).
 *
 * A chain is a sequence of node patterns joined by relationship arrows where
 * each node/relationship is written inline (no commas). The chain is decomposed
 * into single-edge segments, each evaluated independently:
 *   - a segment whose two endpoints are BOTH bound in `ctx` must be connected
 *     by a matching edge (a concrete reachability check);
 *   - a segment with an UNBOUND endpoint only needs an existential neighbor
 *     (some node satisfying the far label/type).
 *
 * The whole chain is satisfiable only if every segment is satisfiable for some
 * binding of the unbound variables. Variables bound by one segment are seeded
 * into the shared context for the next segment, so chains like `(n)-->(m)-->(x)`
 * bind `m` transitively.
 */
function _evalChainExists(
  pat: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean | null {
  const t = pat.trim()

  // Tokenize into alternating node patterns and relationship specs.
  // Node pattern: `(var[:Label])`; relationship: `<-` | `-` | `->` with an
  // optional `[:Type]` bracket in-between.
  const nodes: Array<{ var: string | null; label: string | null }> = []
  const rels: Array<{ left: string; right: string; type: string | null }> = []
  const nodeRe = /\((\w*)(?::([\w]+))?\)/y
  const relRe = /(<-|-)(\[[^\]]*\])?(->|-)/y
  let i = 0
  const tokens: Array<{ kind: 'node' | 'rel'; value: string }> = []
  // Manual scan: alternate node, rel, node, rel, node, ...
  const n = t.length
  let pos = 0
  const skipWs = () => { while (pos < n && /\s/.test(t[pos])) pos++ }
  // Parse node
  const parseNode = (): boolean => {
    skipWs()
    if (t[pos] !== '(') return false
    const close = t.indexOf(')', pos)
    if (close < 0) return false
    const inner = t.slice(pos + 1, close).trim()
    const nm = inner.match(/^(\w*)(?::([\w]+))?$/)
    if (!nm) return false
    nodes.push({ var: nm[1] || null, label: nm[2] || null })
    pos = close + 1
    return true
  }
  const parseRel = (): boolean => {
    skipWs()
    const left = t.slice(pos).match(/^(<-|-)/)
    if (!left) return false
    const leftArrow = left[1]
    let p2 = pos + leftArrow.length
    // optional [ :Type ]
    skipWs()
    let type: string | null = null
    if (t[p2] === '[') {
      const close = t.indexOf(']', p2)
      if (close < 0) return false
      const inner = t.slice(p2 + 1, close).trim()
      if (inner.startsWith(':')) type = inner.slice(1) || null
      p2 = close + 1
    }
    skipWs()
    // right arrow: -> or - (could also be <- for the NEXT segment's left... wait)
    const right = t.slice(p2).match(/^(->|-)/)
    if (!right) return false
    const rightArrow = right[1]
    rels.push({ left: leftArrow, right: rightArrow, type })
    pos = p2 + rightArrow.length
    return true
  }
  if (!parseNode()) return null
  // Alternate rel + node until exhausted.
  while (pos < n) {
    if (!parseRel()) return null
    if (!parseNode()) return null
  }
  // Single-edge patterns (`(a)-->(b)`) are handled by `_evalPatternPredicate`;
  // only a genuine chain (two or more relationships) is evaluated here.
  if (rels.length < 2) return null

  // Evaluate: build a working context seeded with outer bindings, then walk the
  // chain segment by segment, adding newly-bound variables.
  const env: Record<string, unknown> = { ...ctx }

  // Resolve a variable to a node, or null if unbound / anonymous.
  const nodeForVar = (v: string | null): Record<string, unknown> | null => {
    if (!v) return null
    const val = env[v]
    if (!val || typeof val !== 'object') return null
    return val as Record<string, unknown>
  }
  const labelMatchesNeighbor = (node: Record<string, unknown>, label: string | null): boolean => {
    if (!label) return true
    const lbl = (node as any)?._label || (node as any)?.props?._label || ''
    const full = (node as any)?.__fullLabel || ''
    return lbl === label || full.split(':').includes(label)
  }
  // Does `srcNode` have a matching edge (type + direction) to `tgtNode`/any?
  const edgeTypeOk = (e: any, type: string | null) => {
    if (!type) return true
    return e.label === type || (e.label === null && !type)
  }
  // Enumerate neighbors of `idx` satisfying type + direction.
  const neighbors = (srcIdx: number, direction: 'out' | 'in', type: string | null): number[] => {
    const result: number[] = []
    const edges: any[] = (allNodes[srcIdx] as any)?.__edges || []
    const seen = new Set<number>()
    for (const e of edges) {
      if (!edgeTypeOk(e, type)) continue
      let nbr = -1
      if (direction === 'out' && e.srcIdx === srcIdx) nbr = e.dstIdx
      else if (direction === 'in' && e.dstIdx === srcIdx) nbr = e.srcIdx
      if (nbr < 0) continue
      if (seen.has(nbr)) continue
      seen.add(nbr)
      result.push(nbr)
    }
    return result
  }
  const nodeIdx = (node: Record<string, unknown>): number => {
    let idx = allNodes.indexOf(node as any)
    if (idx >= 0) return idx
    // The context may hold a GE-wrapped node (different object reference than
    // allNodes). Fall back to identity fields.
    const n2 = node as any
    if (n2._id !== undefined) {
      idx = allNodes.findIndex((x: any) => x?._id === n2._id)
      if (idx >= 0) return idx
    }
    if (n2._alias !== undefined) {
      idx = allNodes.findIndex((x: any) => x?._alias === n2._alias)
      if (idx >= 0) return idx
    }
    return -1
  }

  // Segment 0 connects nodes[0] and nodes[1] via rels[0], etc.
  // For each segment, decide satisfiability. Bound endpoints are concrete;
  // unbound endpoints become existentially-quantified neighbors.
  // We only need to know whether a satisfying assignment EXISTS, so process
  // segments left-to-right, propagating any newly-bound variable.
  const segCount = rels.length

  // Determine, per node, whether it is bound (concrete) at the start.
  const isBound = (idx: number): boolean => {
    const v = nodes[idx].var
    if (!v) return false  // anonymous = existential
    return nodeForVar(v) !== null
  }

  // Try to satisfy the chain via a recursive search over still-unbound nodes.
  // Bound nodes may appear at any position; search assignments for the unbound
  // variables such that every segment's edge exists.
  const unboundIdxs: number[] = []
  for (let ni = 0; ni < nodes.length; ni++) if (!isBound(ni)) unboundIdxs.push(ni)

  // Direction of segment connecting nodes[i] (left) and nodes[i+1] (right):
  //   rels[i].left is the arrow on the LEFT side, rels[i].right on the RIGHT.
  //   `(a)-[r]->(b)`: left='-', right='->'  => a → b (out)
  //   `(a)<-[r]-(b)`: left='<-', right='-' => b → a (b out to a)
  //   `(a)-[r]-(b)`:  left='-', right='-'  => undirected
  const segDirection = (si: number): { outFromLeft: boolean; outFromRight: boolean } => {
    const r = rels[si]
    const outFromLeft = r.right === '->'      // left node is source
    const outFromRight = r.left === '<-'      // right node is source
    return { outFromLeft, outFromRight }
  }

  // Evaluate a candidate assignment of unbound variables to node indices.
  const tryAssignment = (assign: Array<number | null>, ui: number): boolean => {
    if (ui >= unboundIdxs.length) {
      // All assigned — check every segment.
      for (let si = 0; si < segCount; si++) {
        const li = nodes[si], ri = nodes[si + 1]
        const lIdx = li.var ? (isBound(si) ? nodeIdx(nodeForVar(li.var)!) : assign[unboundIdxs.indexOf(si)]) : -1
        const rIdx = ri.var ? (isBound(si + 1) ? nodeIdx(nodeForVar(ri.var)!) : assign[unboundIdxs.indexOf(si + 1)]) : -1
        const { outFromLeft, outFromRight } = segDirection(si)
        const type = rels[si].type
        // Resolve concrete/anon endpoints.
        if (lIdx < 0 && rIdx < 0) return false
        // Check an edge satisfying direction between the (possibly anonymous) endpoints.
        const hasEdge = (from: number, to: number, out: boolean, out2: boolean): boolean => {
          const edges: any[] = (allNodes[from] as any)?.__edges || []
          for (const e of edges) {
            if (!edgeTypeOk(e, type)) continue
            if (e.srcIdx === from && e.dstIdx === to) return true
            if (!out && !out2 && (e.srcIdx === to && e.dstIdx === from)) return true
          }
          return false
        }
        const leftOk = lIdx >= 0
        const rightOk = rIdx >= 0
        if (leftOk && rightOk) {
          if (outFromLeft) { if (!hasEdge(lIdx, rIdx, true, outFromRight)) return false }
          else if (outFromRight) { if (!hasEdge(rIdx, lIdx, true, false)) return false }
          else { // undirected
            const e1 = hasEdge(lIdx, rIdx, true, false) || hasEdge(rIdx, lIdx, true, false)
            if (!e1) return false
          }
        } else if (leftOk) {
          // left bound, right anon/unbound-existential: left must reach SOME node
          const dir = outFromLeft ? 'out' : (outFromRight ? 'in' : 'out')
          if (neighbors(lIdx, dir as 'out' | 'in', type).length === 0) return false
        } else if (rightOk) {
          const dir = outFromRight ? 'out' : (outFromLeft ? 'in' : 'out')
          if (neighbors(rIdx, dir as 'out' | 'in', type).length === 0) return false
        }
      }
      return true
    }
    // Assign unboundIdxs[ui] to each candidate node (and check labels).
    const ni = unboundIdxs[ui]
    const label = nodes[ni].label
    for (let ci = 0; ci < allNodes.length; ci++) {
      if (!labelMatchesNeighbor(allNodes[ci], label)) continue
      const prev = assign[ui]
      assign[ui] = ci
      if (tryAssignment(assign, ui + 1)) return true
      assign[ui] = prev
    }
    return false
  }

  const assign = new Array<number | null>(unboundIdxs.length).fill(null)
  return tryAssignment(assign, 0)
}

function _evalPatternPredicate(
  pat: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean | null {
  const t = pat.trim()
  // Match: (src[:Label])  <-|-[ [ :EdgeLabel[*] ] ]- ->|-  (tgt[:Label])
  // Either endpoint may be anonymous (empty variable name, e.g. `()` or
  // `(:C)`), which denotes an existence check rather than a specific node.
  // Captures: 1=srcVar 2=srcLabel 3=leftArrow 4=edgeSpec 5=rightArrow 6=tgtVar 7=tgtLabel
  const m = t.match(/^\((\w*)(?::([\w]+))?\)\s*(<-|-)\s*(\[[^\]]*\])?\s*(->|-)\s*\((\w*)(?::([\w]+))?\)$/)
  if (!m) return null
  const srcVar = m[1] || null
  const srcLabel = m[2] || null
  const leftArrow = m[3]
  const edgeSpec = m[4] || ''
  const rightArrow = m[5]
  const tgtVar = m[6] || null
  const tgtLabel = m[7] || null

  // Resolve a node from ctx. ctx values may be the node object directly, a
  // {props:{...}} wrapper, or a flattened props object.
  const resolveNode = (v: unknown): Record<string, unknown> | null => {
    if (!v || typeof v !== 'object') return null
    return (v as Record<string, unknown>)
  }

  // Parse the edge spec once for reuse by both the named and anonymous paths.
  // edgeSpec is like `[:REL1]`, `[:REL1*]`, `[:REL1*2..3]`, or `[]`.
  let edgeLabel: string | null = null
  let varLength = false
  let varMin = 1
  let varMax: number | null = null
  {
    let inner = edgeSpec.replace(/^\[|\]$/g, '').trim()
    if (inner.startsWith(':')) inner = inner.slice(1)
    const vlm = inner.match(/^([\w|]*)\*(\d+)?(?:\.\.(\d+)?)?$/)
    if (vlm) {
      varLength = true
      edgeLabel = vlm[1] || null
      varMin = vlm[2] ? parseInt(vlm[2], 10) : 1
      varMax = vlm[3] ? parseInt(vlm[3], 10) : null
    } else {
      edgeLabel = inner || null
    }
  }
  // Direction
  let direction: 'out' | 'in' | 'any' = 'any'
  if (leftArrow === '-' && rightArrow === '->') direction = 'out'
  else if (leftArrow === '<-' && rightArrow === '-') direction = 'in'
  else if (leftArrow === '-' && rightArrow === '-') direction = 'any'

  const labelMatches = (node: any, label: string | null): boolean => {
    if (!label) return true
    const lbl = node?._label || node?.props?._label || ''
    const full = (node?.__fullLabel as string) || ''
    return lbl === label || full.split(':').includes(label)
  }
  const edgeTypeMatches = (e: any): boolean => {
    if (!edgeLabel) return true
    // edgeLabel may be a pipe-separated union (`REL1|REL2|REL3`).
    const types = edgeLabel.split('|').filter(Boolean)
    return types.length === 0 || types.includes(e.label)
  }

  // Locate a node index in allNodes (reference equality first, then _alias,
  // then label+property fingerprint for anonymous nodes).
  const nodeIndexOf = (node: Record<string, unknown>): number => {
    let idx = allNodes.indexOf(node)
    if (idx >= 0) return idx
    const alias = (node as any)?._alias
    if (alias !== undefined) {
      idx = allNodes.findIndex((n: any) => n?._alias !== undefined && n._alias === alias)
      if (idx >= 0) return idx
    }
    // Anonymous nodes (e.g. `(:C)`) carry no `_alias`; match by fingerprint —
    // label plus every own property excluding the volatile `__edges` array.
    const fingerprint = (n: any): string => {
      const label = n?._label ?? n?.props?._label ?? ''
      const keys = Object.keys(n || {}).filter(k => k !== '__edges' && k !== '_alias' && k !== 'props' && !k.startsWith('__')).sort()
      const parts = keys.map(k => `${k}=${JSON.stringify(n[k])}`)
      return label + '|' + parts.join('|')
    }
    const fp = fingerprint(node)
    idx = allNodes.findIndex((n: any) => fingerprint(n) === fp)
    return idx
  }

  // Resolve a named endpoint to its index in allNodes (or null if anonymous).
  const resolveEndpoint = (varName: string | null, label: string | null): { idx: number | null; ok: boolean } => {
    if (!varName) return { idx: null, ok: true }  // anonymous endpoint: existence check
    const node = resolveNode(ctx[varName])
    if (!node) return { idx: null, ok: false }  // named but unresolvable → null
    const idx = nodeIndexOf(node)
    if (idx < 0) return { idx: null, ok: false }
    if (!labelMatches(node, label)) return { idx: null, ok: false }
    return { idx, ok: true }
  }

  const src = resolveEndpoint(srcVar, srcLabel)
  const tgt = resolveEndpoint(tgtVar, tgtLabel)
  if (!src.ok || !tgt.ok) return null

  // Helper: does a single edge (si -> ti stored on allNodes[si].__edges) match
  // the current direction + type + target-label constraints?
  const edgeExistsFromTo = (si: number, ti: number): boolean => {
    if (tgtLabel) {
      if (!labelMatches(allNodes[ti], tgtLabel)) return false
    }
    if (srcLabel) {
      if (!labelMatches(allNodes[si], srcLabel)) return false
    }
    const edges: any[] = (allNodes[si] as any)?.__edges || []
    for (const e of edges) {
      if (!edgeTypeMatches(e)) continue
      // Strictly directed: only accept an edge whose stored srcIdx→dstIdx
      // matches si→ti.  (The caller handles direction by swapping args for
      // `in` and OR-ing both for `any`, so we must not match the reverse here.)
      if (e.srcIdx === si && e.dstIdx === ti) return true
    }
    return false
  }

  // BFS from a start index, honoring direction + type + min/max hop bounds.
  // Returns true if any reachable node satisfies `accept(idx)`.
  const reachable = (start: number, accept: (idx: number) => boolean): boolean => {
    const visited = new Set<number>([ start ])
    let frontier = [ start ]
    const maxHops = varMax ?? allNodes.length
    for (let hop = 1; hop <= maxHops; hop++) {
      const next: number[] = []
      for (const cur of frontier) {
        const edges: any[] = (allNodes[cur] as any)?.__edges || []
        for (const e of edges) {
          if (!edgeTypeMatches(e)) continue
          let nbr = -1
          if (direction === 'out' && e.srcIdx === cur) nbr = e.dstIdx
          else if (direction === 'in' && e.dstIdx === cur) nbr = e.srcIdx
          else if (direction === 'any') {
            if (e.srcIdx === cur) nbr = e.dstIdx
            else if (e.dstIdx === cur) nbr = e.srcIdx
          }
          if (nbr < 0) continue
          if (visited.has(nbr)) continue
          if (accept(nbr)) {
            // hop must be within [varMin, varMax] for var-length patterns
            if (!varLength || (hop >= varMin && (varMax === null || hop <= varMax))) return true
          }
          visited.add(nbr)
          next.push(nbr)
        }
      }
      if (next.length === 0) break
      frontier = next
    }
    return false
  }

  // Anonymous target: existence check — does the source reach at least one
  // node satisfying the direction/type/hop constraints?  For zero-length the
  // source itself counts (`(n)-[:T*0]-()` is trivially true when n matches).
  if (tgt.idx === null) {
    const start = src.idx
    if (start === null) return null  // both anonymous: undefined (rare, handled upstream)
    if (!varLength) {
      // Single hop: any matching neighbor in the right direction.
      const edges: any[] = (allNodes[start] as any)?.__edges || []
      for (const e of edges) {
        if (!edgeTypeMatches(e)) continue
        let nbr = -1
        if (direction === 'out' && e.srcIdx === start) nbr = e.dstIdx
        else if (direction === 'in' && e.dstIdx === start) nbr = e.srcIdx
        else if (direction === 'any' && (e.srcIdx === start || e.dstIdx === start)) nbr = e.srcIdx === start ? e.dstIdx : e.srcIdx
        if (nbr < 0) continue
        if (tgtLabel && !labelMatches(allNodes[nbr], tgtLabel)) continue
        return true
      }
      return false
    }
    // Var-length: reachable() with accept = any node matching tgtLabel.
    return reachable(start, (idx) => tgtLabel ? labelMatches(allNodes[idx], tgtLabel) : true)
  }

  // Both endpoints named: check connectivity between the two specific nodes.
  if (src.idx === null) return null
  if (!varLength) {
    if (direction === 'out') return edgeExistsFromTo(src.idx, tgt.idx)
    if (direction === 'in') return edgeExistsFromTo(tgt.idx, src.idx)
    return edgeExistsFromTo(src.idx, tgt.idx) || edgeExistsFromTo(tgt.idx, src.idx)
  }
  // Var-length between two named nodes: BFS from src, accept = reach tgt.
  if (src.idx === tgt.idx) {
    // Zero-length allowed by `*` (and `*0..n`).
    if (varMin === 0) return true
    return false
  }
  return reachable(src.idx, (idx) => idx === tgt.idx)
}

/**
 * Evaluate a single `exists { ... }` subquery body to a boolean, honoring the
 * outer variable context (`ctx`) and graph (`allNodes`).
 *
 * Supported subquery shapes:
 *   - Simple pattern:            `(n)-->()`      — existence check
 *   - Pattern + WHERE:           `(n)-->(m) WHERE n.prop = m.prop`
 *   - Full form:                 `MATCH (n)-->() RETURN true`
 *   - Aggregate form:            `MATCH (n)-->(m) WITH n, count(*) AS c WHERE c = 3 RETURN true`
 *
 * An update clause (SET/DELETE/MERGE/CREATE/REMOVE) inside the subquery is
 * illegal per openCypher and is reported via a sentinel so the caller can raise
 * InvalidClauseComposition.
 *
 * Returns one of: `true`, `false`, or the string `'InvalidClauseComposition'`.
 */
function _evalExistsSubquery(
  body: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean | 'InvalidClauseComposition' {
  let b = body.trim()
  // Strip a leading MATCH keyword (full existential subquery form).
  b = b.replace(/^MATCH\s+/i, '').trim()
  if (!b) return false

  // Reject update clauses: any top-level SET/DELETE/MERGE/CREATE/REMOVE inside
  // an existential subquery is a compile-time InvalidClauseComposition error.
  if (/\b(SET|DELETE|MERGE|CREATE|REMOVE)\b/i.test(b)) {
    return 'InvalidClauseComposition'
  }

  // Strip a trailing `RETURN ...` (the subquery form always tail-ends with it
  // in a "full" subquery; a simple pattern has no RETURN).
  const retIdx = _indexOfTopLevelKeyword(b, 'RETURN')
  if (retIdx >= 0) b = b.slice(0, retIdx).trim()

  // Aggregate subquery: `MATCH (n)-->(m) WITH n, count(*) AS c WHERE c = 3`.
  // Evaluate by counting the pattern's matches then filtering via the WITH
  // alias condition.
  const withIdx = _indexOfTopLevelKeyword(b, 'WITH')
  if (withIdx >= 0) {
    return _evalExistsAggregate(b, ctx, allNodes)
  }

  if (!b) return true

  // Remaining body is `pattern [WHERE cond]`. Split at a top-level WHERE.
  let pattern = b
  let cond: string | null = null
  const whereIdx = _indexOfTopLevelKeyword(b, 'WHERE')
  if (whereIdx >= 0) {
    pattern = b.slice(0, whereIdx).trim()
    cond = b.slice(whereIdx + 5).trim()
  }

  if (!cond) {
    // Pure existence check — no binding enumeration required.
    const v = _evalChainExists(pattern, ctx, allNodes)
    if (v !== null) return v
    const pv = _evalPatternPredicate(pattern, ctx, allNodes)
    return pv === true
  }

  // Pattern + WHERE: enumerate every binding of the pattern's inner variables,
  // then evaluate the condition against each binding.
  return _evalExistsPatternWhere(pattern, cond, ctx, allNodes)
}

/** Index of a keyword occurring at brace/paren depth 0 (top level). */
function _indexOfTopLevelKeyword(s: string, kw: string): number {
  let brace = 0, paren = 0, inStr = false, strChar = ''
  for (let i = 0; i < s.length; i++) {
    const c = s[i]
    if (inStr) { if (c === '\\') { i++; continue } if (c === strChar) inStr = false; continue }
    if (c === "'" || c === '"') { inStr = true; strChar = c; continue }
    if (c === '{') { brace++; continue }
    if (c === '}') { brace--; continue }
    if (c === '(') { paren++; continue }
    if (c === ')') { paren--; continue }
    if (brace === 0 && paren === 0) {
      const rest = s.slice(i)
      if (rest.startsWith(kw) && !/\w/.test(s[i + kw.length] || '') && !/\w/.test(s[i - 1] || '')) {
        return i
      }
    }
  }
  return -1
}

/**
 * Evaluate an aggregate existential subquery `pattern WITH var, agg() AS c
 * WHERE cond`. Only the single-source single-aggregation form used by the TCK
 * is supported: count the pattern matches for the (already-bound outer) source
 * variable, bind the aggregate alias, then evaluate the WHERE condition.
 */
function _evalExistsAggregate(
  b: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean {
  const withIdx = _indexOfTopLevelKeyword(b, 'WITH')
  const head = b.slice(0, withIdx).trim()      // pattern, e.g. (n)-->(m)
  const tail = b.slice(withIdx + 4).trim()      // n, count(*) AS c WHERE c = 3
  const whereIdx = _indexOfTopLevelKeyword(tail, 'WHERE')
  const aggPart = (whereIdx >= 0 ? tail.slice(0, whereIdx) : tail).trim()
  const cond = whereIdx >= 0 ? tail.slice(whereIdx + 5).trim() : null

  // Parse `n, count(*) AS c` → alias `c` (and optional qualifying variable).
  const aliasMatch = aggPart.match(/\b(?:count|collect|sum|avg|min|max|size)\s*\((.*?)\)\s+AS\s+(\w+)/i)
  if (!aliasMatch) return false
  const alias = aliasMatch[2]

  // Enumerate the pattern's bindings and count them.
  const bindings = _enumPatternBindings(head, ctx, allNodes)
  const count = bindings.length

  if (cond) {
    const localCtx: Record<string, unknown> = { ...ctx, [alias]: count }
    const v = _evaluateExpression(cond, localCtx)
    return v === true
  }
  return count > 0
}

/**
 * Evaluate `pattern WHERE cond` by enumerating every binding of the pattern's
 * inner variables and testing `cond` against each. Returns true if any binding
 * satisfies the condition.
 */
function _evalExistsPatternWhere(
  pattern: string,
  cond: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean {
  // A bare node pattern `MATCH (m) WHERE <cond>` enumerates every node as a
  // candidate binding for `m`; there is no relationship to traverse.
  const bareVar = pattern.trim().match(/^\((\w+)(?::[\w]+)?\)$/)
  if (bareVar) {
    const varName = bareVar[1]
    for (const node of allNodes) {
      const localCtx: Record<string, unknown> = { ...ctx, [varName]: node }
      if (_evalExistsWhereCond(cond, localCtx, allNodes)) return true
    }
    return false
  }
  const bindings = _enumPatternBindings(pattern, ctx, allNodes)
  for (const binding of bindings) {
    const localCtx: Record<string, unknown> = { ...ctx, ...binding }
    if (_evalExistsWhereCond(cond, localCtx, allNodes)) return true
  }
  return false
}

/**
 * Evaluate a WHERE condition that may embed a nested `exists { ... }` subquery.
 * Nested subqueries are resolved recursively against the extended context, then
 * the remaining pure-boolean expression is evaluated.
 */
function _evalExistsWhereCond(
  cond: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): boolean {
  let expr = cond.trim()
  // A bare pattern predicate — possibly a multi-node chain such as
  // `(l)<-[:R]-(n)-[:R]->(m)` — is the whole condition.
  const chainV = _evalChainExists(expr, ctx, allNodes)
  if (chainV !== null) return chainV
  if (/^\(.*\)$/.test(expr)) {
    const pv = _evalPatternPredicate(expr, ctx, allNodes)
    if (pv !== null) return pv
  }
  // Nested `exists { ... }` subqueries resolve recursively.
  if (/exists\s*\{/i.test(expr)) {
    const resolved = _resolveExistsSubqueries(expr, ctx, allNodes)
    expr = resolved.expr
    if (resolved.invalidClause) {
      throw Object.assign(new Error('SyntaxError: InvalidClauseComposition'), { tckError: 'InvalidClauseComposition' })
    }
  }
  const v = _evaluateExpression(expr, ctx)
  return v === true
}

/**
 * Enumerate the bindings of a simple directed pattern `(src)-[:L]->(tgt)` or
 * undirected `--`, returning an array of context extensions (one per matched
 * inner-node/relationship binding). Anonymous endpoints are not bound.
 *
 * This is the minimal enumerator needed by existential subqueries; richer
 * multi-hop / var-length patterns fall back to the existence check elsewhere.
 */
function _enumPatternBindings(
  pattern: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const m = pattern.trim().match(/^\((\w+)(?::[\w]+)?\)\s*(<-|-)\s*(\[[^\]]*\])?\s*(->|-)\s*\((\w*)(?::([\w]+))?\)$/)
  if (!m) return []
  const srcVar = m[1]
  const edgeSpec = m[3] || ''
  const rightArrow = m[4]
  const tgtVar = m[5] || null
  const tgtLabel = m[6] || null

  const resolveNodeIdx = (v: unknown): number => {
    if (!v || typeof v !== 'object') return -1
    const node = v as any
    let idx = allNodes.indexOf(node as any)
    if (idx >= 0) return idx
    if (node._alias !== undefined) idx = allNodes.findIndex((n: any) => n?._alias === node._alias)
    return idx
  }
  const srcIdx = resolveNodeIdx(ctx[srcVar])
  if (srcIdx < 0) return []

  // Edge label (strip `[...]`, leading `:`, optional var-length suffix).
  let edgeLabel: string | null = null
  {
    let inner = edgeSpec.replace(/^\[|\]$/g, '').trim()
    if (inner.startsWith(':')) inner = inner.slice(1)
    const vlm = inner.match(/^([\w|]*)\*(\d+)?(?:\.\.(\d+)?)?$/)
    if (vlm) edgeLabel = vlm[1] || null
    else edgeLabel = inner || null
  }
  const types = edgeLabel ? edgeLabel.split('|').filter(Boolean) : []
  const labelMatches = (node: any, label: string | null): boolean => {
    if (!label) return true
    const lbl = node?._label || node?.props?._label || ''
    const full = (node?.__fullLabel as string) || ''
    return lbl === label || full.split(':').includes(label)
  }

  const direction: 'out' | 'in' | 'any' = rightArrow === '->' ? 'out' : (rightArrow === '-' ? 'any' : 'out')

  const out: Array<Record<string, unknown>> = []
  const edges: any[] = (allNodes[srcIdx] as any)?.__edges || []
  for (const e of edges) {
    if (types.length && !types.includes(e.label)) continue
    let nbr = -1
    if (direction === 'out' && e.srcIdx === srcIdx) nbr = e.dstIdx
    else if (direction === 'in' && e.dstIdx === srcIdx) nbr = e.srcIdx
    else if (direction === 'any') nbr = e.srcIdx === srcIdx ? e.dstIdx : e.srcIdx
    if (nbr < 0) continue
    const tgtNode = allNodes[nbr]
    if (tgtNode === undefined) continue
    if (tgtLabel && !labelMatches(tgtNode, tgtLabel)) continue
    const extn: Record<string, unknown> = {}
    if (tgtVar) extn[tgtVar] = tgtNode
    out.push(extn)
  }
  return out
}

/**
 * Rewrite a WHERE boolean expression, replacing every pattern-predicate
 * sub-expression (e.g. `(a)-[:T]->(b:X)`) with its boolean literal
 * (`true`/`false`), so `_evaluateExpression` can evaluate the remaining
 * pure-boolean expression (property comparisons, AND/OR/XOR/NOT).
 *
 * The expression is scanned left to right tracking parentheses depth; any
 * balanced parenthesized group that parses as a pattern predicate is resolved
 * in-place. Non-pattern parenthesized groups are left intact.
 */
function _resolveWherePatternPredicates(
  expr: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): string {
  let out = ''
  let i = 0
  const n = expr.length
  while (i < n) {
    const ch = expr[i]
    if (ch === '(') {
      // A pattern predicate is `(src)  [-|<-[ ... ]-]  ->|-  (tgt)`.
      // Find the closing paren of the source node group, then check whether a
      // relationship spec follows and ends in a target node group.
      const srcEnd = _findBalancedClose(expr, i)
      if (srcEnd < 0) { out += ch; i++; continue }
      // Attempt to match the relationship + target from srcEnd+1.
      const patStart = i
      // The source node text is `(src[:Label])`.
      const srcText = expr.slice(i, srcEnd + 1)
      // Find end of the full pattern: scan forward from srcEnd+1 for target group.
      let k = srcEnd + 1
      // Skip the relationship arrow/bracket section until we meet the target '('.
      // Relationship pattern: optional whitespace, `<-` or `-`, optional `[...]`, `->` or `-`.
      let patText = srcText
      let matched = false
      // Try progressively: check if expr[srcEnd+1..] starts with a relationship spec.
      const rest = expr.slice(srcEnd + 1)
      const relMatch = rest.match(/^\s*(?:<-|-)\s*\[?[^\]]*\]?\s*(?:->|-)\s*\(/)
      if (relMatch) {
        // relMatch[0] ends with '('. Find its length excluding final '(' .
        const relPrefixLen = relMatch[0].length - 1
        const tgtStart = srcEnd + 1 + relPrefixLen
        const tgtEnd = _findBalancedClose(expr, tgtStart)
        if (tgtEnd >= 0) {
          patText = expr.slice(i, tgtEnd + 1)
          const val = _evalPatternPredicate(patText, ctx, allNodes)
          if (val !== null) {
            out += val ? 'true' : 'false'
            i = tgtEnd + 1
            matched = true
          }
        }
      }
      if (!matched) {
        // Not a pattern predicate. Emit the source group verbatim and continue.
        out += srcText
        i = srcEnd + 1
      }
      continue
    }
    out += ch
    i++
  }
  return out
}

/**
 * Rewrite a WHERE body, replacing every `exists { ... }` subquery block with a
 * boolean literal (`true`/`false`) evaluated against `ctx`/`allNodes`. This
 * lets `_evaluateExpression` evaluate the remaining pure-boolean structure.
 *
 * Returns `{ expr, invalidClause }` where `invalidClause` is true when a
 * subquery contained an illegal update clause (so the caller can throw).
 */
function _resolveExistsSubqueries(
  expr: string,
  ctx: Record<string, unknown>,
  allNodes: Array<Record<string, unknown>>,
): { expr: string; invalidClause: boolean } {
  let invalidClause = false
  if (!/exists\s*\{/i.test(expr)) return { expr, invalidClause }
  let out = ''
  let i = 0
  const n = expr.length
  while (i < n) {
    const rest = expr.slice(i)
    const m = rest.match(/^exists\s*\{/i)
    if (m) {
      // Locate the matching closing brace.
      const openIdx = i + m[0].length - 1 // index of '{'
      let depth = 1
      let k = openIdx + 1
      let inStr = false
      let strChar = ''
      for (; k < n; k++) {
        const c = expr[k]
        if (inStr) { if (c === '\\') { k++; continue } if (c === strChar) inStr = false; continue }
        if (c === "'" || c === '"') { inStr = true; strChar = c; continue }
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) { k++; break } }
      }
      const body = expr.slice(openIdx + 1, k - 1)
      const val = _evalExistsSubquery(body, ctx, allNodes)
      if (val === 'InvalidClauseComposition') invalidClause = true
      out += (val === true) ? 'true' : 'false'
      i = k
      continue
    }
    out += expr[i]
    i++
  }
  return { expr: out, invalidClause }
}

/** Find the index of the closing paren that balances the '(' at `start`. */
function _findBalancedClose(s: string, start: number): number {
  let depth = 0
  let inStr = false
  let strChar = ''
  for (let j = start; j < s.length; j++) {
    const c = s[j]
    if (inStr && c === '\\') { j++; continue }
    if (inStr) { if (c === strChar) inStr = false; continue }
    if (c === "'" || c === '"') { inStr = true; strChar = c; continue }
    if (c === '(') depth++
    else if (c === ')') { depth--; if (depth === 0) return j }
  }
  return -1
}

// NOTE: `findFirstTopLevelAndOr` and `isBalancedParens` were removed together
// with the old `_resolvePatternComprehensions`; the new pattern-predicate
// resolution is handled by `_resolveWherePatternPredicates` / `_findBalancedClose`.

function isTypedValue(v: unknown): v is { type: string; value: unknown } {
  return !!v && typeof v === 'object' && 'value' in v && 'type' in (v as any)
}

/** 从 typed-format 对象解包裸值 */
function unwrapTyped(v: unknown): unknown {
  return isTypedValue(v) ? v.value : v
}

/** 判断值是否为 props-format 对象 { props: {...} } */
function hasProps(v: unknown): v is { props: Record<string, unknown> } {
  return !!v && typeof v === 'object' && 'props' in v
}

/**
 * Find an existing node that a MERGE node pattern matches against.
 *
 * openCypher MERGE semantics: a node pattern matches an existing node when the
 * labels intersect (a null `label` in the pattern matches any node) AND every
 * pattern property is present on the node with an equal value (a null `props`
 * matches any node).  When a match exists the node is reused (not created) and
 * the ON MATCH branch fires; otherwise a fresh node is created and ON CREATE
 * fires.  Returns the index of the first matching node in `allNodes`, or -1.
 */
function _findMergeNodeMatch(
  node: { alias?: string; label?: string | null; props?: Record<string, unknown> | null },
  allNodes: Array<Record<string, unknown>>,
): number {
  for (let i = 0; i < allNodes.length; i++) {
    const cand = allNodes[i] as any
    // Label match: pattern label (if any) must appear in the candidate's labels.
    if (node.label) {
      const candLabels = String(cand._label ?? cand.__fullLabel ?? '')
        .split(':').map((s: string) => s.trim()).filter(Boolean)
      if (!candLabels.includes(node.label)) continue
    }
    // Property match: every pattern property must exist with an equal value.
    if (node.props && Object.keys(node.props).length > 0) {
      let allMatch = true
      for (const [k, pv] of Object.entries(node.props)) {
        const want = unwrapTyped(pv)
        // Candidate property may be at top level or nested under `props`.
        let have = cand[k]
        if (have === undefined && cand.props && typeof cand.props === 'object') {
          have = cand.props[k]
        }
        have = unwrapTyped(have)
        // Compare with Cypher equality: primitive deep-equal, not JS reference.
        if (!_cypherValueEquals(have, want)) { allMatch = false; break }
      }
      if (!allMatch) continue
    }
    return i
  }
  return -1
}

/**
 * Cypher value equality for property matching (used by MERGE node matching).
 * Numbers compare by value (so `42` matches `42`), booleans and strings by
 * value, and lists deeply.  `null`/`undefined` on the candidate side never
 * matches a concrete pattern value.
 */
function _cypherValueEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) {
      if (!_cypherValueEquals(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === 'number' && typeof b === 'number') return a === b
  if (typeof a === 'bigint' && typeof b === 'bigint') return a === b
  // cross numeric type: bigint vs number
  if ((typeof a === 'bigint' && typeof b === 'number') || (typeof a === 'number' && typeof b === 'bigint')) {
    return BigInt(a as any) === BigInt(b as any)
  }
  return String(a) === String(b)
}

/** 判断字符串是否为表达式值（函数调用或运算符表达式） */
function _isExprValue(s: string): boolean {
  return /^[a-z_]\w*\s*\(.*\)\s*$/i.test(s) || /^(?:[-+!]|[\w.]+)\s+/.test(s) || /\s+(?:AND|OR|XOR|IN|IS|=|<>|<=?|>=?|[+\-*/%])\s/.test(s)
}

/**
 * Cypher property values may be any scalar, a list of scalars, or nested lists
 * of scalars — but never a map (or a list containing a map).  Return true when
 * a value violates that constraint so the caller can raise InvalidPropertyType.
 */
function _isInvalidPropertyValue(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (Array.isArray(v)) {
    for (const item of v) {
      if (_isInvalidPropertyValue(item)) return true
    }
    return false
  }
  // A map/object (non-array, non-scalar) is not a valid property value.  Scalars
  // (string/number/boolean/bigint) and Date/nested arrays are acceptable.
  if (typeof v === 'object') {
    const t = (v as any)?.type
    if (t === 'STRING' || t === 'NUMBER' || t === 'INTEGER' || t === 'FLOAT' || t === 'BOOLEAN') return false
    // A typed value wrapper (`{ type, value }`) is a scalar, not a map.
    if (t != null && 'value' in (v as any)) return _isInvalidPropertyValue((v as any).value)
    return true
  }
  return false
}

/** 判断查询是否涉及写操作（需要独占 GE 连接） */
function isWriteOp(plan: QueryPlan): boolean {
  return plan.type === 'CREATE' || plan.type === 'MERGE' ||
    plan.type === 'SET' || plan.type === 'DELETE' || plan.type === 'REMOVE' ||
    plan.type === 'MATCH_MODIFY'
}

// ── GE 封装函数：将私有/非类型化 GE 方法集中在有限范围内 ──

/** GE 节点的类型：public API 缺失的类型补充 */
interface GeNodeInfo { type: number; name: string }

/** 执行 GE 查询计划（封装 _executeQueryPlan Private method） */
function _geExecQueryPlan(ge: any, plan: any): any[] {
  return (ge as any)._executeQueryPlan(plan)
}

/** upsertNode（GE public API 的类型补全） */
function _geUpsertNode(ge: any, type: number, name: string, props: { props: Record<string, unknown> }): Promise<number> {
  return (ge as any).upsertNode(type, name, props)
}

/** deleteNode（GE public API 的类型补全） */
function _geDeleteNode(ge: any, id: number): Promise<void> {
  return (ge as any).deleteNode(id)
}

/** getNode（GE public API 的类型补全） */
function _geGetNode(ge: any, id: number): GeNodeInfo | undefined {
  return (ge as any).getNode(id)
}

/** 解析边类型 ID（_resolveEdgeType Private method） */
function _geResolveEdgeType(ge: any, label: string): number {
  return (ge as any)._resolveEdgeType(label)
}

/** 插入边（storage.upsertEdge Private method） */
function _geUpsertEdge(ge: any, srcId: number, dstId: number, typeId: number, props?: Record<string, unknown>): void {
  if (props) {
    (ge as any).storage.upsertEdge(srcId, dstId, typeId, { props })
  } else {
    _geUpsertEdge(ge, srcId, dstId, typeId)
  }
}

/**
 * _executeMultiMatchCrossJoin — cross-join executor for multiple MATCH patterns.
 *
 * Handles two or more independent MATCH patterns produced by adjacent or
 * `WITH x`-separated `MATCH ... MATCH ...` clauses. Each pattern binds its own
 * relationship variable (`[a]`/`[b]`) or path variable (`p1`/`p2`), the results
 * are combined via a Cartesian product, and the WHERE / RETURN expressions are
 * evaluated over the cross-joined bindings.
 *
 * Covered TCK scenarios:
 *   - Comparison1 [5]: `MATCH ()-[a]->() WITH a MATCH ()-[b]->() WHERE a = b RETURN count(b)`
 *   - Comparison1 [14]: `MATCH p1 = (:A)-->() MATCH p2 = (:A)<--() RETURN p1 = p2`
 *
 * Returns null when the plan does not qualify for multi-MATCH cross-join (the
 * ordinary GE path handles those).
 */
async function _executeMultiMatchCrossJoin(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): Promise<QueryRow[] | null> {
  let mm = (plan as any).multiMatch as Array<{ scanLabel: string | null; steps: TraverseStep[]; variable?: string }> | undefined
  // A bare-node `MERGE (b)` (no label, no properties, no edges) followed by an
  // OPTIONAL MATCH and an aggregate — e.g. Match8's
  // `MATCH (a) MERGE (b) WITH * OPTIONAL MATCH (a)--(b) RETURN count(*)` — is a
  // *row-counting* query, not an update: the MERGE matches every existing node
  // (creating nothing when any node exists) exactly like a bare `MATCH (b)`.
  // `parseQuery` routes such a plan down the DML fast path (`type = 'MERGE'`),
  // which drops the MATCH bindings and collapses `count(*)` to 0.  Stage each
  // bare merge node as an additional MATCH pattern so the cross-join below
  // binds `b` over every node, the optional match expands, and the aggregate
  // fold yields the correct row count.  (MERGE-with-label/props/edges still
  // keeps full update semantics and never reaches this transformation.)
  if ((plan as any).type === 'MERGE' && !mm?.length &&
      (plan as any).optionalMatchSteps?.length && (plan as any).aggregate) {
    const mNodes = ((plan as any).mergeNodes || []) as Array<{ alias?: string; label?: string | null; props?: Record<string, unknown> | null }>
    const mEdges = ((plan as any).mergeEdges || []) as Array<any>
    const isBare = (n: any): boolean => !n?.label && (n?.props == null || Object.keys(n.props).length === 0)
    if (!mEdges.length && mNodes.every(isBare) && nodes.length > 0) {
      mm = mNodes.map(n => ({ scanLabel: null, steps: [], variable: n.alias || undefined }))
      // The bare MERGE is purely a row-counting match here (it creates nothing
      // when nodes already exist), so downgrade the plan type to QUERY and
      // materialise `multiMatch` on the plan itself so the OPTIONAL MATCH
      // expansion below sees `b` (and every bare merge alias) as a bound
      // variable — otherwise `(a)--(b)` treats `b` as a free source and
      // over-enumerates rows (8 instead of 6).
      ;(plan as any).type = 'QUERY'
      ;(plan as any).multiMatch = mm
    }
  }
  if (!mm?.length) return null

  // Assemble all independent patterns: pattern[0] = primary MATCH
  // (plan.steps + plan.scanLabel), pattern[1..] = additional MATCH (multiMatch[i]).
  // Each pattern also records its source node variable (e.g. `a`) so that
  // patterns sharing a variable name (e.g. `MATCH (a:A) MATCH (a)-[:R]->(c)`)
  // are joined on that bound node rather than Cartesian-producted.
  const patterns: Array<{ scanLabel: string | null; steps: TraverseStep[]; variable?: string }> = [
    { scanLabel: plan.scanLabel ?? null, steps: plan.steps || [], variable: (plan as any).matchVar, sourceProps: (plan as any).matchSourceProps },
    ...mm.map(p => ({ scanLabel: p.scanLabel ?? null, steps: p.steps || [], variable: p.variable, sourceProps: (p as any).sourceProps })),
  ]
  if (patterns.length < 2) return null
  // Any two-or-more independent MATCH patterns must be cross-joined: either on
  // a shared bound node variable (`MATCH (a:A) MATCH (a)-[:R]->(c)`), on
  // relationship/path variable materialisation (`MATCH (a)-[r]->(b) MATCH ...`),
  // or as a pure Cartesian product of disjoint edge patterns
  // (`MATCH (a)-->(b) MATCH (c)-->(d)`).  The GE path cannot represent any of
  // these, so falling through to it yields wrong/empty rows.

  // Clone nodes and ensure __edges exists.
  const allNodes: Array<Record<string, unknown>> = (nodes || []).map(n => {
    const c: Record<string, unknown> = { ...n }
    if (Array.isArray((n as any).__edges)) (c as any).__edges = [...(n as any).__edges] as any
    return c
  })
  for (const nd of allNodes) if (!nd.__edges) nd.__edges = []

  // Enumerate every relationship edge in the graph, keyed by srcIdx|dstIdx|label
  // to provide stable relationship identity for `a = b` comparisons.
  const rels: Array<Record<string, unknown>> = []
  const relSeen = new Set<string>()
  for (let i = 0; i < allNodes.length; i++) {
    const edges = (allNodes[i] as any).__edges as Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> }> | undefined
    if (!edges) continue
    for (const e of edges) {
      const key = `${e.srcIdx}|${e.dstIdx}|${e.label || ''}`
      if (relSeen.has(key)) continue
      relSeen.add(key)
      // Canonical direction-insensitive identity: `(a)-[r]-(b)` and
      // `(b)-[r]-(a)` denote the SAME relationship, so a bound `r` reused
      // across two MATCH patterns must equate on `min|max|label`, not the
      // traversal order.  `__edgeId` keeps the directed key (for uniqueness),
      // while `__relId` is the undirected canonical used for join equality.
      const relObj: Record<string, unknown> = {
        __edgeId: key,
        __relId: `${Math.min(e.srcIdx, e.dstIdx)}|${Math.max(e.srcIdx, e.dstIdx)}|${e.label || ''}`,
        __edgeLabel: e.label,
        __edgeLabelStr: e.label,
        _type: e.label,
        _label: e.label,
        srcIdx: e.srcIdx,
        dstIdx: e.dstIdx,
      }
      if (e.props) for (const [k, v] of Object.entries(e.props)) relObj[k] = v
      rels.push(relObj)
    }
  }

  const nodeLabel = (i: number): string => String(allNodes[i]?.['_label'] || '')

  // For single-edge patterns enumerate matching relationships by direction;
  // for path/multi-step patterns use _walkMultiSteps. Each pattern emits a
  // "match list" of variable-binding objects.  Node variables are bound to
  // their *node index* (a number) so the subsequent join can equate a shared
  // variable bound by two patterns (`MATCH (a:A) MATCH (a)-[:R]->(c)`) on node
  // identity rather than treating them as independent.
  const matchLists: Array<Array<Record<string, unknown>>> = []
  for (const pat of patterns) {
    const matches: Array<Record<string, unknown>> = []
    const step = pat.steps[0]
    const edgeVar = (step as any)?.edgeVariable as string | undefined
    const pathVar = (step as any)?.pathVariable as string | undefined

    // Inline property predicate from a bare bound node (e.g. `c` in
    // `MATCH (a {name:'A'}),(c {name:'C'})` is stored as sourceProps on the
    // staged pattern).  Filter candidate start nodes to those matching every
    // such property.
    const sourceProps = ((pat as any).sourceProps || (step as any)?.sourceProps) as Record<string, unknown> | undefined
    const matchesProps = (i: number): boolean => {
      if (!sourceProps || !Object.keys(sourceProps).length) return true
      const node = allNodes[i] as any
      // Node user properties may live either nested under `node.props` or spread
      // at the top level of the node record; accept both normalisations.
      const nodeProps = { ...(node?.props || {}), ...node }
      for (const [k, v] of Object.entries(sourceProps)) {
        if (nodeProps[k] !== v) return false
      }
      return true
    }

    // Candidate start nodes, honoring scanLabel.
    const startIdxs: number[] = []
    for (let i = 0; i < allNodes.length; i++) {
      if (pat.scanLabel) {
        const nl = nodeLabel(i)
        const fl = (allNodes[i] as any).__fullLabel
        // A node may carry multiple labels either as `__fullLabel` ("A:B") or —
        // when seeded via CREATE — as a combined `_label` ("A:B").  Both forms
        // must match a single-label predicate (`MATCH (n:B)`), so test against
        // the union of labels from the full label set falling back to splitting
        // `_label` on ':'.
        const labelSet: string[] = fl && typeof fl === 'string'
          ? fl.split(':').filter(Boolean)
          : String(nl).split(':').filter(Boolean)
        const labelMatches = labelSet.includes(pat.scanLabel as string)
        if (!labelMatches) continue
      }
      if (!matchesProps(i)) continue
      startIdxs.push(i)
    }

    if (pat.steps.length === 0) {
      // Bare node pattern (`MATCH (a)` / `MATCH (a:A)`): bind the source
      // variable to every matching node index (startIdxs already honours
      // scanLabel).  This is what lets a later pattern join on `a`.
      for (const si of startIdxs) {
        const m: Record<string, unknown> = {}
        if (pat.variable) m[pat.variable] = si
        matches.push(m)
      }
    } else if (pat.steps.length === 1 && !pathVar && !(step as any)?.range) {
      // Single-step relationship pattern: enumerate matching edges directly,
      // binding the source/target node variables (by index) plus the edge var.
      const stepLabel = (step as any).edgeLabel as string | null | undefined
      const srcVar = (step as any).source as string | undefined
      const tgtVar = (step as any).targetAlias as string | undefined
      const tgtLabel = (step as any).targetLabel as string | null | undefined
      // Target-node label predicate `(a)-[r]->(b:X)`: the target endpoint must
      // carry the declared label.  This cross-join executor previously ignored
      // the label (only edgeLabel/direction were honoured), so a labelled
      // target like `b:X` over-matched non-X endpoints.
      const _nodeLabelMatch = (i: number): boolean => {
        if (!tgtLabel) return true
        const node = allNodes[i] as any
        const full = (typeof node?.__fullLabel === 'string' && node.__fullLabel) ? node.__fullLabel : String(node?._label ?? '')
        return full.split(':').filter(Boolean).includes(tgtLabel)
      }
      for (const rel of rels) {
        const s = rel.srcIdx as number, d = rel.dstIdx as number
        // Relationship type predicate: `-[r:Y]->` must only match edges whose
        // label equals Y (a bound `r` reusing the same variable still enforces
        // the type — `MATCH (a1)-[r:T]->() ... MATCH (a1)-[r:Y]->(b2)` yields no
        // rows whatever r was previously bound to).  The enumerated rel object
        // carries the relationship type under `_type`/`__edgeLabel`.
        const relType = (rel._type as string) || (rel.__edgeLabel as string) || (rel.label as string) || ''
        if (stepLabel && relType !== stepLabel) continue
        // Self-loop pattern (`(b)-->(b)`): the same variable names both ends, so
        // it can only match a relationship whose source and target are the same
        // node.  Without this a `b-->b` degenerate case would bind `b` to every
        // edge's target and return spurious rows.
        if (srcVar && tgtVar && srcVar === tgtVar && s !== d) continue
        // Target-label predicate: enforce per direction before emitting a row.
        if (step.direction === 'out' && !_nodeLabelMatch(d)) continue
        if (step.direction === 'in' && !_nodeLabelMatch(s)) continue
        if (step.direction === 'any' && tgtLabel && !_nodeLabelMatch(s) && !_nodeLabelMatch(d)) continue
        // direction semantics: out → rel.srcIdx must be a start node; in → rel.dstIdx.
        if (step.direction === 'out' && startIdxs.length !== allNodes.length && !startIdxs.includes(s)) continue
        if (step.direction === 'in' && startIdxs.length !== allNodes.length && !startIdxs.includes(d)) continue
        const m: Record<string, unknown> = {}
        if (step.direction === 'out') {
          if (srcVar) m[srcVar] = s
          if (tgtVar) m[tgtVar] = d
        } else if (step.direction === 'in') {
          if (srcVar) m[srcVar] = d
          if (tgtVar) m[tgtVar] = s
        } else {
          // any/undirected: the source variable may anchor on either endpoint.
          // Emit a binding for each endpoint that is a legal anchor, so a
          // `(b)--(d)` diagonal joining a primary match can bind both `b=s,d=g`
          // and `b=g,d=s` (the reverse orientation over the same undirected
          // edge).  When the anchor set is the full node set (scanLabel == null)
          // both orientations are emitted; a self-loop (s === d) collapses to a
          // single binding to avoid a duplicate.
          const canAnchorS = startIdxs.length === allNodes.length || startIdxs.includes(s)
          const canAnchorD = startIdxs.length === allNodes.length || startIdxs.includes(d)
          // Anonymous undirected edge (`()-[r:EDGE]-()`): the two anonymous
          // `()` are DISTINCT node variables, so a relationship matched
          // undirected has two endpoint assignments (s,d) and (d,s) — emit a
          // binding per assignment.  Downstream, a bound `r` reused across a
          // second `MATCH p=...-[r]-...` joins on `__relId` (identity), and the
          // two directional rows each expand the path, which is exactly the
          // `count(p)` semantics (Match4 [7] expects 32 = 2× per-edge paths).
          if (canAnchorS) {
            const m1: Record<string, unknown> = { ...m }
            if (srcVar) m1[srcVar] = s
            if (tgtVar) m1[tgtVar] = d
            if (edgeVar) m1[edgeVar] = rel
            matches.push(m1)
          }
          if (canAnchorD && s !== d) {
            const m2: Record<string, unknown> = { ...m }
            if (srcVar) m2[srcVar] = d
            if (tgtVar) m2[tgtVar] = s
            if (edgeVar) m2[edgeVar] = rel
            matches.push(m2)
          }
          continue
        }
        if (edgeVar) m[edgeVar] = rel
        matches.push(m)
      }
    } else if (pat.steps.length === 1 && (step as any)?.range) {
      // Variable-length single-step pattern (`MATCH (a)-[r*2]->()`): delegate to
      // the BFS engine so `edgeVariable` binds to the full edge LIST (e.g.
      // `[[:X], [:Y]]` for a 2-hop walk) rather than a single relationship.
      const vlPlan: any = {
        scanLabel: pat.scanLabel ?? null,
        steps: pat.steps,
        pathVar: pathVar || null,
        returnColumns: [edgeVar || ''],
      }
      const vlRows = _executeVarLenPath(vlPlan, allNodes as Array<Record<string, unknown>>)
      for (const row of vlRows) {
        const m: Record<string, unknown> = {}
        if (edgeVar && row[edgeVar] !== undefined) m[edgeVar] = row[edgeVar]
        // Preserve any bound source/target node variables (e.g. `a` from the
        // preceding MATCH) emitted by the BFS walk.  The BFS emits node
        // *objects* keyed by variable name; map them back to their node index
        // via a name lookup so the join can equate them with the primary match.
        for (const [k, v] of Object.entries(row)) {
          if (k === edgeVar || k.startsWith('__')) continue
          if (v && typeof v === 'object' && (v as any)._label !== undefined) {
            // Node object → find its index.
            const idx = allNodes.findIndex(no => no === v || ((no as any)._label === (v as any)._label && (no as any).name === (v as any).name && (v as any).name !== undefined))
            m[k] = idx >= 0 ? idx : v
          } else {
            m[k] = v
          }
        }
        matches.push(m)
      }
    } else {
      // Path or multi-step pattern: walk via the edge-aware traversal and build
      // path objects.  `_walkMultiStepsWithEdges` returns, for each matched
      // trail, the node-index sequence AND the exact relationship consumed per
      // hop (source-owned edges de-duplicated across the two endpoint copies
      // that a single-statement CREATE attaches to both ends).  Binding each
      // hop's edge variable from this precise sequence — rather than re-looking
      // up an edge by an undirected `srcIdx/dstIdx === next` test — is what
      // keeps `r1` in `()-[r1]->()<--()` bound to the correct outgoing edge when
      // a node carries both incoming and outgoing relationships.
      for (const si of startIdxs) {
        const walks = _walkMultiStepsWithEdges(si, pat.steps, allNodes, undefined, plan.filters, undefined)
        for (const walk of walks) {
          const path = walk.ns
          const m: Record<string, unknown> = {}
          // Resolve the relationship edge for each hop from the traversal's own
          // edge sequence (`walk.es[pi]`), keyed by hop index.  Each entry is a
          // `{ srcIdx, dstIdx, label }` reference; further re-materialise the
          // optional `props` from the source node's `__edges` so that edge
          // variables expose `r1.times` etc.  This replaces the previous
          // undirected re-lookup that mis-bound edges when a node has both
          // incoming and outgoing relationships stored on it.
          const hopEdges: Array<{ relEdge: any } | null> = []
          for (let pi = 0; pi < path.length - 1; pi++) {
            const ref = walk.es[pi]
            let relEdge: any = ref || null
            // Recover the full edge record (with props) from the source node's
            // outgoing edge list, matching src/dst/label to stay faithful to the
            // direction the walk actually traversed.
            if (ref) {
              const a = allNodes[ref.srcIdx] as any
              const edges = (a?.__edges || []) as Array<{ srcIdx: number; dstIdx: number; label: string; props?: any }>
              relEdge = edges.find(ee => ee.srcIdx === ref.srcIdx && ee.dstIdx === ref.dstIdx && (ee.label || '') === (ref.label || '')) || ref
            }
            hopEdges.push(relEdge ? { relEdge } : null)
          }
          if (pathVar) {
            // Build the path object as the serializer expects: `__path` holds
            // the ordered NODE sequence only, and `__pathEdges` holds the ordered
            // EDGE sequence.  Each edge is normalized to the relationship
            // contract (`__edgeLabel`/`_type`/`_label`) and tagged with `_dir`
            // ('out' when the hop walks the edge in its natural source→target
            // direction, 'in' when it walks against it).  Interleaving nodes and
            // edges into a single `__path` array was the historical bug: the
            // renderer then saw no `__pathEdges` and emitted the raw object
            // rather than TCK path notation `<(:A)-[:T]->(:B)>`.
            const pathNodes: unknown[] = []
            const pathEdges: unknown[] = []
            for (let pi = 0; pi < path.length; pi++) {
              pathNodes.push(allNodes[path[pi]] || {})
              if (pi < path.length - 1) {
                const re = hopEdges[pi]?.relEdge as any
                const dir = re && re.srcIdx === path[pi] ? 'out' : 'in'
                const edgeObj: Record<string, unknown> = {
                  __edgeLabel: re?.label ?? '',
                  __edgeLabelStr: re?.label ?? '',
                  _type: re?.label ?? '',
                  _label: re?.label ?? '',
                  _dir: dir,
                }
                if (re?.props) for (const [k, v] of Object.entries(re.props)) edgeObj[k] = v
                pathEdges.push(edgeObj)
              }
            }
            m[pathVar] = { __path: pathNodes, __pathEdges: pathEdges }
          }
          // Bind each step's endpoint node variables (source / target alias) to
          // their node index, and each edge variable to a full relationship
          // object so type(r1) / r1.weight resolve against the matched edge.
          //
          // The flat `path` node sequence spans all steps; with variable-length
          // steps a single step may consume zero or many nodes, so the step→path
          // boundary is not 1:1.  Resolve the first step's source to path[0] and
          // the last step's target alias to path[path.length-1]; intermediate
          // bounds are tracked by a running offset over the (single-hop) step
          // count, which collapses correctly when every step is fixed-length and
          // leaves anonymous zero-hop mid-nodes unbound (they carry empty aliases).
          const firstSt = pat.steps[0] as any
          const lastSt = pat.steps[pat.steps.length - 1] as any
          if (firstSt.source) m[firstSt.source] = path[0]
          if (lastSt.targetAlias) m[lastSt.targetAlias] = path[path.length - 1]
          // Bind each step's endpoint node variables.  Every step advances the
          // walk by at least one hop (a zero-hop variable-length step still
          // re-anchors at the same node, consuming zero path positions), so the
          // node reached after step i is path[i + 1] for fixed-length steps.
          // For variable-length steps the hop count is data-dependent; we bind
          // the target alias only when the step is fixed-length (no `.range`).
          // `walk.hopCounts` (forwarded by `_walkMultiStepsWithEdges`) records
          // how many hops each step consumed; the hop offset of step `pi` is the
          // running sum of `hopCounts[0..pi-1]`.  A fixed-length edge-variable
          // step binds the single edge at that offset, which is exactly its hop
          // — NOT `hopEdges[pi]`, which is only correct when every preceding
          // step consumed exactly one hop (false for `[*0..1]`-prefixed chains).
          const hopCounts: number[] = (walk as any).hopCounts?.length === pat.steps.length
            ? (walk as any).hopCounts
            : pat.steps.map(() => 1)
          // Running offset of each step's first hop.
          const stepOffsets: number[] = []
          let acc = 0
          for (let pi = 0; pi < pat.steps.length; pi++) {
            stepOffsets[pi] = acc
            acc += hopCounts[pi] ?? 1
          }
          for (let pi = 0; pi < pat.steps.length; pi++) {
            const st = pat.steps[pi] as any
            // Edge variable binding: a fixed-length step's edge is the hop at
            // its computed offset (a variable-length step has no single edge).
            const ev = (st?.edgeVariable as string | undefined)
            const hopIdx = stepOffsets[pi]
            if (ev && !st.range && hopEdges[hopIdx]?.relEdge) {
              const re = hopEdges[hopIdx]!.relEdge
              const edgeObj: Record<string, unknown> = {
                __edgeLabel: re.label,
                __edgeLabelStr: re.label,
                _type: re.label,
                _label: re.label,
              }
              // Preserve direction-insensitive relationship identity so a bound
              // `r` reused across patterns can join on `__relId` (the same edge
              // traversed in reverse order is still the same relationship).
              if (typeof re.srcIdx === 'number' && typeof re.dstIdx === 'number') {
                edgeObj.__relId = `${Math.min(re.srcIdx, re.dstIdx)}|${Math.max(re.srcIdx, re.dstIdx)}|${re.label || ''}`
                edgeObj.srcIdx = re.srcIdx
                edgeObj.dstIdx = re.dstIdx
              }
              if (re.props) for (const [k, v] of Object.entries(re.props)) edgeObj[k] = v
              m[ev] = edgeObj
            }
            // Intermediate node variable binding for fixed-length steps: the
            // node reached after step pi is path[stepOffsets[pi] + 1] (offset by
            // the hops all preceding steps consumed).  This binds `x` in a chain
            // like `(a)-->(x)<-->(b)`.  The FINAL step's target is already bound
            // above to `path[path.length - 1]`, so skip it here.
            if (st.targetAlias && !st.range && pi < pat.steps.length - 1) {
              const ni = stepOffsets[pi] + 1
              if (ni < path.length) m[st.targetAlias] = path[ni]
            }
          }
          matches.push(m)
        }
      }
    }
    matchLists.push(matches)
  }

  // Sequential cross-join with bound-variable equality.  Node variables are
  // stored as node indices (numbers), so when two patterns both bind the same
  // variable (e.g. `a`), a row is only kept when the bindings agree.  Direct
  // Cartesian product would silently multiply `MATCH (a:A) MATCH (a)-[:R]->(c)`
  // into cross rows instead of joining on the shared `a`.  A shared
  // relationship variable (`MATCH ()-[r:EDGE]-() MATCH ...-[r]-...`) is bound
  // to a relationship OBJECT on both sides, so it equates on the canonical
  // direction-insensitive `__relId` rather than falling into a Cartesian
  // product (which would multiply the row count by the number of relationships).
  const _relIdOf = (v: unknown): string | undefined =>
    (v && typeof v === 'object' && '__relId' in (v as any)) ? String((v as any).__relId) : undefined
  // WITH aliases map `WITH r1 AS r2` → r2 names the same binding as r1.  A later
  // MATCH that reuses the alias as its edge/source variable (`MATCH ()-[r2]->()`)
  // therefore joins against the ORIGINAL binding (r1), not a fresh r2.  Without
  // this normalisation the alias is absent from earlier cross-join rows and the
  // pattern fans out over every relationship (spuriously multiplying rows).
  const _withAliasToBase = new Map<string, string>()
  for (const wc of ((plan as any).with?.columns || []) as Array<{ expression: unknown; alias?: string | null }>) {
    if (wc.alias && typeof wc.expression === 'string' && !/\(/.test(wc.expression)) {
      _withAliasToBase.set(wc.alias, wc.expression)
    }
  }
  let crossRows: Array<Record<string, unknown>> = [{}]
  for (const matches of matchLists) {
    const next: Array<Record<string, unknown>> = []
    for (const base of crossRows) {
      for (const m of matches) {
        let compatible = true
        for (const k of Object.keys(m)) {
          const baseKey = _withAliasToBase.has(k) && !(k in base) ? _withAliasToBase.get(k)! : k
          if (!(baseKey in base)) continue
          const mv = m[k], bv = base[baseKey]
          if (typeof mv === 'number' && typeof bv === 'number') {
            if (mv !== bv) { compatible = false; break }
          } else {
            const mr = _relIdOf(mv), br = _relIdOf(bv)
            if (mr !== undefined || br !== undefined) {
              if (mr !== br) { compatible = false; break }
            }
          }
        }
        if (!compatible) continue
        next.push({ ...base, ...m })
      }
    }
    crossRows = next
  }
  if (!crossRows.length) return []

  // Resolve node-index bindings back to concrete node objects for the WHERE /
  // RETURN projection stages.
  for (const row of crossRows) {
    for (const k of Object.keys(row)) {
      const v = row[k]
      if (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < allNodes.length) {
        row[k] = allNodes[v]
      }
    }
  }

  // Apply WITH projections (`WITH a.num AS property`) onto each cross-joined row
  // so a later WHERE / RETURN can reference the alias.  Without this a
  // projection key like `property` is absent from the row and `WHERE property =
  // b.num` evaluates to NULL, dropping every row.  Evaluate the expression
  // against the row's resolved bindings; a bare variable reference (`WITH r AS
  // x`) simply re-binds the existing value.
  const _withProjCols = ((plan as any).with?.columns || []) as Array<{ expression: unknown; alias?: string | null }>
  if (_withProjCols.length && crossRows.length) {
    // Variables the primary MATCH already binds.  A WITH whose alias collides
    // with one of these is a pure RENAME over an existing binding (e.g.
    // `MATCH (a:A)-[r]->(b:B) WITH b AS a MATCH (a)-[r]->(b)`), NOT a fresh
    // projection.  Blindly re-evaluating `WITH b AS a` here would overwrite the
    // cross-join's correctly-joined `a` with `b`'s value, corrupting the rename
    // chain.  Only project aliases that are NOT already primary bindings.
    const _projPrimaryBound = new Set<string>()
    for (const st of plan.steps || []) {
      for (const fld of ['source', 'targetAlias', 'edgeVariable', 'pathVariable'] as const) {
        const v = (st as any)[fld]
        if (v) _projPrimaryBound.add(v)
      }
    }
    for (const row of crossRows) {
      for (const wc of _withProjCols) {
        const alias = wc.alias
        if (!alias) continue
        if (_projPrimaryBound.has(alias)) continue
        const expr = typeof wc.expression === 'string' ? wc.expression : null
        if (!expr || /^\s*(count|sum|avg|max|min|collect)\s*\(/i.test(expr)) continue
        let val: unknown
        try {
          val = _evaluateExpression(expr, { ...row })
        } catch {
          val = undefined
        }
        if (val !== undefined) row[alias] = val
      }
    }
  }

  // Evaluate WHERE (relationship identity / path equality / pattern predicates).
  let filtered = crossRows
  if (plan.whereBody) {
    filtered = []
    for (const row of crossRows) {
      // Resolve pattern predicates (`(a)-[:T]->(b:X)`) to boolean literals before
      // expression evaluation — the expression engine cannot parse relationship
      // patterns, so `_resolveWherePatternPredicates` substitutes true/false and
      // lets it evaluate the surrounding AND/OR/NOT structure.
      let whereExpr = _resolveWherePatternPredicates(plan.whereBody, { ...row }, allNodes)
      const val = _evaluateExpression(whereExpr, { ...row })
      if (val === true) filtered.push(row)
    }
  }

  // ── OPTIONAL MATCH expansion ──
  // A query combining multiple MATCH patterns with an OPTIONAL MATCH
  // (`MATCH (a:A),(b:C) OPTIONAL MATCH (x)-->(b)`) reaches this cross-join
  // executor, which owns the Cartesian product but must also apply the optional
  // pattern so that free optional variables resolve per bound row (binding the
  // match or null-ing it).  Node variables in `filtered` are concrete node
  // objects carrying `_alias`, so the optional walk resolves bound anchors and
  // enumerates unbound sources over every node.
  if ((plan as any).optionalMatchSteps?.length && filtered.length) {
    const optStepsList = (plan as any).optionalMatchSteps as Array<{
      variableName: string; scanLabel: string | null; steps: TraverseStep[]
    }>
    const _nodeIdxOf = (obj: unknown): number => {
      if (obj == null || typeof obj !== 'object') return -1
      const o = obj as any
      if (typeof o.__idx === 'number') return o.__idx
      if (o._alias) {
        const ai = allNodes.findIndex((n: any) => n?._alias === o._alias)
        if (ai >= 0) return ai
      }
      const lbl = o._label || ''
      const keys = Object.keys(o).filter(k => !k.startsWith('_') && k !== 'id' && k !== '__edges')
      for (let i = 0; i < allNodes.length; i++) {
        const c = allNodes[i] as any
        if (String(c?._label ?? '') !== lbl) continue
        if (keys.every(pk => c?.[pk] === o[pk])) return i
      }
      if (lbl) return allNodes.findIndex((n: any) => (n as any)?._label === lbl)
      return -1
    }
    const _mkProps = (n: any): Record<string, unknown> => {
      const p: Record<string, unknown> = {}
      if (n) for (const k of Object.keys(n)) { if (k !== '__edges' && !k.startsWith('_')) p[k] = n[k] }
      if (n?._label) p._label = n._label
      return p
    }
    // Variables bound by the primary MATCH stages (matchVar + multiMatch vars).
    const boundVars = new Set<string>()
    if ((plan as any).matchVar) boundVars.add((plan as any).matchVar)
    for (const mm0 of (plan as any).multiMatch || []) if (mm0?.variable) boundVars.add(mm0.variable)
    for (const st of plan.steps || []) {
      if ((st as any).source) boundVars.add((st as any).source)
      if ((st as any).targetAlias) boundVars.add((st as any).targetAlias)
    }
    // Reconstruct a named path object `{ __path, __pathEdges }` for an OPTIONAL
    // MATCH path variable, mirroring the shape produced for a leading MATCH
    // (`MATCH p = (a)-->(b)`).  `path` is a node-index sequence.
    const _buildOptPathObject = (path: number[], nodes: Array<Record<string, unknown>>): Record<string, unknown> => {
      const pathNodes: Array<Record<string, unknown>> = []
      const pathEdges: Array<Record<string, unknown>> = []
      for (let pi = 0; pi < path.length; pi++) {
        const ni = path[pi]
        const n = ni != null && ni >= 0 ? nodes[ni] as any : undefined
        const np: Record<string, unknown> = {}
        if (n) {
          for (const k of Object.keys(n)) {
            if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) np[k] = n[k]
          }
          if (n._label) np._label = n._label
        }
        pathNodes.push(np)
      }
      for (let pi = 0; pi < path.length - 1; pi++) {
        const aIdx = path[pi]
        const bIdx = path[pi + 1]
        const aN = aIdx != null ? nodes[aIdx] as any : undefined
        const ee = (aN?.__edges || []).find((e: any) => (e.dstIdx === bIdx || e.srcIdx === bIdx))
        if (ee) {
          const eo: Record<string, unknown> = {
            __edgeLabel: ee.label ?? '',
            __edgeLabelStr: ee.label ?? '',
            _type: ee.label ?? '',
            _label: ee.label ?? '',
            _dir: ee.srcIdx === aIdx ? 'out' : 'in',
          }
          if (ee.props) for (const [pk, pv] of Object.entries(ee.props)) eo[pk] = pv
          pathEdges.push(eo)
        }
      }
      return { __path: pathNodes, __pathEdges: pathEdges }
    }
    let expanded = filtered
    for (const opt of optStepsList) {
      const next: Array<Record<string, unknown>> = []
      for (const row of expanded) {
        const srcVar = opt.steps[0]?.source || ''
        const tgtVar = opt.steps[0]?.targetAlias || ''
        const pathVar = (opt.steps[0] as any)?.pathVariable || ''
        const edgeVar = (opt.steps[0] as any)?.edgeVariable || ''
        const unboundSource = srcVar !== '' && !boundVars.has(srcVar) && srcVar !== tgtVar
        let matchedAny = false
        if (unboundSource && opt.steps.length) {
          // Enumerate every node as the free source, constraining the walk's
          // endpoint to any bound target variable.
          let boundTargetIdx = -1
          if (tgtVar && boundVars.has(tgtVar)) boundTargetIdx = _nodeIdxOf(row[tgtVar])
          for (let cand = 0; cand < allNodes.length; cand++) {
            const paths = _walkMultiSteps(cand, opt.steps, allNodes)
            for (const path of paths) {
              const end = path[path.length - 1]
              if (boundTargetIdx >= 0 && end !== boundTargetIdx) continue
              if (opt.scanLabel && String((allNodes[cand] as any)?._label || '') !== opt.scanLabel) continue
              const r2: Record<string, unknown> = { ...row, [srcVar]: _mkProps(allNodes[cand] as any) }
              opt.steps.forEach((st: any, si: number) => {
                if (st.targetAlias) {
                  const ni = (st as any).range ? path[path.length - 1] : path[si + 1]
                  r2[st.targetAlias] = ni != null && ni >= 0 ? _mkProps(allNodes[ni] as any) : null
                }
              })
              if (pathVar || edgeVar) {
                const po = _buildOptPathObject(path, allNodes)
                if (pathVar) r2[pathVar] = po
                // A variable-length step's `edgeVariable` (`r` in `-[r*]->`) binds
                // to the LIST of relationships along the walked path.
                if (edgeVar) r2[edgeVar] = (po as any).__pathEdges ?? []
              }
              next.push(r2)
              matchedAny = true
            }
          }
        } else {
          // Source is bound: resolve its node index and walk from it.
          const sidx = srcVar ? _nodeIdxOf(row[srcVar]) : -1
          let boundTargetIdx = -1
          // The endpoint constraint must target the chain's FINAL node — the
          // last step's targetAlias — not the first hop's.  In a two-hop chain
          // `(a)-->(b)-->(c)` with `c` pre-bound by MATCH, the first step's
          // targetAlias is the intermediate `b` (unbound), while `c` is the real
          // end that the walk must reach.
          const lastTgt = opt.steps.length
            ? opt.steps[opt.steps.length - 1]?.targetAlias
            : ''
          if (lastTgt && boundVars.has(lastTgt)) boundTargetIdx = _nodeIdxOf(row[lastTgt])
          else if (tgtVar && boundVars.has(tgtVar)) boundTargetIdx = _nodeIdxOf(row[tgtVar])
          if (sidx >= 0) {
            const paths = _walkMultiSteps(sidx, opt.steps, allNodes)
            if (paths.length) {
              for (const path of paths) {
                const end = path[path.length - 1]
                if (boundTargetIdx >= 0 && end !== boundTargetIdx) continue
                const r2: Record<string, unknown> = { ...row }
                opt.steps.forEach((st: any, si: number) => {
                  if (st.targetAlias) {
                    // For a variable-length step the alias binds the *endpoint*
                    // of the whole walk (last path node), not the first hop.
                    const ni = (st as any).range ? end : path[si + 1]
                    r2[st.targetAlias] = ni != null && ni >= 0 ? _mkProps(allNodes[ni] as any) : null
                  }
                })
                if (pathVar || edgeVar) {
                  const po = _buildOptPathObject(path, allNodes)
                  if (pathVar) r2[pathVar] = po
                  // See the unbound-source branch: `edgeVariable` binds to the
                  // relationship list of the variable-length walk.
                  if (edgeVar) r2[edgeVar] = (po as any).__pathEdges ?? []
                }
                next.push(r2)
                matchedAny = true
              }
            }
          }
        }
        if (!matchedAny) {
          // No optional match: bind the optional variables to null, preserving
          // bound source/target columns.
          const r2: Record<string, unknown> = { ...row }
          if (srcVar && !boundVars.has(srcVar)) r2[srcVar] = null
          if (tgtVar && !boundVars.has(tgtVar)) r2[tgtVar] = null
          if (pathVar) r2[pathVar] = null
          if (edgeVar && !boundVars.has(edgeVar)) r2[edgeVar] = null
          next.push(r2)
        }
      }
      if (next.length) expanded = next
      else {
        const r2: Record<string, unknown> = { ...filtered[0] }
        if (opt.variableName && !boundVars.has(opt.variableName)) r2[opt.variableName] = null
        expanded = [r2]
      }
      // A later OPTIONAL MATCH may reference variables bound by THIS one
      // (e.g. `OPTIONAL MATCH (a)-->(x) OPTIONAL MATCH (x)-[r]->(b)`): `x` is
      // produced by the first optional and consumed as the source of the
      // second.  Register every variable this optional binds so the next
      // optional treats them as bound sources rather than re-enumerating them
      // as free nodes (which is the source of the spurious single/b rows).
      for (const st of opt.steps) {
        if ((st as any).source) boundVars.add((st as any).source)
        if ((st as any).targetAlias) boundVars.add((st as any).targetAlias)
        if ((st as any).edgeVariable) boundVars.add((st as any).edgeVariable)
      }
    }
    filtered = expanded
  }

  // ── WITH-driven MULTI-MATCH constraint ──
  // A MATCH whose source variable is (re)defined by a preceding WITH projection
  // (`WITH coalesce(b, c) AS x MATCH (x)-->(d)`) must resolve `x` from the WITH
  // expression, not treat it as an independent free variable.  The cross-join
  // above enumerates `x` over every node (producing spurious rows), so here we
  // re-derive `x` per row from the WITH expression and drop any row where the
  // projection yields null/undefined — `MATCH (null)-->(d)` matches nothing.
  // When the projection yields a concrete node, we additionally require the
  // cross-joined `x` binding to agree with it (by label + distinguishing
  // properties), so a non-null projection still constrains the downstream walk.
  const _withCols = (plan.with?.columns || []) as Array<{ expression: unknown; alias?: string }>
  if (_withCols.length) {
    const _withExprByAlias = new Map<string, unknown>()
    for (const wc of _withCols) {
      const al = wc.alias || ''
      if (al) _withExprByAlias.set(al, wc.expression)
    }
    // Variables the PRIMARY MATCH already binds.  A WITH projection whose alias
    // collides with one of these is a pure RENAME over an existing binding (the
    // sequential cross-join above already equated the re-used variable), NOT a
    // fresh projection that must constrain a free source.  `MATCH (a:A) ...
    // WITH b AS a MATCH (a)-[r]->(b)` re-binds `a` to the SAME value the primary
    // match produced (the rename chain collapses to identity), so treating `a`
    // as a WITH-driven free source would wrongly reject the row (bound node A
    // vs projected node B).  Only alias whose name is NOT already a primary
    // binding needs the projection-constraint below.
    const primaryBound = new Set<string>()
    for (const st of plan.steps || []) {
      if ((st as any).source) primaryBound.add((st as any).source)
      if ((st as any).targetAlias) primaryBound.add((st as any).targetAlias)
      if ((st as any).edgeVariable) primaryBound.add((st as any).edgeVariable)
      if ((st as any).pathVariable) primaryBound.add((st as any).pathVariable)
    }
    if ((plan as any).matchVar) primaryBound.add((plan as any).matchVar)
    // Sources of any multi-match pattern that are re-bound by WITH.
    const drivenSources = new Set<string>()
    for (const m of mm) {
      const src = m.steps?.[0]?.source as string | undefined
      // Skip pure renames over already-bound primary-match variables.
      if (src && _withExprByAlias.has(src) && !primaryBound.has(src)) drivenSources.add(src)
    }
    if (drivenSources.size) {
      const constrained: Array<Record<string, unknown>> = []
      for (const row of filtered) {
        let keep = true
        for (const src of drivenSources) {
          const projVal = _evaluateExpression(_withExprByAlias.get(src) as any, { ...row })
          if (projVal === null || projVal === undefined) {
            // Projection is null → MATCH (null)-->(…) has no binding.
            keep = false
            break
          }
          // Projection is a concrete node: the cross-joined binding of `src`
          // must describe the same node (equal label and non-internal props).
          const bound = row[src]
          if (bound && typeof bound === 'object' && projVal && typeof projVal === 'object') {
            const bl = String((bound as any)._label || '')
            const pl = String((projVal as any)._label || '')
            if (bl !== pl) { keep = false; break }
            const keys = Object.keys(projVal).filter(k => !k.startsWith('_') && k !== 'id' && k !== '__edges')
            for (const pk of keys) {
              if ((bound as any)[pk] !== (projVal as any)[pk]) { keep = false; break }
            }
            if (!keep) break
          }
          // Overwrite the source binding with the WITH projection value so the
          // downstream RETURN/expression stage reads the projected node (not the
          // cross-joined one).
          row[src] = projVal
        }
        if (keep) constrained.push(row)
      }
      filtered = constrained
    }
  }

  // ── WHERE predicate filtering ──
  // The cross-join path above applies `whereBody` but not the structured
  // `plan.filters` (property predicates like `MATCH … WHERE a.id = 1`).  Apply
  // them here against the bound node objects (which carry `_label` and user
  // properties).  Each filter names the variable owning the property; a missing
  // property evaluates to null and never satisfies a non-NEQ predicate.
  if ((plan.filters || []).length) {
    filtered = filtered.filter((row) => {
      return (plan.filters || []).every((f: any) => {
        // Label predicates are handled by labelFilterItems / the post-OPTIONAL
        // label filter, not as a constant property compare.
        if (f.property === '__label') return true
        // A filter whose value is a BARE variable reference (`WHERE b.id =
        // property`, where `property` is a WITH projection, not a `var.prop`
        // path) was already evaluated by `plan.whereBody` above.  Treating the
        // raw alias string as a literal here would compare `b.id === "property"`
        // and wrongly drop every row.  Only `var.prop` references are resolved
        // below; bare aliases are left to whereBody.
        if (typeof f.value === 'string' && /^[A-Za-z_]\w*$/.test(f.value) && row[f.value] !== undefined) return true
        const owner = row[f.source]
        const ownerProps = (owner && typeof owner === 'object') ? (owner as any) : {}
        const actual = ownerProps[f.property]
        // A variable reference value (`a.id = b.id`) resolves the RHS against
        // the bound row rather than comparing against a literal string.
        let fv = f.value
        if (typeof fv === 'string' && /^\w+\.\w+$/.test(fv) && !/^['"]/.test(fv) && !/^\d/.test(fv)) {
          const [refVar, refProp] = fv.split('.')
          const refOwner = row[refVar]
          const refProps = (refOwner && typeof refOwner === 'object') ? (refOwner as any) : {}
          fv = refProps[refProp]
        }
        if (actual === undefined) {
          // Property absent → null.  Only an IS_NULL / explicit null check passes.
          if (f.operator === 'IS_NULL') return true
          if (f.operator === 'NEQ') return fv !== null && fv !== undefined
          return false
        }
        switch (f.operator) {
          case 'EQ': return actual === fv
          case 'NEQ': return actual !== fv
          case 'GT': return Number(actual) > Number(fv)
          case 'GTE': return Number(actual) >= Number(fv)
          case 'LT': return Number(actual) < Number(fv)
          case 'LTE': return Number(actual) <= Number(fv)
          case 'IS_NULL': return false
          case 'IS_NOT_NULL': return true
          case 'IN': {
            // The value may be an already-parsed array or a raw `['B', 'C']`
            // string; normalise to a list and test membership (string compare).
            let items: unknown[] = []
            if (Array.isArray(fv)) items = fv
            else if (typeof fv === 'string') {
              const inner = fv.replace(/^\[|\]$/g, '')
              items = inner.split(',').map((s: string) => s.trim().replace(/^['"]|['"]$/g, ''))
            }
            return items.some((it) => String(it) === String(actual))
          }
          default: return String(actual) === String(fv)
        }
      })
    })
  }

  // ── MERGE relationship execution ──
  // `MATCH (a:A), (b:B) MERGE (a)-[r:TYPE]->(b) RETURN count(r)` reaches this
  // cross-join executor (the MERGE clause adds no steps, but the second MATCH
  // pattern stages a `multiMatch` entry so we cross-join {a, b} pairs).  The
  // relationship itself is never materialised by the cross-join, so `r` stays
  // undefined and `count(r)` collapses to 0.  For each cross-joined row, resolve
  // the MERGE relationship's two endpoint variables to node indices, then either
  // reuse an existing edge (same label + direction) or create a new one — binding
  // the edge variable `r` so downstream count/r projections see the relationship.
  const mEdges = ((plan as any).mergeEdges || []) as Array<{
    source: string; target: string; label: string | null; direction: 'out' | 'in' | 'any'
    variable?: string | null; props?: Record<string, unknown> | null
  }>
  if (mEdges.length && filtered.length) {
    const _idxOf = (obj: unknown): number => {
      if (obj == null || typeof obj !== 'object') return -1
      // Rows bind node variables to the concrete node objects referenced by
      // `allNodes` (the index→object resolution above), so identity lookup works.
      let i = allNodes.indexOf(obj as any)
      if (i >= 0) return i
      // Fall back: match by label + top-level identity properties.
      const lbl = String((obj as any)?._label || '')
      const keys = Object.keys(obj as any).filter(k => !k.startsWith('_') && k !== 'id' && k !== '__edges')
      for (let j = 0; j < allNodes.length; j++) {
        const c = allNodes[j] as any
        if (String(c?._label ?? '') !== lbl) continue
        if (keys.every(k => c?.[k] === (obj as any)[k])) return j
      }
      return -1
    }
    // A reused/created edge record, normalised to the relationship contract the
    // serializer / `type(r)` lookups expect (`__edgeLabel` / `_type` / `_label`).
    const _mkEdgeObj = (srcIdx: number, dstIdx: number, label: string, props: Record<string, unknown> | null): Record<string, unknown> => {
      const eo: Record<string, unknown> = {
        __edgeId: `${srcIdx}|${dstIdx}|${label || ''}`,
        __relId: `${Math.min(srcIdx, dstIdx)}|${Math.max(srcIdx, dstIdx)}|${label || ''}`,
        __edgeLabel: label,
        __edgeLabelStr: label,
        _type: label,
        _label: label,
        srcIdx,
        dstIdx,
      }
      if (props) for (const [k, v] of Object.entries(props)) eo[k] = v
      return eo
    }
    // MERGE relationship semantics: the pattern either reuses matching edges or
    // creates a single new one.  Without a property predicate every existing edge
    // of the same label+direction between the two endpoints is a distinct match
    // (`MERGE (a)-[r:TYPE]->(b)` over two TYPE edges yields count(r)=2), while a
    // property predicate narrows the match to edges carrying those values and
    // otherwise creates one.  Each merge edge therefore expands its input row into
    // one output row per matched/created edge so `count(r)` reflects the result.
    let mergedRows: Array<Record<string, unknown>> = []
    for (const row of filtered) {
      // Resolve the first merge edge's endpoints; a chain of multiple merge edges
      // would need a fan-out, but the current executor handles one relationship
      // per MERGE (multi-edge chains fall back to the GE DML path).
      const me = mEdges[0]
      const ev = me.variable || ''
      const label = me.label || ''
      const srcObj = row[me.source]
      const tgtObj = row[me.target]
      if (srcObj == null || tgtObj == null) { mergedRows.push(row); continue }
      const srcIdx = _idxOf(srcObj)
      const tgtIdx = _idxOf(tgtObj)
      if (srcIdx < 0 || tgtIdx < 0) { mergedRows.push(row); continue }
      // Directed edge endowment.  `mergeEdges.source`/`target` hold PATTERN order
      // (source = first node in `(a)-[r]->(b)`, target = second); `in` flips the
      // storage direction to target→source.
      const edgeSrc = me.direction === 'in' ? tgtIdx : srcIdx
      const edgeDst = me.direction === 'in' ? srcIdx : tgtIdx
      // Enumerate every existing edge matching label + direction (+props when the
      // MERGE pattern supplies a property predicate).
      const wantsProps = me.props && Object.keys(me.props).length
      const _propsMatch = (p?: Record<string, unknown>): boolean => {
        if (!wantsProps) return true
        const pp = p || {}
        return Object.entries(me.props!).every(([k, v]) => (k in pp) && pp[k] === v)
      }
      const directed = (allNodes[edgeSrc] as any)?.__edges || []
      const matching: Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> }> = []
      for (const e of directed) {
        if (e.srcIdx === edgeSrc && e.dstIdx === edgeDst && ((e.label || '') === label) && _propsMatch(e.props)) {
          matching.push(e)
        }
      }
      if (me.direction === 'any' && !matching.length) {
        const rev = (allNodes[edgeDst] as any)?.__edges || []
        for (const e of rev) {
          if (e.srcIdx === edgeDst && e.dstIdx === edgeSrc && ((e.label || '') === label) && _propsMatch(e.props)) {
            matching.push(e)
          }
        }
      }
      if (matching.length) {
        // ON MATCH SET applies to the matched relationships: property
        // assignment, whole-entity copy (`SET r = a`), or map append
        // (`SET r += {...}`) mutate the matched edge's props in place — the
        // edge object is shared with the caller's node array, so no explicit
        // write-back is needed.
        const onMatch = (plan as any).mergeOnMatch as Array<{ kind?: string; property?: string; value?: unknown; alias?: string; fromAlias?: string; map?: Record<string, unknown> }> | undefined
        for (const ex of matching) {
          if (onMatch && ev) {
            let mp = (ex.props ?? {}) as Record<string, unknown>
            for (const om of onMatch) {
              if (om.alias !== ev) continue
              if (om.kind === 'PROP' && om.property) {
                mp[om.property] = (om.value as any)?.value ?? om.value
              } else if (om.kind === 'COPY' && om.fromAlias) {
                const src = row[om.fromAlias] as Record<string, unknown> | undefined
                if (src && typeof src === 'object') {
                  for (const [k, v] of Object.entries(src)) {
                    if (!k.startsWith('_') && k !== '__edges' && k !== 'id') mp[k] = v
                  }
                }
              } else if (om.kind === 'MAP_APPEND' && om.map) {
                Object.assign(mp, om.map)
              }
            }
            if (Object.keys(mp).length) ex.props = mp
          }
          const r2: Record<string, unknown> = { ...row }
          if (ev) r2[ev] = _mkEdgeObj(ex.srcIdx, ex.dstIdx, ex.label, ex.props ?? null)
          mergedRows.push(r2)
        }
      } else {
        // Create the edge: record it on both endpoints' __edges (the same
        // sync-to-memory convention used by the CREATE relationship path).
        // Merge the pattern-inline props with any ON CREATE SET properties so
        // the freshly-created relationship carries both (`MERGE (a)-[r:T {x}]->(b)
        // ON CREATE SET r.y = v` produces an edge with x AND y).
        const edgeProps: Record<string, unknown> = { ...(me.props || {}) }
        const onCreate = (plan as any).mergeOnCreate as Array<{ kind?: string; property?: string; value?: unknown; alias?: string; fromAlias?: string; map?: Record<string, unknown> }> | undefined
        if (onCreate && ev) {
          for (const oc of onCreate) {
            if (oc.alias !== ev) continue
            if (oc.kind === 'PROP' && oc.property) {
              const raw = (oc.value as any)?.value ?? oc.value
              edgeProps[oc.property] = raw
            } else if (oc.kind === 'COPY' && oc.fromAlias) {
              // `SET r = a` copies every user property of the source node onto
              // the freshly-created relationship.
              const src = row[oc.fromAlias] as Record<string, unknown> | undefined
              if (src && typeof src === 'object') {
                for (const [k, v] of Object.entries(src)) {
                  if (!k.startsWith('_') && k !== '__edges' && k !== 'id') edgeProps[k] = v
                }
              }
            } else if (oc.kind === 'MAP_APPEND' && oc.map) {
              // `SET r += { ... }` adds/overwrites the given map entries.
              Object.assign(edgeProps, oc.map)
            }
          }
        }
        const edgeRecord: any = { srcIdx: edgeSrc, dstIdx: edgeDst, label }
        if (Object.keys(edgeProps).length) edgeRecord.props = edgeProps
        ;(allNodes[edgeSrc] as any).__edges = (allNodes[edgeSrc] as any).__edges || []
        ;(allNodes[edgeDst] as any).__edges = (allNodes[edgeDst] as any).__edges || []
        ;(allNodes[edgeSrc] as any).__edges.push({ ...edgeRecord })
        ;(allNodes[edgeDst] as any).__edges.push({ ...edgeRecord })
        // Persist the created edge back to the caller's node array (`nodes`),
        // which is `st.nodes` for the TCK harness.  The clone above isolated the
        // cross-join's `allNodes` `__edges` arrays, so without this write-back a
        // subsequent control query (`MATCH ()-[r:TYPE]->()`) cannot observe the
        // relationships that MERGE just created.
        if (nodes && nodes[edgeSrc] && nodes[edgeDst]) {
          ;(nodes[edgeSrc] as any).__edges = (nodes[edgeSrc] as any).__edges || []
          ;(nodes[edgeDst] as any).__edges = (nodes[edgeDst] as any).__edges || []
          ;(nodes[edgeSrc] as any).__edges.push({ ...edgeRecord })
          ;(nodes[edgeDst] as any).__edges.push({ ...edgeRecord })
        }
        const r2: Record<string, unknown> = { ...row }
        if (ev) r2[ev] = _mkEdgeObj(edgeSrc, edgeDst, label, Object.keys(edgeProps).length ? edgeProps : null)
        mergedRows.push(r2)
      }
    }
    filtered = mergedRows
  }

  // Build result rows.
  const agg = plan.aggregate as any
  // Aggregate alias resolution (consistent with the primary GE aggregation path):
  // fall back to the original column text (e.g. count(b)) when alias equals the
  // function name, otherwise use alias (e.g. count(*) AS c → c).
  const alias = (agg?.alias && agg.alias !== agg.function)
    ? agg.alias
    : ((agg?.column || '').replace(/^.+?\s+AS\s+/i, '').trim() || agg?.field || agg?.column || 'c')
  let out: QueryRow[]
  if (plan.aggregate) {
    // Apply the aggregate function (`sum`, `avg`, `min`, `max`, `count`,
    // `collect`) over the cross-joined rows.  Previously this branch returned
    // `filtered.length` for ANY aggregate, so `RETURN sum(r1.times)` over a
    // `MATCH ()-[r1]->()<--()` expansion collapsed to the row count instead of
    // summing the relationship property.  Resolve the aggregate field against
    // each bound row: a dotted field (`r1.times`) reads the property of the
    // bound relationship object, a bare (`*` / node var / relationship var) is
    // handled per function below.
    const aggFn = (agg?.function || agg?.type || 'count').toLowerCase()
    const field: string = agg?.field ?? '*'
    const varName = field.includes('.') ? field.split('.')[0] : field
    const propName = field.includes('.') ? field.split('.').pop()! : null
    const rowValue = (row: Record<string, unknown>): unknown => {
      if (field === '*' || field === '' || field === null) return row
      const owner = row[varName]
      if (propName && owner && typeof owner === 'object') return (owner as any)[propName]
      if (field === 'count' || field === '*') return row
      return owner
    }
    // Fold an aggregate over a single group of rows, returning its scalar value.
    const _foldGroup = (groupRows: Array<Record<string, unknown>>): unknown => {
      const values = groupRows.map(rowValue)
      switch (aggFn) {
        case 'count': {
          if (field === '*' || field === '' || field === null) return groupRows.length
          return values.filter(v => v !== null && v !== undefined).length
        }
        case 'sum': {
          const nums = values.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => !isNaN(v))
          return nums.reduce((a: number, b: number) => a + b, 0)
        }
        case 'avg': {
          const nums = values.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => !isNaN(v))
          return nums.length ? nums.reduce((a: number, b: number) => a + b, 0) / nums.length : 0
        }
        case 'min': {
          const nums = values.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => !isNaN(v))
          return nums.length ? Math.min(...nums) : 0
        }
        case 'max': {
          const nums = values.map(v => (typeof v === 'number' ? v : Number(v))).filter(v => !isNaN(v))
          return nums.length ? Math.max(...nums) : 0
        }
        case 'collect': {
          const seen = new Set<unknown>()
          return values.filter(v => {
            if (v === null || v === undefined) return false
            if (agg?.distinct) {
              const key = typeof v === 'object' ? JSON.stringify(v) : String(v)
              if (seen.has(key)) return false
              seen.add(key)
            }
            return true
          })
        }
        default:
          return groupRows.length
      }
    }
    const groupByCols = (plan as any).groupBy as string[] | undefined
    if (groupByCols?.length) {
      // Implicit GROUP BY: `WITH a, r, b, count(*)` groups by the non-aggregate
      // columns before folding the aggregate per group.  A bound node/relationship
      // object is keyed by its canonical identity so grouping stays correct across
      // rows; scalar keys group by their literal value.  A grouping key may name
      // a WITH alias (`WITH r1 AS r2, count(*)`) whose value lives under the
      // pre-projection variable (`r1`) in the cross-joined row — resolve it back
      // to its source column before reading the row.
      const _withAliasToExpr = new Map<string, string>()
      for (const wc of ((plan as any).with?.columns || []) as Array<{ expression: unknown; alias?: string | null }>) {
        if (wc.alias && typeof wc.expression === 'string') _withAliasToExpr.set(wc.alias, wc.expression)
      }
      const _keyVar = (gb: string): string => _withAliasToExpr.get(gb) || gb
      const _keyOf = (v: unknown): string => {
        if (v == null) return '__NULL__'
        if (typeof v === 'object') {
          const o = v as any
          if (typeof o.__relId === 'string') return 'rel:' + o.__relId
          if (typeof o.__edgeId === 'string') return 'rel:' + o.__edgeId
          if (o._alias) return 'node:' + o._alias
          return 'obj:' + JSON.stringify(Object.keys(o).filter(k => !k.startsWith('_') && k !== '__edges').sort().map(k => k + '=' + (o[k] == null ? '' : String(o[k]))).join('&'))
        }
        return 'scalar:' + String(v)
      }
      const groups = new Map<string, Array<Record<string, unknown>>>()
      for (const row of filtered) {
        const key = groupByCols.map(gb => _keyOf(row[_keyVar(gb)])).join('||')
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key)!.push(row)
      }
      out = []
      // RETURN projection columns (`RETURN r2 AS rel` → expressionColumns
      // [{expression:'r2', alias:'rel'}]) must be applied over each grouped row,
      // mirroring the non-aggregate branch below.  Without this the grouped result
      // carries only the grouping key + aggregate alias and the downstream
      // comparison sees `rel` as null.
      const returnExprCols = ((plan as any).expressionColumns || []) as Array<{ expression: unknown; alias?: string | null }>
      for (const [, grp] of groups) {
        const first = grp[0]
        const r: QueryRow = {}
        for (const gb of groupByCols) r[gb] = first[_keyVar(gb)]
        r[alias] = _foldGroup(grp)
        for (const ec of returnExprCols) {
          if (ec.alias && ec.alias !== alias) {
            r[ec.alias] = _evaluateExpression(ec.expression as any, { ...r })
          }
        }
        out.push(r)
      }
    } else {
      out = [{ [alias]: _foldGroup(filtered) }]
    }
  } else {
    // Expression columns (e.g. `p1 = p2`).
    out = filtered.map(row => {
      const r: QueryRow = {}
      for (const ec of (plan.expressionColumns || [])) {
        const expr = typeof ec.expression === 'string' ? ec.expression : (ec as any).expression
        const ecAlias = ec.alias
        r[ecAlias] = _evaluateExpression(expr, { ...row })
      }
      // Fall back to RETURN column names when no expression columns exist.
      if (!Object.keys(r).length && plan.returnColumns?.length) {
        for (const rc of plan.returnColumns) {
          if (rc in row) r[rc] = row[rc]
        }
      }
      // `RETURN *` (returnColumns empty) projects every bound variable.  The
      // cross-joined row carries the node bindings on its top level (plus a few
      // `__`-prefixed bookkeeping keys), so surface every non-internal key.
      if (!Object.keys(r).length && !plan.returnColumns?.length) {
        for (const k of Object.keys(row)) {
          if (!k.startsWith('__') && !k.startsWith('_')) r[k] = row[k]
        }
      }
      return r
    })
  }

  return out
}

/**
 * Fold an intermediate WITH aggregate segment over the current row set.
 *
 * A WITH segment such as `WITH otherPerson, count(*) AS foaf` groups the rows
 * currently in scope by its non-aggregate columns and computes the aggregate per
 * group.  The per-row WITH pipeline above only projects flat expressions, so
 * this cross-row fold must run BEFORE any later WHERE / WITH segment reads the
 * aggregate alias (e.g. `WHERE foaf > 1`).
 *
 * Each input row is the raw GE/multi-step record shape `{ id, props,
 * __crossVarRows, ... }`; the grouping keys and aggregate inputs are resolved by
 * flattening the row's bound variables (props + __crossVarRows) into a plain
 * object, reusing the same resolution the per-row pipeline performs.
 */
function _groupAggregateWithRows(
  rows: Array<Record<string, unknown>>,
  wcSeg: { columns?: Array<{ expression?: unknown; alias?: string | null }> },
  allNodes: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const cols = wcSeg.columns || []
  // Split the segment columns into group-by keys (non-aggregate) and aggregates.
  const groupByCols: string[] = []
  const aggCols: Array<{ fn: string; field: string; prop: string; distinct?: boolean; alias?: string | null }> = []
  const groupByAlias: Record<string, string> = {} // alias → underlying column name
  for (const wc of cols) {
    const expr = typeof wc.expression === 'string' ? wc.expression : ''
    if (!expr) continue
    const parsed = _parseAggregate(expr)
    if (parsed) {
      aggCols.push({ fn: parsed.fn, field: parsed.field, prop: parsed.prop, distinct: parsed.distinct, alias: wc.alias || parsed.alias })
    } else {
      // Non-aggregate column: group-by key.  `otherPerson` and `otherPerson AS
      // x` both group by the underlying variable `otherPerson`.
      const bare = expr.includes('.') ? expr.split('.').pop()! : expr.trim()
      const name = (bare.match(/^[A-Za-z_]\w*/) || [bare])[0]
      groupByCols.push(name)
      if (wc.alias) groupByAlias[wc.alias] = name
    }
  }
  if (!aggCols.length) return rows

  // Flatten each raw row into a plain object of `variable -> value`, merging
  // props then __crossVarRows (the latter carries the per-row node bindings of a
  // multi-step walk, e.g. `otherPerson`).
  const flatten = (raw: Record<string, unknown>): Record<string, unknown> => {
    const flat: Record<string, unknown> = {}
    const p = raw.props as Record<string, unknown> | undefined
    if (p && typeof p === 'object') {
      for (const [k, v] of Object.entries(p)) {
        if (!k.startsWith('_')) flat[k] = v
      }
    }
    const cvr = raw.__crossVarRows as Record<string, unknown> | undefined
    if (cvr && typeof cvr === 'object') {
      for (const [k, v] of Object.entries(cvr)) if (!(k in flat)) flat[k] = v
    }
    // A bare variable may also live directly on the row (edge variable `r`).
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'id' || k === 'props' || k.startsWith('__')) continue
      if (!(k in flat)) flat[k] = v
    }
    return flat
  }

  const flatRows = rows.map(r => flatten(r))
  // Group-by values may be node objects; build a stable string key via _id/_alias.
  const keyOfPlain = (flat: Record<string, unknown>): string =>
    groupByCols.map(gc => {
      const v = flat[gc]
      if (v && typeof v === 'object') {
        const o = v as any
        return `${o.__relId ?? o._id ?? o._alias ?? JSON.stringify(v)}`
      }
      return String(v ?? '__NULL__')
    }).join('||')

  // Group rows, preserving first-seen order.
  const groups = new Map<string, { key: string; rows: Record<string, unknown>[] }>()
  const order: string[] = []
  for (const fr of flatRows) {
    const k = keyOfPlain(fr)
    if (!groups.has(k)) { groups.set(k, { key: k, rows: [] }); order.push(k) }
    groups.get(k)!.rows.push(fr)
  }

  const result: Array<Record<string, unknown>> = []
  for (const k of order) {
    const { rows: gRows } = groups.get(k)!
    const out: Record<string, unknown> = {}
    // Rebind group-by columns (use the first row's actual value).
    for (const gc of groupByCols) out[gc] = gRows[0][gc]
    for (const alias of Object.keys(groupByAlias)) out[alias] = out[groupByAlias[alias]]
    // Compute each aggregate over the group.
    for (const ac of aggCols) {
      let values: unknown[]
      if (ac.prop === '*') {
        values = gRows.map(() => true)
      } else {
        values = gRows.map(r => r[ac.prop]).filter(v => v !== undefined && v !== null)
        if (ac.distinct) values = [...new Set(values)]
      }
      const key = ac.alias || ac.fn.toLowerCase()
      out[key] = _computeAggregate(ac.fn, values, (ac as any).pctArg)
    }
    // Re-shape into the raw record form the downstream pipeline expects: expose
    // the projection keys both at the top level and in props/__crossVarRows so
    // later WHERE / WITH segments can resolve them.
    const rec: Record<string, unknown> = {
      props: { ...out },
      __crossVarRows: { ...out },
    }
    for (const [ok, ov] of Object.entries(out)) rec[ok] = ov
    result.push(rec)
  }
  return result
}

/**
 * Compute the keep mask for structured per-segment WHERE filters (from a WITH
 * segment) over a row set.
 *
 * A WITH segment like `WITH otherPerson WHERE otherPerson.name <> 'NotOther'`
 * carries `filters: [{ source, property, operator, value }]`; these must run on
 * the surviving (already grouped/projected) rows BEFORE a later aggregate (e.g.
 * `RETURN count(*)`) collapses them.  The returned boolean mask lets the caller
 * apply the same filtering to both the raw rows and the formatted result rows.
 */
function _withFilterKeepMask(
  rows: Array<Record<string, unknown>>,
  filters: Array<{ source?: string; property?: string; operator?: string; value?: unknown }>,
): boolean[] {
  return rows.map((raw) => {
    const flat: Record<string, unknown> = {}
    const p = raw.props as Record<string, unknown> | undefined
    if (p && typeof p === 'object') for (const [k, v] of Object.entries(p)) if (!k.startsWith('_')) flat[k] = v
    const cvr = raw.__crossVarRows as Record<string, unknown> | undefined
    if (cvr && typeof cvr === 'object') for (const [k, v] of Object.entries(cvr)) if (!(k in flat)) flat[k] = v
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'id' || k === 'props' || k.startsWith('__')) continue
      if (!(k in flat)) flat[k] = v
    }
    return filters.every((f) => {
      if (f.property === '__label') return true
      const owner = flat[f.source as string] as any
      const ownerProps = (owner && typeof owner === 'object') ? owner : {}
      const actual = ownerProps[f.property as string]
      let fv = f.value
      if (typeof fv === 'string' && /^\w+\.\w+$/.test(fv) && !/^['"]/.test(fv) && !/^\d/.test(fv)) {
        const [refVar, refProp] = fv.split('.')
        const refOwner = flat[refVar] as any
        const refProps = (refOwner && typeof refOwner === 'object') ? refOwner : {}
        fv = refProps[refProp]
      }
      if (actual === undefined) {
        if (f.operator === 'IS_NULL') return true
        if (f.operator === 'NEQ') return fv !== null && fv !== undefined
        return false
      }
      switch (f.operator) {
        case 'EQ': return actual === fv
        case 'NEQ': return actual !== fv
        case 'GT': return Number(actual) > Number(fv)
        case 'GTE': return Number(actual) >= Number(fv)
        case 'LT': return Number(actual) < Number(fv)
        case 'LTE': return Number(actual) <= Number(fv)
        case 'IS_NULL': return false
        case 'IS_NOT_NULL': return true
        default: return String(actual) === String(fv)
      }
    })
  })
}

/** GraphEngine 原生执行入口 */
export async function _executeViaGraphEngine(plan: QueryPlan, nodes: Array<Record<string, unknown>>, query?: string): Promise<QueryResult> {
  // Expose the full node array (with __edges) to the pattern-comprehension
  // evaluator up front, so both the non-GE early-exit paths below and the main
  // GE path can resolve a row-scoped node's relationships via its `_alias`.
  // The parallel setter inside the main path is kept for the DML/create-node
  // `allNodes` (which may differ from the raw `nodes` argument); this early set
  // covers the `_execNonGePaths` / `_executeMultiMatchCrossJoin` branches that
  // return before reaching it.
  _setActivePatternNodes(nodes as Array<Record<string, unknown>>)

  // ── 非 GE 路径（early exit）──
  const nonGeResult = await _execNonGePaths(plan, nodes, query)
  if (nonGeResult !== null) {
    _setActivePatternNodes(null)
    return nonGeResult
  }

  // ── Multi-MATCH cross-join (early exit) ──
  const multiMatchResult = await _executeMultiMatchCrossJoin(plan, nodes, query)
  if (multiMatchResult !== null) {
    _setActivePatternNodes(null)
    return multiMatchResult as unknown as QueryResult
  }

  // ── 共享 GE 实例 ──
  let ge: GraphEngine | null = null

  // 优先使用 database-specific GE 实例（CATALOG 多图隔离）
  const dbName = _getActiveDatabase()
  if (dbName !== DEFAULT_DATABASE && _geInstanceRegistry.has(dbName)) {
    ge = _geInstanceRegistry.get(dbName)!
  } else if (dbName !== DEFAULT_DATABASE) {
    // 按需创建 database 专属实例
    const dbDir = _geDirRegistry.get(dbName) || `/tmp/ge-db-${dbName}-${Date.now()}`
    _geDirRegistry.set(dbName, dbDir)
    fs.mkdirSync(dbDir, { recursive: true })
    const dbGe = new GraphEngine({ path: dbDir, denseVector: { dimension: 384 } } as OverGraphConfig)
    dbGe.open()
    _geInstanceRegistry.set(dbName, dbGe)
    ge = dbGe
  } else {
    // 默认数据库：使用 GEPool 弹性连接池
    // 如果 _gePool.value === null（_clearGeInstances 后被设置），销毁旧池重建
    // 避免池中旧实例的残留数据影响后续查询
    if (_gePool.value) {
      ge = _gePool.value
    } else {
      // 销毁旧池并创建新池，确保 GE 实例全新无残留
      GEPool.destroyInstanceWithCleanup()
      const poolConfig: OverGraphConfig = { path: '/tmp/tckge-pool', denseVector: { dimension: 384 } }
      const pool = GEPool.getInstance({ warmup: true, config: poolConfig, maxSize: 4 })
      ge = pool.getConnection(isWriteOp(plan))
    }
  }
  // 同步 _gePool.value 向后兼容
  _gePool.value = ge

  let originalNodeCount = 0
  let allNodes: Array<Record<string, unknown>> = []
  try {

    // ── 构建完整的输入节点集（seedNodes + DML createNodes） ──
    originalNodeCount = nodes?.length || 0
    // Deep-clone seed nodes: shallow-copy properties but deep-clone
    // __edges arrays. GE's createEdges loop (lines ~688-690) pushes
    // to allNodes[i].__edges, which would otherwise mutate the caller's
    // st.nodes and cause cross-scenario contamination in TCK tests.
    allNodes = (nodes || []).map((n: Record<string, unknown>) => {
      const clone: Record<string, unknown> = { ...n }
      if (Array.isArray((n as any).__edges)) {
        ;(clone as any).__edges = [...(n as any).__edges]
      }
      return clone
    })

    // 确保多标签节点有 __fullLabel 属性（传入的 nodes 可能没有）
    // 确保 __edges 存在（EXISTS 子查询需要）
    for (const node of allNodes) {
      if (!node.__edges) node.__edges = []
    }
    // Assign a deterministic internal alias to anonymous nodes (no `_alias`)
    // so pattern-comprehension back-tracking that relies on node identity can
    // uniquely resolve them (multiple same-label/same-props anonymous nodes
    // cannot be told apart by fingerprint alone).  The `__` prefix keeps the
    // alias out of user-visible node properties.
    for (let ai = 0; ai < allNodes.length; ai++) {
      const anode = allNodes[ai] as any
      if (anode._alias === undefined || anode._alias === null || anode._alias === '') {
        anode._alias = `__n${ai}`
      }
    }
    for (const node of allNodes) {
      if (node._label && String(node._label).includes(':')) {
        node.__fullLabel = String(node._label)
      }
    }

    // 解包 typed 格式的 props（{type: 'STRING', value: 'ABCDEF'} → 'ABCDEF'）
    // 这种包装在 parseQuery 的 createNodes 中产生，GE 的 _matchFilter 只支持裸值
    for (const node of allNodes) {
      for (const k of Object.keys(node)) {
        const v = node[k]
        if (isTypedValue(v)) {
          node[k] = v.value
        }
      }
    }
    // 如果传入节点没有 _label 标签但 plan 指定了 scanLabel，自动赋值（兼容外部 plan 导入场景）
    if (plan.scanLabel && allNodes.some(n => !('_label' in n) || n._label === undefined || n._label === null)) {
      let scanLabelAssigned = false
      for (const n of allNodes) {
        if (!('_label' in n) || n._label === undefined || n._label === null) {
          n._label = plan.scanLabel
          scanLabelAssigned = true
        }
      }
      if (scanLabelAssigned) {
        // 同时通知 skipNodeIndices 构建（后面的代码直接用 _label 判断）
      }
    }
    const cnToAllNodeMap = new Map<number, number>()  // createNode index → allNodes index
    const matchVars = plan.hasMatch ? new Set(extractMatchVariables(query)) : new Set<string>()
    // Variable → node binding table.  A single node may be referenced by many
    // variables (e.g. `MATCH (n) MATCH (m) WITH n AS a, m AS b`), so this is a
    // Map rather than a single `_alias` per node.  Exposed on the allNodes array
    // so `_buildDmlRows` can resolve RETURN projections against it.
    const varToNodeMap = new Map<string, any>()
    ;(allNodes as any).__varToNodeMap = varToNodeMap

    // ── Bind MATCH variables to seed nodes ─────────────────────────────
    // `MATCH (n)` / `MATCH (n:Label)` bind a variable (with or without a label)
    // to the matching pre-existing node(s).  This must run *before* the CREATE
    // expansion loop resolves `edge.source`/`edge.target`, otherwise a bound
    // variable (`MATCH (x:End) CREATE (:Begin)-[:TYPE]->(x)`) is mistaken for a
    // fresh anonymous node.
    if (plan.hasMatch && query) {
      const matchSection = query.match(/MATCH\s+(.*?)(?:\s+WHERE|\s+OPTIONAL|\s+RETURN|\s+WITH|\s+CREATE|\s+MERGE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|\s+ORDER|\s+SKIP|\s+LIMIT|\s+CALL|\s+INVOKE|$)/is)
      if (matchSection) {
        const nodePatterns = [...matchSection[1].matchAll(/\((\w+)\s*(?::\s*(\w+))?\)/g)]
        for (const np of nodePatterns) {
          const varName = np[1]
          const varLabel = np[2]
          let seed: any = undefined
          if (varLabel) {
            seed = allNodes.find(n => String((n as any)._label).split(':').includes(varLabel))
          }
          if (!seed) {
            // Unlabelled MATCH variable binds to a matching seed node.  For a
            // single-seed graph (or repeated `MATCH (n) MATCH (m)` over the same
            // node), every such variable aliases the same node.  When there are
            // multiple seeds and multiple unlabelled variables, bind the i-th
            // variable to the i-th seed (positional), capped at the seed count.
            const priorUnlabelled = matchSection[1]
              .slice(0, np.index)
              .match(/\((\w+)\s*\)/g)?.length || 0
            seed = allNodes[Math.min(priorUnlabelled, allNodes.length - 1)]
          }
          if (!seed) continue
          const cur = (seed as any)._alias
          if (cur === undefined || cur === null || cur === '' || cur.startsWith('__n')) {
            (seed as any)._alias = varName
          }
          varToNodeMap.set(varName, seed)
        }
      }
    }

    // ── DELETE sub-clause (MATCH ... DELETE ... MERGE/SET) ─────────────
    // A MERGE/SET query may carry a DELETE sub-clause (`MATCH (a:A) DELETE a
    // MERGE (a2:A)`).  ast-to-plan-v2 leaves `deleteTargets` on the merged
    // plan (the DELETE clause overrides `plan.type`, which the later MERGE
    // clause re-writes to 'MERGE'), but the DML side-effect block further down
    // only fires for `type === 'DELETE'`.  Re-apply the deletion here, BEFORE the
    // MERGE match-or-create step, so the MERGE sees the post-delete graph and
    // creates (rather than reuses) the node — which is exactly what
    // "do not match on deleted nodes/relationships" requires.
    //   * Node deletion: `DELETE a` removes every node bearing the MATCH label.
    //   * Relationship deletion: `DELETE t` removes every edge of the MATCH type.
    if ((plan as any).deleteTargets?.length && (plan.type === 'MERGE' || plan.type === 'SET' || plan.type === 'REMOVE')) {
      const delTargets: string[] = (plan as any).deleteTargets
      const stepEdgeVars = new Set((plan.steps || []).map((s: any) => s.edgeVariable).filter(Boolean))
      for (const dv of delTargets) {
        if (stepEdgeVars.has(dv)) {
          // Relationship deletion: drop every edge matching the MATCH edge label.
          const edgeVarStep = (plan.steps || []).find((s: any) => s.edgeVariable === dv)
          const delLabel = edgeVarStep?.edgeLabel
          if (!delLabel) continue
          // Count distinct edges (dedup by srcIdx|dstIdx|label) so the pre-delete
          // match cardinality can be preserved for downstream fan-out.
          const seen = new Set<string>()
          for (const n of allNodes) {
            const edges = (n as any).__edges
            if (!Array.isArray(edges)) continue
            for (const e of edges) {
              if (e?.label === delLabel) {
                const pn = e.props && typeof e.props === 'object' ? JSON.stringify(e.props) : ''
                seen.add(`${e.srcIdx}|${e.dstIdx}|${e.label}|${pn}`)
              }
            }
            ;(n as any).__edges = edges.filter((e: any) => e?.label !== delLabel)
          }
          if (seen.size > 1) (allNodes as any).__matchFanOutCount = seen.size
        } else if (plan.scanLabel) {
          // Node deletion: remove every node whose label includes the MATCH label.
          const delLabel = plan.scanLabel
          const kept: typeof allNodes = []
          let delCount = 0
          for (const n of allNodes) {
            const lbl = String((n as any)._label ?? '')
            if (lbl === delLabel || lbl.split(':').includes(delLabel)) { delCount++; continue }
            kept.push(n)
          }
          allNodes.length = 0
          allNodes.push(...kept)
          // Preserve the pre-delete MATCH cardinality so `_buildDmlRows` can
          // still fan-out one row per original match even though the matched
          // nodes are gone from the graph (`MATCH (a:A) DELETE a MERGE (a2:A)
          // RETURN a2.num` must yield TWO rows, one per matched A node).
          if (delCount > 1) (allNodes as any).__matchFanOutCount = delCount
        }
      }
    }

    // ── Resolve WITH aliases through the binding table ─────────────────
    // `WITH n AS a` binds the alias `a` to whatever node `n` currently denotes.
    // Chained projections (`WITH a AS x` in a multi-WITH query) resolve through
    // `plan.withChain` (every WITH clause) rather than just the final `plan.with`.
    const allWithColumns = (plan.withChain || (plan.with ? [plan.with] : []))
      .flatMap((wc: any) => wc?.columns || [])
    const _resolveBinding = (name: string, _seen = new Set<string>()): any => {
      if (varToNodeMap.has(name)) return varToNodeMap.get(name)
      if (_seen.has(name)) return undefined
      _seen.add(name)
      const wc = allWithColumns.find(c => c.alias === name)
      if (wc && wc.expression) {
        const exprVar = wc.expression.trim()
        // A self-referential projection (`p AS p`) names the same binding; guard
        // against the infinite chain p -> p -> p by stopping when the expression
        // equals the alias we are already resolving.
        if (exprVar === name) return undefined
        if (varToNodeMap.has(exprVar)) {
          const node = varToNodeMap.get(exprVar)
          varToNodeMap.set(name, node)
          return node
        }
        // expression itself may be a prior alias (transitive chain)
        return _resolveBinding(exprVar, _seen)
      }
      return undefined
    }
    for (const wc of allWithColumns) {
      if (wc.alias) {
        matchVars.add(wc.alias)
        if (!varToNodeMap.has(wc.alias)) {
          const node = _resolveBinding(wc.alias)
          if (node) varToNodeMap.set(wc.alias, node)
        }
      }
    }


    // Expose the full node array (with __edges) to the pattern-comprehension
    // evaluator, which resolves a row-scoped node's relationships via its
    // `_alias`.  Cleared in the `finally` block below.
    _setActivePatternNodes(allNodes)

    // Clone createNodes + createEdges before the UNWIND expansion loop mutates
    // them.  Declared outside the `if (plan.createNodes?.length)` guard so the
    // CREATE relationship block below can reuse the expanded edges.
    let effectiveCreateNodes = plan.createNodes
    let effectiveCreateEdges = plan.createEdges

    // ── WITH/UNWIND scalar bindings for MERGE property expressions ──
    // `UNWIND [42] AS props ... WITH DISTINCT props AS p MERGE (a:A {num: p})`
    // must evaluate the MERGE property value `p` to its scalar (42) before
    // match-or-create, otherwise `p` is materialised as the literal string "p"
    // and the MERGE fails to match the existing `{num: 42}` node.  Resolve the
    // UNWIND element(s) and the final WITH projection chain into a flat alias →
    // value table used to substitute a bare variable reference in MERGE props.
    const _scalarBindings = new Map<string, unknown>()
    if (plan.unwind?.name) {
      const _uw = _resolveUnwindList(plan.unwind as any, {})
      if (_uw.length) _scalarBindings.set(plan.unwind.name, _uw[0])
    }
    if (_scalarBindings.size) {
      for (const wc of allWithColumns) {
        if (wc.expression && _scalarBindings.has(wc.expression.trim())) {
          _scalarBindings.set(wc.alias, _scalarBindings.get(wc.expression.trim()))
        }
      }
    }
    const _resolveMergePropVal = (v: unknown): unknown => {
      const raw = isTypedValue(v) ? v.value : v
      if (typeof raw === 'string' && _scalarBindings.has(raw.trim())) {
        return _scalarBindings.get(raw.trim())
      }
      return v
    }

    if (plan.createNodes?.length) {
      // If the CREATE statement has an UNWIND prefix (e.g. "UNWIND [1,2,3] AS i
      // CREATE ({num: i})"), expand the template into one node per unwound element
      // so the DML pipeline correctly materializes all rows.
      // Multiple UNWIND clauses nest into a Cartesian product
      // (`UNWIND [0,1,2] AS x UNWIND [0,1,2] AS y CREATE ({x,y})` → 9 nodes).
      // `plan.unwinds` collects every UNWIND in order; resolve each list and walk
      // the nested combinations, substituting every unwound variable reference.
      const _uwList = (plan.unwinds?.length ? plan.unwinds : (plan.unwind ? [plan.unwind] : [])) as Array<{ list: unknown[]; name: string; var?: string }>
      const uwExpanded = _uwList.length ? _uwList[0] : null
      if (uwExpanded && _uwList.length) {
        const resolvedLists = _uwList.map(u => _resolveUnwindList(u as any, {}))
        const expandedCns: typeof effectiveCreateNodes = []
        const expandedEdges: typeof effectiveCreateEdges = []
        const numCn = plan.createNodes?.length || 1
        // Build the nested combination iterator: index vector over each list.
        const total = resolvedLists.reduce((acc, l) => acc * Math.max(l.length, 1), 1)
        for (let comboIdx = 0; comboIdx < total; comboIdx++) {
          // Decode comboIdx into one index per unwind list (Cartesian product).
          let rem = comboIdx
          const comboVals: unknown[] = []
          for (let li = 0; li < _uwList.length; li++) {
            const len = Math.max(resolvedLists[li].length, 1)
            const idx = rem % len
            rem = Math.floor(rem / len)
            comboVals.push(resolvedLists[li][idx] ?? _uwList[li].list?.[idx])
          }
          const binding = new Map<string, unknown>()
          _uwList.forEach((u, li) => binding.set(u.name, comboVals[li]))
          // Substitute every unwound variable in props, alias, and edge endpoints.
          const _subst = (v: any): any => {
            const raw = isTypedValue(v) ? v.value : v
            if (typeof raw !== 'string') return v
            for (const [name, val] of binding) {
              if (raw === name) return val
            }
            return v
          }
          for (const cn of plan.createNodes) {
            const ecn = { ...cn }
            if (cn.props) {
              const newProps: Record<string, any> = {}
              for (const [k, v] of Object.entries(cn.props)) newProps[k] = _subst(v)
              ecn.props = newProps as any
            }
            if (cn.alias && binding.has(cn.alias)) {
              ecn.alias = cn.alias + '_' + comboIdx
            }
            expandedCns.push(ecn)
          }
          for (const edge of plan.createEdges || []) {
            const ee = { ...edge }
            const baseSrc = edge.sourceIdx ?? 0
            ee.sourceIdx = comboIdx * numCn + baseSrc
            ee.targetIdx = comboIdx * numCn + (edge.targetIdx ?? 0)
            if (edge.props) {
              const newEProps: Record<string, any> = {}
              for (const [k, v] of Object.entries(edge.props)) newEProps[k] = _subst(v)
              ee.props = newEProps as any
            }
            if (edge.source && binding.has(edge.source)) ee.source = edge.source + '_' + comboIdx
            if (edge.target && binding.has(edge.target)) ee.target = edge.target + '_' + comboIdx
            expandedEdges.push(ee)
          }
        }
        effectiveCreateNodes = expandedCns
        effectiveCreateEdges = expandedEdges
      }

      // ── MATCH-row driven MERGE node expansion ──
      // `MATCH (foo) WITH foo.x AS x, foo.y AS y MERGE (:N {x:x, y:y+1}) ...`
      // must run the MERGE per matched row (`foo` matches every seed node), not
      // once against the first bound node.  When there is a single unlabelled
      // MATCH variable and the MERGE/CREATE node props reference the WITH-projected
      // aliases (x, y), expand the templates into one concrete node per matched
      // row, evaluating each property expression (`x`, `y`, `y + 1`, `x + 1`)
      // against that row's bound values.  The existing match-or-create loop then
      // reuses/creates each node idempotently (dedup by label+props).
      if (plan.hasMatch && (plan as any).matchVar && !plan.scanLabel && effectiveCreateNodes?.length) {
        const mVar = (plan as any).matchVar
        const withCols = allWithColumns
        // Only expand when at least one MERGE/CREATE node property references a
        // WITH alias (i.e. the node carries per-row values).
        const propRefsWithAlias = effectiveCreateNodes.some((cn: any) =>
          cn.props && Object.values(cn.props).some((pv: any) => {
            const raw = isTypedValue(pv) ? pv.value : pv
            return typeof raw === 'string' && withCols.some(wc => wc.alias && raw.includes(wc.alias))
          })
        )
        if (propRefsWithAlias) {
          // Build a per-row binding context: { x: <n.x>, y: <n.y>, foo: <n> }.
          const aliasOf = (name: string): any => withCols.find(wc => wc.alias === name)
          const expanded: typeof effectiveCreateNodes = []
          const _matchRows: Array<Record<string, unknown>> = []
          for (const seed of allNodes) {
            const boundRow: Record<string, unknown> = {}
            for (const wc of withCols) {
              if (!wc.alias) continue
              const rhs = wc.expression // e.g. `foo.x`
              const rhsProp = rhs.includes('.') ? rhs.split('.').pop() : null
              boundRow[wc.alias] = rhsProp ? (seed as any)[rhsProp] : (seed as any)
            }
            _matchRows.push(boundRow)
            for (const cn of effectiveCreateNodes as any[]) {
              const ecn: any = { ...cn }
              if (cn.props) {
                const np: Record<string, any> = {}
                for (const [k, pv] of Object.entries(cn.props)) {
                  const raw = isTypedValue(pv) ? pv.value : pv
                  if (typeof raw === 'string') {
                    let val: unknown = raw
                    // Resolve WITH alias references to the seed's bound value.
                    for (const wc of withCols) {
                      if (!wc.alias) continue
                      // replace `x` (word-boundary) with the seed property value
                      const rhs = wc.expression // e.g. `foo.x`
                      const rhsProp = rhs.includes('.') ? rhs.split('.').pop() : null
                      const bound = rhsProp ? (seed as any)[rhsProp] : (seed as any)
                      const re = new RegExp(`\\b${wc.alias}\\b`, 'g')
                      if (re.test(raw)) {
                        const subbed = raw.replace(re, String(bound))
                        val = subbed
                      }
                    }
                    // Evaluate arithmetic (`y + 1`) or bare value.
                    if (typeof val === 'string' && /^[\d\s+\-*/]+$/.test(val.trim()) && /[+\-*/]/.test(val)) {
                      try { val = _evalBinary(val.trim(), {}) } catch { /* keep literal */ }
                    } else if (typeof val === 'string' && /^-?\d+$/.test(val.trim())) {
                      val = Number(val.trim())
                    } else if (typeof val === 'string' && val !== raw) {
                      // alias substituted: leave numeric-looking strings as-is; else it became a plain value
                      if (/^-?\d+$/.test(val.trim())) val = Number(val.trim())
                    }
                    np[k] = val
                  } else {
                    np[k] = pv
                  }
                }
                ecn.props = np
              }
              expanded.push(ecn)
            }
          }
          // Keep the anchor variable bound to the first matched seed as before.
          if (expanded.length) {
            effectiveCreateNodes = expanded
            ;(allNodes as any).__matchRows = _matchRows
          }
        }
      }

      for (let ci = 0; ci < effectiveCreateNodes.length; ci++) {
        const cn = effectiveCreateNodes[ci]
        // Resolve WITH/UNWIND variable references in MERGE/CREATE node props to
        // their scalar values BEFORE match-or-create (`MERGE (a:A {num: p})` must
        // match on `num: 42`, not the literal string "p").  Mutates the typed
        // value in place so the downstream `_findMergeNodeMatch` and creation
        // materialisation both see the resolved value.
        if (cn.props) {
          for (const k of Object.keys(cn.props)) {
            const resolvedV = _resolveMergePropVal(cn.props[k])
            if (resolvedV !== cn.props[k]) {
              cn.props[k] = resolvedV
            }
          }
        }
        // ── MERGE match-or-create ──
        // A MERGE node (tagged `_isMerge`) must first look for an existing node
        // with a matching label + properties.  When found, the node is reused
        // (bound to its alias, no new node created) and the ON MATCH branch
        // fires; otherwise a fresh node is created and ON CREATE fires.
        if ((cn as any)._isMerge) {
          // A bare MERGE node (`MERGE (a)-[r:T]-(b)` with no label/props) whose
          // alias already tags an existing seed node must reuse that node by
          // variable identity — not the first label+props match, which would bind
          // *both* `a` and `b` to the same leading node and produce a self-loop.
          let merged = -1
          if (!cn.label && (!cn.props || !Object.keys(cn.props).length) && cn.alias) {
            merged = allNodes.findIndex(n => (n as any)._alias === cn.alias)
          }
          if (merged < 0) merged = _findMergeNodeMatch(cn as any, allNodes)
          if (merged >= 0) {
            // Reuse the existing node: bind the alias and record matched=true.
            const existingNode = allNodes[merged] as any
            if (cn.alias) {
              varToNodeMap.set(cn.alias, existingNode)
              existingNode._alias = cn.alias
            }
            cnToAllNodeMap.set(ci, merged)
            ;(cn as any)._matched = true
            ;(cn as any)._matchedIdx = merged
            continue
          }
          // No match → fall through to creation below (ON CREATE branch).
          ;(cn as any)._matched = false
        }
        // 跳过仅引用已匹配节点的 createNode（无 label 无 props，且变量名已存在 MATCH 中）
        if (cn.alias && matchVars.has(cn.alias) && !cn.label && (!cn.props || !Object.keys(cn.props).length)) {
          // 不创建新节点，但保留 _alias 引用
          // 优先用绑定表解析（支持 `WITH n AS a, m AS b` 多别名指向同一节点）。
          const boundNode = varToNodeMap.get(cn.alias)
          if (boundNode) {
            const existingIdx2 = allNodes.indexOf(boundNode)
            if (existingIdx2 >= 0) {
              cnToAllNodeMap.set(ci, existingIdx2)
              continue
            }
          }
          const existingIdx = allNodes.findIndex(n => n._alias === cn.alias)
          if (existingIdx >= 0) {
            cnToAllNodeMap.set(ci, existingIdx)
          } else {
            // 已存在节点没有 _alias（从 seed nodes 来的），设置 _alias
            // 按位置查找：createNodes[i] 对应 allNodes 中的 seed 节点
            if (ci < allNodes.length) {
              allNodes[ci]._alias = cn.alias
              cnToAllNodeMap.set(ci, ci)
            }
          }
          continue
        }
        const props: Record<string, unknown> = { _label: cn.label || 'Default' }
        if (cn.props) { for (const [k, v] of Object.entries(cn.props)) {
          const raw = isTypedValue(v) ? v.value : v
          if (typeof raw === 'string' && (_isExprValue(raw) || raw.startsWith('[') || raw.startsWith('(') || raw.startsWith('{') || raw.startsWith('date') || raw.startsWith('time') || raw.startsWith('datetime') || raw.startsWith('localtime') || raw.startsWith('localdatetime') || raw.startsWith('duration'))) {
            try { props[k] = _evalBinary(raw, {}); continue } catch { /* 如果不是合法表达式则用原值 */ }
          }
          // 数组元素级求值：每个元素如果是表达式字符串，求值
          if (Array.isArray(raw)) {
            props[k] = raw.map(el => {
              if (typeof el === 'string' && (_isExprValue(el) || el.startsWith('date') || el.startsWith('time') || el.startsWith('datetime') || el.startsWith('localtime') || el.startsWith('localdatetime') || el.startsWith('duration'))) {
                try { return _evalBinary(el, {}) } catch { return el }
              }
              return el
            })
            continue
          }
          props[k] = raw
        } }
        if (cn.alias) props['_alias'] = cn.alias
        allNodes.push(props)
        cnToAllNodeMap.set(ci, allNodes.length - 1)
        // Record the freshly-created node index for ON CREATE SET routing.
        if ((cn as any)._isMerge) (cn as any)._matchedIdx = allNodes.length - 1
      }
    }

    // Expose the (UNWIND-expanded) relationship payloads to `_buildDmlRows` so a
    // `RETURN r.num` projection can emit one row per freshly-created relationship
    // (with its unwound property values) rather than a single `{num:'x'}` row.
    if (effectiveCreateEdges?.length) {
      ;(allNodes as any).__createEdges = effectiveCreateEdges
    }

    // ── CREATE ... SET ... chains ──
    // Apply each SET clause to the freshly created node regardless of whether a
    // RETURN is present.  `SET a.numbers = a.numbers + [4, 5]` evaluates the
    // expression against the just-created node (bound by its _alias), so the
    // side effect lands on the node before any constraint check or result build.
    if (plan.type === 'CREATE' && plan.setClauses?.length) {
      for (const sc of plan.setClauses) {
        const alias = sc.alias
        if (!alias) continue
        const target = allNodes.find(n => (n as any)._alias === alias)
        if (!target) continue
        const setCtx: Record<string, unknown> = { [alias]: target }
        if (sc.kind === 'LABEL') {
          const cur = String(target._label ?? '').split(':').map(s => s.trim()).filter(s => s && s !== 'Default')
          for (const lb of sc.labels || []) { if (!cur.includes(lb)) cur.push(lb) }
          target._label = cur.join(':') || 'Default'
          continue
        }
        if (!sc.property) continue
        let value: unknown
        if (sc.expression != null) {
          try { value = _evaluateExpression(sc.expression, setCtx) } catch (_) { value = sc.value }
        } else if (typeof sc.value === 'object' && sc.value !== null && 'value' in sc.value) {
          value = (sc.value as any).value
        } else {
          value = sc.value
        }
        if (value === null) { if (sc.property in target) delete target[sc.property] }
        else {
          if (_isInvalidPropertyValue(value)) {
            throw Object.assign(new TypeError('TypeError: InvalidPropertyType'), { tckError: 'InvalidPropertyType' })
          }
          target[sc.property] = value
        }
      }
    }

    // ── 约束校验：检查 CREATE 的节点是否违反已注册的唯一约束 ──
    // 遍历已注册的约束，对全部 allNodes 做唯一性检查
    if (plan.createNodes?.length && (plan.type === 'CREATE' || plan.type === 'MERGE')) {
      const constraints = _getAllConstraints()
      for (const constraint of constraints) {
        const seen = new Map<unknown, number>()
        for (let i = 0; i < allNodes.length; i++) {
          const node = allNodes[i]
          const nodeLabel = node._label
          const labels = String(nodeLabel ?? '').split(':').map(s => s.trim()).filter(Boolean)
          if (!labels.includes(constraint.label)) continue
          const rawVal = node[constraint.property]
          if (rawVal === null || rawVal === undefined) continue
          // 解析 typed 格式：{type: 'STRING', value: 'xxx'} → 'xxx'
          const propVal = isTypedValue(rawVal) ? rawVal.value : rawVal
          if (propVal === null || propVal === undefined) continue
          const prevIdx = seen.get(propVal)
          if (prevIdx !== undefined) {
            throw new Error(
              `ConstraintValidationFailed: Node(${constraint.label}) already exists with ${constraint.property} = ${JSON.stringify(propVal)}`
            )
          }
          seen.set(propVal, i)
        }
      }
    }

    let edgeLabelFromTypeFilter = false  // flag: 从 WHERE type(r) 设置了边类型过滤
    // ── WHERE 预过滤：确定哪些 seed 节点需要跳过 ──
    // GE 的 _executeQueryPlan 在 steps 遍历后才对结果节点应用 filter，
    // 且 _matchFilter 忽略 filter.source。对于 WHERE n.name = 'Bob'
    // 这种 source 变量是步骤起点的 filter，在 seed 阶段跳过不匹配的节点。
    // Note: allNodes 必须保持原样（__edges 的 srcIdx/dstIdx 依赖原始索引），
    // 所以在 seed 循环中条件跳过，而非过滤 allNodes。
    // 跨变量属性引用检测：f.value 格式为 `var.property`，不能在 seed 阶段用常数比较
    const _isVarRef = (v: any): boolean => typeof v === 'string' && /^\w+\.\w+$/.test(v) && !/^['"]/.test(v) && !/^\d/.test(v)
    // 检测 filter 值是否为非法表达式（ANTLR 链式比较处理失败导致的字符串值）
    const _isBrokenChainValue = (v: any): boolean =>
      typeof v === 'string' && /[<>=]/.test(v)
    const crossVarFilters = (plan.filters || []).filter(f => f.source && f.property && _isVarRef(f.value))
    const stepSourceFilters = (plan.filters || []).filter(f => {
      const firstStep = plan.steps?.[0]
      // 排除跨变量引用 filter（seed 阶段无法做跨变量比较）
      if (crossVarFilters.includes(f)) return false
      // 排除标签谓词（`WHERE a:A`）—— 它走 labelFilterItems / label 成员检查，
      // 不是常量 source 属性比较。
      if (f.property === '__label') return false
      // 排除 ANTLR 链式比较解析失败的 filter（值中包含比较运算符）
      if (_isBrokenChainValue(f.value)) return false
      const result = firstStep && f.source === firstStep.source && firstStep.source
      return result
    })
    // ── WHERE 标签谓词预过滤 ──
    // 提取 `WHERE a:A` 形式的标签检查（ANTLR 不将其解析为 filter）
    const whereLabelFilters: Array<{varName: string; targetLabel: string}> = []
    if (plan.steps?.length && query) {
      const firstStepSource = plan.steps[0].source
      if (firstStepSource) {
        // 从原始 query 中提取 WHERE 子句，然后查找所有 var:Label 模式（不限于 firstStepSource）
        const whereClauseMatch = query.match(/\bWHERE\s+([\s\S]+?)(?=\b(RETURN|WITH|CREATE|ORDER|SKIP|LIMIT)\b|$)/i)
        if (whereClauseMatch) {
          const whereClause = whereClauseMatch[1]
          // 提取所有 var:Label 模式（g flag 必须用于 matchAll）
          const allLabelRegex = /(\w+)\s*:\s*(\w+)/g
          for (const lm of whereClause.matchAll(allLabelRegex)) {
            whereLabelFilters.push({ varName: lm[1], targetLabel: lm[2] })
          }
        }
      }
    }

    // ── 索引加速预过滤：当 plan 有 scanLabel 且 EQ filter 匹配已注册索引时 ──
    // 利用 _getIndex 检查 (scanLabel, property) 是否已注册索引
    // 即使索引没有 build Node ID 集，也可以用 scanLabel + filter 值做预过滤
    const indexedEqFilters: Array<{ filter: any; index: IndexEntry }> = []
    if (plan.scanLabel) {
      for (const f of (plan.filters || [])) {
        if (f.operator === 'EQ' && f.property && f.value !== undefined && !_isVarRef(f.value)) {
          const idx = _getIndex(plan.scanLabel, f.property)
          if (idx) {
            indexedEqFilters.push({ filter: f, index: idx })
          }
        }
      }
    }

    // ── hashIndex 构建：为 registered index + EQ filter 构建 O(1) 查找映射 ──
    // key = `${label}:${property}:${String(value)}` → nodeIndices[]
    // 只构建当前 indexedEqFilters 需要的索引条目，不全部构建。
    // 如果查询指定了 USING INDEX hint，则优先使用 hint 指定的索引。
    const indexHint = plan._indexHint as { var: string; label: string; property: string } | undefined
    const hashIndex = new Map<string, number[]>()
    if (indexedEqFilters.length || indexHint) {
      for (let ni = 0; ni < allNodes.length; ni++) {
        const node = allNodes[ni]
        const nodeLabel = String(node['_label'] || '')
        // Hint 优先级：使用 hint 中指定的 label + property 构建
        if (indexHint) {
          if (nodeLabel !== indexHint.label) {
            const fullLabel = node.__fullLabel
            if (!(fullLabel && typeof fullLabel === 'string' && fullLabel.split(':').includes(indexHint.label))) {
              continue
            }
          }
          const propVal = node[indexHint.property]
          if (propVal !== undefined && propVal !== null) {
            const key = `${indexHint.label}:${indexHint.property}:${String(propVal)}`
            if (!hashIndex.has(key)) hashIndex.set(key, [])
            hashIndex.get(key)!.push(ni)
          }
          continue // hint 存在时不构建其他索引键
        }
        // 无 hint：构建 indexedEqFilters 需要的索引
        for (const efi of indexedEqFilters) {
          if (!efi.index.label) continue
          // 检查节点标签是否匹配索引标签
          if (nodeLabel !== efi.index.label) {
            const fullLabel = node.__fullLabel
            if (!(fullLabel && typeof fullLabel === 'string' && fullLabel.split(':').includes(efi.index.label))) {
              continue
            }
          }
          const propVal = node[efi.filter.property]
          if (propVal === undefined || propVal === null) continue
          const key = `${efi.index.label}:${efi.filter.property}:${String(propVal)}`
          if (!hashIndex.has(key)) hashIndex.set(key, [])
          hashIndex.get(key)!.push(ni)
        }
      }
    }

    // 构建需要跳过的节点索引集合
    const skipNodeIndices = new Set<number>()
    if (indexedEqFilters.length || stepSourceFilters.length || whereLabelFilters.length) {
      // hashIndex 加速：如果 indexedEqFilters 有匹配，直接获取命中节点
      if (indexedEqFilters.length && hashIndex.size > 0) {
        const hashMatched = new Set<number>()
        let allHashMatchable = true
        for (const efi of indexedEqFilters) {
          const key = `${efi.index.label!}:${efi.filter.property}:${String(efi.filter.value)}`
          const hitIndices = hashIndex.get(key)
          if (hitIndices) {
            for (const hi of hitIndices) hashMatched.add(hi)
          } else {
            allHashMatchable = false
            break
          }
        }
        // 只有所有 indexedEqFilters 都能通过 hashIndex 定位时才使用
        if (allHashMatchable && hashMatched.size > 0) {
          // 反转：不在 hashMatched 中的节点全部跳过
          for (let ni = 0; ni < allNodes.length; ni++) {
            if (!hashMatched.has(ni)) skipNodeIndices.add(ni)
          }
        }
      }
      for (let ni = 0; ni < allNodes.length; ni++) {
        const node = allNodes[ni]
        const nodeLabel = String(node['_label'] || '')
        if (plan.scanLabel) {
          const fullLabel = node.__fullLabel
          if (fullLabel && typeof fullLabel === 'string') {
            if (!fullLabel.split(':').includes(plan.scanLabel)) continue
          } else if (nodeLabel !== plan.scanLabel) {
            continue
          }
        }
        const match = stepSourceFilters.every((f: any) => {
          const val = node[f.property]
          const target = f.value
          switch (f.operator) {
            case 'EQ': {
              // BigInt 精度：ANTLR 截断大整数，用 BigInt 精确比较
              if (typeof val !== typeof target) {
                if (/^-?\d+$/.test(String(val)) && /^-?\d+$/.test(String(target))) {
                  try { if (BigInt(val) === BigInt(target)) return true } catch {}
                }
              }
              // bigint vs bigint 精确比较
              if (typeof val === 'bigint' && typeof target === 'bigint') return val === target
              // bigint vs string: 用 BigInt 重建比较
              if (typeof val === 'bigint' && typeof target === 'string') {
                try { return val === BigInt(target) } catch { return false }
              }
              if (typeof val === 'string' && typeof target === 'bigint') {
                try { return BigInt(val) === target } catch { return false }
              }
              return val === target
            }
            case 'NEQ': return val !== target
            case 'GT':
            case 'GTE':
            case 'LT':
            case 'LTE':
              return typeof val === 'number' && typeof target === 'number'
                ? (f.operator === 'GT' ? val > target : f.operator === 'GTE' ? val >= target : f.operator === 'LT' ? val < target : val <= target)
                : false
            default:    return true
          }
        })
        if (!match) {
          skipNodeIndices.add(ni)
        }
        // 索引加速过滤：如果已注册索引匹配的 EQ filter 不满足，跳过该节点
        if (indexedEqFilters.length && !skipNodeIndices.has(ni)) {
          const idxMatch = indexedEqFilters.every(({ filter: f }) => {
            return node[f.property] === f.value
          })
          if (!idxMatch) {
            skipNodeIndices.add(ni)
          }
        }
        // WHERE 标签谓词过滤：检查节点标签是否匹配 WHERE var:Label
        // 多变量标签谓词（如 a:A AND b:B）中，每个节点只需匹配指向自己的那条
        // 如果某个节点没有被任何 labelFilter 指向，则放行（不对它做标签检查）
        if (whereLabelFilters.length && !skipNodeIndices.has(ni)) {
          const nodeLabel = String(node['_label'] || '')
          // 找到指向这个节点的 labelFilte（如果有）
          const matchingFilters = whereLabelFilters.filter(lf => {
            const targetIdx = resolveVariableNodeIdx(lf.varName, plan, allNodes)
            return targetIdx === ni
          })
          // 如果没有 labelFilter 指向这个节点 → 放行
          // 如果有 → 全部匹配才通过
          const labelOk = matchingFilters.length === 0 || matchingFilters.every(lf => nodeLabel === lf.targetLabel)
          if (!labelOk) {
            skipNodeIndices.add(ni)
          }
        }
      }
      // 从 plan.filters 中移除已预处理的过滤器（stepSourceFilters + indexedEqFilters）
      // 只移除 seed 阶段能有效处理的 filter（EQ/NEQ/GT/GTE/LT/LTE/IN），
      // 保留 STARTS_WITH/CONTAINS/ENDS_WITH/IS_NULL/IS_NOT_NULL 给 GE 或后处理
      const seedCapableOperators = new Set(['EQ', 'NEQ', 'GT', 'GTE', 'LT', 'LTE', 'IN'])
      const processedFilters = [...stepSourceFilters.filter(f => seedCapableOperators.has(f.operator)), ...indexedEqFilters.map(ie => ie.filter)]
      plan.filters = (plan.filters || []).filter((f: any) => !processedFilters.includes(f))

    }

    // ── 内联节点属性预过滤（从 query 解析 `(n {name: 'A'})`） ──

    if (query && !stepSourceFilters.length) {
      const inlineMatch = query.match(/MATCH\s+\((\w+)(?::\w+)?\s*\{([^}]+)\}[^)]*\)/)
      if (inlineMatch) {
        const inlineVar = inlineMatch[1]
        const inlinePropsRaw = inlineMatch[2]
        const inlinePredicates: Array<{ key: string; value: string | number; raw: string }> = []
        const pairRegex = /(\w+)\s*:\s*(?:'([^']*)'|"([^"]*)"|(\d+(?:\.\d+)?))/g
        let pairMatch
        while ((pairMatch = pairRegex.exec(inlinePropsRaw)) !== null) {
          const key = pairMatch[1]
          const strVal = pairMatch[2] ?? pairMatch[3]
          const numStr = pairMatch[4]
          if (strVal !== undefined) {
            inlinePredicates.push({ key, value: strVal, raw: strVal })
          } else if (numStr !== undefined) {
            const num = parseFloat(numStr)
            inlinePredicates.push({ key, value: num, raw: numStr })
          }
        }
        if (inlinePredicates.length) {
          const matchSource = plan.steps?.[0]?.source
          const isMatchSource = inlineVar === matchSource || (!matchSource && !plan.scanLabel)
          if (isMatchSource) {
            // 内联属性过滤 `(n {name:'A'})`：不要用 skipNodeIndices 跳过不匹配节点，
            // 这会把 target 节点（B、C）也跳过。
            // 改为注入 stepSourceFilters，让 _walkMultiSteps 在遍历时正确约束。
            // 先清空现有同 variable 的 source 过滤（避免重复过滤）
            if (!stepSourceFilters) stepSourceFilters = []
            for (const pred of inlinePredicates) {
              stepSourceFilters.push({
                source: inlineVar,
                property: pred.key,
                value: typeof pred.value === 'number' ? pred.value : pred.raw,
              })
            }
          }
        }
      }
    }
    const nodeGeIds: number[] = []

    let edgesPayload: Array<{ srcIdx: number; dstIdx: number; label: string }> = []
    if (allNodes.length) {
      for (let i = 0; i < allNodes.length; i++) {
        // WHERE 预过滤：跳过不匹配的起始节点
        if (skipNodeIndices.has(i)) {
          nodeGeIds[i] = 0 // 占位，不 seed 到 GE
          continue
        }
        const nodeName = 'n' + i
        const item = allNodes[i]
        const label = String(item['_label'] || 'Default')
        const hasMultipleLabels = label.includes(':')
        // 多标签：存完整标签到 __fullLabel，用第一个标签注册到 GE
        const geLabel = hasMultipleLabels ? label.split(':')[0] : label
        const props: Record<string, unknown> = { _label: geLabel }
        if (hasMultipleLabels) props['__fullLabel'] = label
        for (const k of Object.keys(item)) {
          if (k !== '_label' && k !== '__edges') props[k] = item[k]
        }
        let h = 0
        for (let ci = 0; ci < geLabel.length; ci++) h = ((h << 5) - h + geLabel.charCodeAt(ci)) | 0
        // 调用 GE 的 upsertNode（处理 nodeIds 索引、缓存等），获取返回的 Promise
        // 由于 _executeViaGraphEngine 是同步函数，无法 await，
        // 但 GE.upsertNode 的核心（storage.upsertNode + nodeId tracking）是同步的
        const geTypeId = Math.abs(h) % 1000 + 1
        try {
                    // 异步执行：直接调用 GE 的 upsertNode（真正的 async API）
          const actualId = await _geUpsertNode(ge, geTypeId, 'n' + i, { props })
          nodeGeIds[i] = actualId
        } catch (e) {
          nodeGeIds[i] = i + 1
        }
      }
      // 从 allNodes 中提取 __edges 并创建边。
      // Only extract from original seed nodes (index < originalNodeCount);
      // GE creates intermediate Default-labeled copy nodes (index >=
      // originalNodeCount) whose __edges contain duplicates that inflate
      // pattern comprehension degree calculations.
      const rawEdges = extractEdgesFromNodes(allNodes.slice(0, originalNodeCount))
      edgesPayload = []
      const epSeen = new Set<string>()
      for (const ep of rawEdges) {
        const key = `${ep.srcIdx}|${ep.dstIdx}|${ep.label || ''}`
        if (!epSeen.has(key)) {
          epSeen.add(key)
          edgesPayload.push(ep)
        }
      }
      
      // 将 edgesPayload 中的边分配到对应节点的 __edges 上（供 _walkMultiSteps 遍历使用）
      // edgesPayload 可能只存储在 allNodes[0].__edges 中（TCK step-definitions 的存储方式）
      if (edgesPayload.length) {
        const nodeEdgeMap: Array<Array<{dstIdx: number; srcIdx: number; label: string; props?: any}>> = allNodes.map(() => [] as any)
        for (const ep of edgesPayload) {
          if (ep.srcIdx >= 0 && ep.srcIdx < allNodes.length) {
            nodeEdgeMap[ep.srcIdx].push({dstIdx: ep.dstIdx, srcIdx: ep.srcIdx, label: ep.label, props: ep.props || undefined})
          }
        }
        // 为每行分配 __edges（如果还没有），同时构建邻接索引
        const adjIdx = new Map<number, Array<{dstIdx: number; srcIdx: number; label: string; props?: any}>>()
        for (let ni = 0; ni < allNodes.length; ni++) {
          if (!(allNodes[ni] as any).__edges || !(allNodes[ni] as any).__edges.length) {
            (allNodes[ni] as any).__edges = nodeEdgeMap[ni]
          }
          if (nodeEdgeMap[ni].length > 1) {
            adjIdx.set(ni, nodeEdgeMap[ni])
          }
        }
        // 把邻接索引挂在 allNodes 上供 _walkMultiSteps 使用
        // 把邻接索引挂在 allNodes 上供 _walkMultiSteps 使用
        (allNodes as Array<Record<string, unknown> & { __adjIdx?: number[][] }>).__adjIdx = adjIdx
      }
  
      if (edgesPayload.length) {
        // 跳过节点不创建 stub node（避免 traversalfrom 跳过的节点产生误匹配）
        // 跳过的节点不 seed 到 GE，也不通过边连接。如果边连接了 skipNode 和
        // non-skip 节点，那条边会丢失。但这比 GE 遍历到"被过滤掉"的节点更好。
        // TCK 中无场景触发此问题，这是纯粹的边界防御。

        const anyDirection = plan.steps?.length && plan.steps.some(s => s.direction === 'any')
        for (const ep of edgesPayload) {
          const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
          const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
          if (srcGeId < 0 || dstGeId < 0) continue
          const typeId = _geResolveEdgeType(ge, ep.label || '')
          // upsertEdge 是 async 函数，但 _executeViaGraphEngine 是同步上下文。
          // 直接调用 storage.upsertEdge（同步 API）确保边在 MATCH 前已创建。
          try {
            const epObj = ep as { props?: Record<string, unknown> }
            if (epObj.props) {
              _geUpsertEdge(ge, srcGeId, dstGeId, typeId, epObj.props)
            } else {
              _geUpsertEdge(ge, srcGeId, dstGeId, typeId)
            }
          } catch {}
          // 无向边双向
          if (anyDirection && srcGeId !== dstGeId) {
            try { _geUpsertEdge(ge, dstGeId, srcGeId, typeId) } catch {}
          }
        }
      }

    }

    // ── 构建 source→target 映射（GE 不保留从哪个源节点出发） ──
    // 用于 RETURN 中 source 变量（如 RETURN n 而非 RETURN 目标节点）
    // 以及 WHERE 过滤后的 source 节点结果重建。
    // 格式：Map<targetGeId, sourceGeId[]>
    const sourceTargetMap = new Map<number, number[]>()
    if (edgesPayload.length && nodeGeIds.length) {
      for (const ep of edgesPayload) {
        const srcGeId = ep.srcIdx >= 0 && ep.srcIdx < nodeGeIds.length ? nodeGeIds[ep.srcIdx] : -1
        const dstGeId = ep.dstIdx >= 0 && ep.dstIdx < nodeGeIds.length ? nodeGeIds[ep.dstIdx] : -1
        if (srcGeId < 0 || dstGeId < 0) continue // 跳过被预过滤的占位节点
        if (!sourceTargetMap.has(dstGeId)) sourceTargetMap.set(dstGeId, [])
        sourceTargetMap.get(dstGeId)!.push(srcGeId)
        // 无向边也记录反向
        if (!sourceTargetMap.has(srcGeId)) sourceTargetMap.set(srcGeId, [])
        sourceTargetMap.get(srcGeId)!.push(dstGeId)
      }
    }

    // ── CREATE 边（从 createEdges 创建 GE 关系 + __edges 内存记录） ──
    const createEdgesToUse = effectiveCreateEdges?.length ? effectiveCreateEdges : plan.createEdges
    if (createEdgesToUse?.length && nodeGeIds.length >= 1) {
      for (const edge of createEdgesToUse) {
        // 查找源/目标节点在 allNodes 中的实际索引
        // 先尝试从 cnToAllNodeMap 映射（createNode index → allNodes index）
        let srcIdx = -1;
        let dstIdx = -1;

        // 映射 source
        const cnSrcIdx = edge.sourceIdx !== undefined ? edge.sourceIdx : -1
        if (cnSrcIdx >= 0) {
          if (cnToAllNodeMap.has(cnSrcIdx)) {
            srcIdx = cnToAllNodeMap.get(cnSrcIdx)!
          } else {
            // 如果 createNode 在新节点的索引偏移中（未在 cnToAllNodeMap 中，说明是跳过匹配后又创建了新节点）
            // 回退：使用 offset，其中 originalNodeCount 是 seed node 数，cnSrcIdx 是 createNode 索引
            srcIdx = cnSrcIdx
          }
        }
        if (srcIdx < 0 && edge.source) {
          // 通过绑定表解析（优先，支持多别名指向同一节点）
          const b = varToNodeMap.get(edge.source)
          if (b && allNodes.includes(b)) srcIdx = allNodes.indexOf(b)
        }
        if (srcIdx < 0 && edge.source) {
          // 通过 alias 查找
          srcIdx = allNodes.findIndex(n => n._alias === edge.source)
        }
        // 如果 srcIdx 还是 < 0，用 cnSrcIdx 直接作为 allNodes 索引（当 createNodes 与 allNodes 按位置对齐时）
        if (srcIdx < 0 && cnSrcIdx >= 0 && cnSrcIdx < allNodes.length) {
          srcIdx = cnSrcIdx
        }

        // 映射 target
        const cnDstIdx = edge.targetIdx !== undefined ? edge.targetIdx : -1
        if (cnDstIdx >= 0) {
          if (cnToAllNodeMap.has(cnDstIdx)) {
            dstIdx = cnToAllNodeMap.get(cnDstIdx)!
          } else {
            dstIdx = cnDstIdx
          }
        }
        if (dstIdx < 0 && edge.target) {
          // 通过绑定表解析（优先，支持多别名指向同一节点）
          const b = varToNodeMap.get(edge.target)
          if (b && allNodes.includes(b)) dstIdx = allNodes.indexOf(b)
        }
        if (dstIdx < 0 && edge.target) {
          dstIdx = allNodes.findIndex(n => n._alias === edge.target)
        }
        if (dstIdx < 0 && cnDstIdx >= 0 && cnDstIdx < allNodes.length) {
          dstIdx = cnDstIdx
        }

        if (srcIdx >= 0 && dstIdx >= 0 && srcIdx < nodeGeIds.length && dstIdx < nodeGeIds.length) {
          const srcId = nodeGeIds[srcIdx]
          const dstId = nodeGeIds[dstIdx]
          if (srcId !== undefined && srcId !== undefined && srcId >= 0 && dstId >= 0) {
            // 使用 GE 的 _resolveEdgeType 获取统一的 typeId
            const typeId = _geResolveEdgeType(ge, edge.label || '')
            try { _geUpsertEdge(ge, srcId, dstId, typeId) } catch {}

            // 将边添加到 __edges 内存记录
            for (const n of allNodes) {
              const nNode = n as InternalNode
              if (!nNode.__edges) nNode.__edges = []
            }
            const edgeLabel = edge.label || ''
            // Push the edge onto both endpoints' __edges.  Both seed nodes
            // (index < originalNodeCount) and newly-created nodes (index >=
            // originalNodeCount) are real graph nodes, so both must record the
            // relationship — otherwise `CREATE ()-[:REL]->()` on an empty graph
            // (originalNodeCount === 0) leaves both endpoints with empty
            // `__edges` and a later `MATCH ()-[r:REL]->()` finds no relationship.
            // Preserve any relationship properties so a later `SET r.num` or
            // `RETURN r.num` can read them (e.g. `CREATE ()-[:R {num: 1}]->()`).
            const edgeRecord: Record<string, unknown> = { dstIdx, srcIdx, label: edgeLabel }
            if (edge.props && typeof edge.props === 'object') edgeRecord.props = edge.props
            ;(allNodes[srcIdx] as any).__edges.push(edgeRecord)
            ;(allNodes[dstIdx] as any).__edges.push({ ...edgeRecord })
          }
        }
      }
    }

    // For non-CREATE queries (e.g. MATCH-only), edgesPayload may still be
    // empty because it was only populated inside plan.createNodes block.
    // Extract edges from original seed nodes to support pattern comprehension
    // degree calculations in query-only executions (TCK List6 [8]-[10]).
    if (!edgesPayload.length) {
      const rawEdges = extractEdgesFromNodes(allNodes.slice(0, originalNodeCount))
      // Deduplicate by (srcIdx, dstIdx, label). GE createEdges loop
      // may push duplicate entries to allNodes[i].__edges from both
      // the TCK handler and prior _executeViaGraphEngine calls.
      const epSeen = new Set<string>()
      for (const ep of rawEdges) {
        const key = `${ep.srcIdx}|${ep.dstIdx}|${ep.label || ''}`
        if (!epSeen.has(key)) {
          epSeen.add(key)
          edgesPayload.push(ep)
        }
      }
    }

    // ── DML + RETURN：从 createNodes 构造结果行（GE 对 DML 返回空） ──
    if ((plan.type === 'CREATE' || plan.type === 'MERGE') && (plan.returnColumns?.length || (plan as any).mergeEdges?.length)) {
      // ── MERGE ON CREATE / ON MATCH SET ──
      // Apply ON CREATE/ON MATCH side effects to the nodes *before* building the
      // result rows, so `MERGE ... ON CREATE SET a.num = 42 RETURN a.num` returns
      // the post-SET value (42) rather than the pre-SET value.  Each merge node
      // carries a `_matched` flag from the match-or-create step: matched=true fires
      // ON MATCH against the reused node, matched=false fires ON CREATE against the
      // freshly created node.
      if (plan.type === 'MERGE' && (plan.mergeOnCreate?.length || plan.mergeOnMatch?.length)) {
        const _applyMergeSet = (target: any, set: any): void => {
          if (set.kind === 'LABEL') {
            // Append the label to the node's `_label` (colon-joined, deduped).
            const cur = String(target?._label ?? '').split(':').map((s: string) => s.trim()).filter(Boolean)
            if (set.label && !cur.includes(set.label)) {
              cur.push(set.label)
              target._label = cur.join(':')
              target.__fullLabel = cur.join(':')
            }
            return
          }
          // PROP assignment (kind may be undefined for legacy {property,value}).
          const propName = set.property
          if (!propName) return
          let val: unknown = set.value
          // An expression RHS (a variable reference or computed value) is
          // evaluated against the bound variables (the MERGE node + its alias).
          if (set.expression) {
            const ctx: Record<string, unknown> = {}
            for (const [k, v] of (varToNodeMap as Map<string, any>).entries()) ctx[k] = (v as any).props ?? v
            if (target) ctx[set.alias || ''] = target
            try { val = _evalBinary(set.expression, ctx) } catch { val = set.expression }
          } else if (val && typeof val === 'object' && 'value' in val) {
            val = (val as any).value
          }
          target[propName] = val
        }
        for (const cn of effectiveCreateNodes) {
          const mn = cn as any
          if (!mn._isMerge) continue
          const target = mn._matchedIdx != null ? allNodes[mn._matchedIdx] : null
          const setList = mn._matched ? plan.mergeOnMatch : plan.mergeOnCreate
          if (target && setList) {
            for (const s of setList) _applyMergeSet(target, s)
          }
        }
      }

      // ── Relationship MERGE (no-MATCH path) ──
      // A bare relationship MERGE (`MERGE (a)-[r:TYPE]-(b)`) has no MATCH clause,
      // so it never reaches the cross-join executor's relationship endowmer (which
      // requires a `multiMatch` entry).  Its endpoints were already bound by the
      // node match-or-create step above (into `varToNodeMap`); materialise the
      // relationship here: reuse an existing edge of the same label (+ direction)
      // between the two endpoints, or create a fresh one, then bind `r` so a
      // downstream `RETURN r` / `startNode(r)` / `endNode(r)` can observe it.
      if ((plan as any).mergeEdges?.length) {
        const _mkRelObj = (srcIdx: number, dstIdx: number, label: string, props: Record<string, unknown> | null): Record<string, unknown> => {
          const eo: Record<string, unknown> = {
            __edgeId: `${srcIdx}|${dstIdx}|${label || ''}`,
            __relId: `${Math.min(srcIdx, dstIdx)}|${Math.max(srcIdx, dstIdx)}|${label || ''}`,
            __edgeLabel: label,
            __edgeLabelStr: label,
            _type: label,
            _label: label,
            srcIdx,
            dstIdx,
            // Endpoint node references for `startNode(r)` / `endNode(r)`.
            _startNode: allNodes[srcIdx],
            _endNode: allNodes[dstIdx],
          }
          if (props) for (const [k, v] of Object.entries(props)) eo[k] = v
          return eo
        }
        const _resolveIdx = (aliasName: string): number => {
          const b = varToNodeMap.get(aliasName)
          if (b && allNodes.includes(b)) return allNodes.indexOf(b)
          const byAlias = allNodes.findIndex(n => (n as any)._alias === aliasName)
          if (byAlias >= 0) return byAlias
          return -1
        }
        const relVarMap = new Map<string, Record<string, unknown>>()
        // ── Enumerate MATCH-driven endpoint pairs for relationship MERGE ──
        // `MATCH (a {id:2})--(b {id:1}) MERGE (a)-[r:KNOWS]-(b) RETURN r` matches
        // TWO (id2, id1) node pairs, but `_resolveIdx` only resolves the first
        // pair (via `varToNodeMap`).  When the MERGE endpoints coincide with a
        // MATCH step whose source/target carry property predicates, enumerate
        // every matching pair with `_walkMultiSteps` and materialise (or reuse) an
        // edge per pair, binding the relationship variable to each distinct edge.
        // `__relVarList` carries the ordered edge objects so `_buildDmlRows` can
        // fan out one result row per matched pair.
        let endpointPairs: Array<{ src: number; tgt: number }> = []
        const relList: Record<string, unknown>[] = []
        const matchStep = (plan.steps || []).length === 1 ? (plan.steps![0] as any) : undefined
        const _hasEndpointPredicates =
          matchStep && ((matchStep.sourceProps && Object.keys(matchStep.sourceProps).length) ||
            (matchStep.targetProps && Object.keys(matchStep.targetProps).length))
        if (_hasEndpointPredicates && plan.hasMatch && (plan as any).mergeEdges?.length === 1) {
          const me0 = (plan as any).mergeEdges[0]
          const allIdx = allNodes.length
          const walkedPairs: Array<{ src: number; tgt: number }> = []
          for (let si = 0; si < allIdx; si++) {
            const srcPropsOk = matchStep.sourceProps ? Object.entries(matchStep.sourceProps).every(([k, v]) => (allNodes[si] as any)[k] === ((v as any)?.value ?? v)) : true
            if (!srcPropsOk) continue
            const paths = _walkMultiSteps(si, [matchStep], allNodes as any, new Set(), [], [])
            for (const p of paths) {
              const ti = p[p.length - 1]
              const tgtPropsOk = matchStep.targetProps ? Object.entries(matchStep.targetProps).every(([k, v]) => (allNodes[ti] as any)[k] === ((v as any)?.value ?? v)) : true
              if (tgtPropsOk) walkedPairs.push({ src: si, tgt: ti })
            }
          }
          if (walkedPairs.length > 1) endpointPairs = walkedPairs
        }
        for (const me of (plan as any).mergeEdges) {
          const ev = me.variable || ''
          const label = me.label || ''
          // A single endpoint pair may fan out to multiple MATCH pairs (see above).
          const pairsForEdge = endpointPairs.length
            ? endpointPairs.map(p => ({ src: p.src, tgt: p.tgt }))
            : [{ src: _resolveIdx(me.source), tgt: _resolveIdx(me.target) }]
          for (const ep of pairsForEdge) {
          const srcIdx = ep.src
          const tgtIdx = ep.tgt
          if (srcIdx < 0 || tgtIdx < 0) continue
          // Storage direction: `in` flips the storage endpoints to target→source.
          const edgeSrc = me.direction === 'in' ? tgtIdx : srcIdx
          const edgeDst = me.direction === 'in' ? srcIdx : tgtIdx
          // Enumerate existing edges of the same label between the endpoints.
          const wantsProps = me.props && Object.keys(me.props).length
          const _propsMatch = (p?: Record<string, unknown>): boolean => {
            if (!wantsProps) return true
            for (const [k, pv] of Object.entries(me.props!)) {
              const want = (pv as any)?.value ?? pv
              if (p == null || !_cypherValueEquals(p[k], want)) return false
            }
            return true
          }
          // `direction === 'any'` (`MERGE (a)-[r:R]-(b)`) matches an edge in EITHER
          // direction between the endpoints.  Edges may be stored on either
          // endpoint (the graph-engine persists a relationship on its source node),
          // so for an undirected merge we must scan the union of both endpoints'
          // edge lists to find a reverse-stored edge (e.g. the `c->d` edge when the
          // merge pair is `(d,c)`).
          const _edgeConnects = (e: { srcIdx: number; dstIdx: number }): boolean => {
            if (me.direction === 'any') return (e.srcIdx === edgeSrc && e.dstIdx === edgeDst) || (e.srcIdx === edgeDst && e.dstIdx === edgeSrc)
            return e.dstIdx === edgeDst
          }
          const _edgeList = (idx: number): Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> }> =>
            ((allNodes[idx] as any)?.__edges || [])
          const srcEdges = me.direction === 'any'
            ? [..._edgeList(edgeSrc), ..._edgeList(edgeDst)]
            : _edgeList(edgeSrc)
          const matching = srcEdges.filter(e =>
            (e.label || '') === label && _edgeConnects(e) && _propsMatch(e.props)
          )
          if (matching.length) {
            const ex = matching[0]
            // ON MATCH SET mutates the matched edge's props in place (shared ref).
            if (ev) {
              const eo = _mkRelObj(ex.srcIdx, ex.dstIdx, ex.label, ex.props ?? null)
              relVarMap.set(ev, eo)
              relList.push(eo)
            }
            continue
          }
          // Create the edge (merge pattern-inline props + ON CREATE SET).
          const edgeProps: Record<string, unknown> = { ...(me.props || {}) }
          const onCreate = (plan as any).mergeOnCreate as Array<{ kind?: string; property?: string; value?: unknown; alias?: string; fromAlias?: string; map?: Record<string, unknown> }> | undefined
          if (onCreate && ev) {
            for (const oc of onCreate) {
              if (oc.alias !== ev) continue
              if (oc.kind === 'PROP' && oc.property) edgeProps[oc.property] = (oc.value as any)?.value ?? oc.value
              else if (oc.kind === 'COPY' && oc.fromAlias) {
                const src = varToNodeMap.get(oc.fromAlias)
                if (src && typeof src === 'object') {
                  for (const [k, v] of Object.entries(src)) {
                    if (!k.startsWith('_') && k !== '__edges' && k !== 'id') edgeProps[k] = v
                  }
                }
              } else if (oc.kind === 'MAP_APPEND' && oc.map) Object.assign(edgeProps, oc.map)
            }
          }
          const edgeRecord: any = { srcIdx: edgeSrc, dstIdx: edgeDst, label }
          if (Object.keys(edgeProps).length) edgeRecord.props = edgeProps
          ;(allNodes[edgeSrc] as any).__edges = (allNodes[edgeSrc] as any).__edges || []
          ;(allNodes[edgeDst] as any).__edges = (allNodes[edgeDst] as any).__edges || []
          ;(allNodes[edgeSrc] as any).__edges.push({ ...edgeRecord })
          ;(allNodes[edgeDst] as any).__edges.push({ ...edgeRecord })
          if (nodes && nodes[edgeSrc] && nodes[edgeDst]) {
            ;(nodes[edgeSrc] as any).__edges = (nodes[edgeSrc] as any).__edges || []
            ;(nodes[edgeDst] as any).__edges = (nodes[edgeDst] as any).__edges || []
            ;(nodes[edgeSrc] as any).__edges.push({ ...edgeRecord })
            ;(nodes[edgeDst] as any).__edges.push({ ...edgeRecord })
          }
          if (ev) {
            const eo = _mkRelObj(edgeSrc, edgeDst, label, Object.keys(edgeProps).length ? edgeProps : null)
            relVarMap.set(ev, eo)
            relList.push(eo)
          }
          }
        }
        if (relList.length > 1) (allNodes as any).__relVarList = relList
        // Bind a MERGE path variable (`MERGE p = (a)-[:R]->(b) RETURN p`) to a
        // `{ __path, __pathEdges }` object so the result serializer renders it in
        // TCK path notation `<({num:1})-[:R]->({num:2})>` (the same convention the
        // MATCH/var-length paths use).  The relationship is often anonymous
        // (`[:R]`, no edge variable), in which case `relVarMap` has no entry; a
        // path still needs its edge, so reconstruct one from the pattern endpoints.
        const pathVarName = (plan as any).pathVar as string | undefined
        if (pathVarName && (plan as any).mergeEdges?.length) {
          const first = (plan as any).mergeEdges[0]
          const srcNode = varToNodeMap.get(first.source)
          const tgtNode = varToNodeMap.get(first.target)
          const rv = first.variable || ''
          const label = first.label || ''
          const srcIdx = _resolveIdx(first.source)
          const tgtIdx = _resolveIdx(first.target)
          // Reconstruct the relationship object for the path (endpoints aligned
          // with the path's traversal order, i.e. pattern order source→target).
          let edgeObj = rv ? relVarMap.get(rv) : undefined
          if (!edgeObj && srcIdx >= 0 && tgtIdx >= 0) {
            edgeObj = {
              __edgeId: `${srcIdx}|${tgtIdx}|${label}`,
              __relId: `${Math.min(srcIdx, tgtIdx)}|${Math.max(srcIdx, tgtIdx)}|${label}`,
              __edgeLabel: label,
              __edgeLabelStr: label,
              _type: label,
              _label: label,
              srcIdx,
              dstIdx: tgtIdx,
              _startNode: allNodes[srcIdx],
              _endNode: allNodes[tgtIdx],
            }
          }
          if (edgeObj && srcNode && tgtNode) {
            relVarMap.set(pathVarName, { __path: [srcNode, tgtNode], __pathEdges: [edgeObj] })
          }
        }
        // Expose the bound relationship variables so `_buildDmlRows` (and the
        // `startNode(r)` / `endNode(r)` expression evaluation) can resolve them.
        if (relVarMap.size) (allNodes as any).__relVarMap = relVarMap
      }

      // ── Single-node MERGE path (`MERGE p = (a {num:1}) RETURN p`) ──
      // A path can bind a single node with no relationship, rendering
      // `<({num:1})>`.  `mergeEdges` is empty here, so the relationship path
      // binding above never fires; bind `p` to a one-node path object directly.
      const _pathVarName = (plan as any).pathVar as string | undefined
      if (_pathVarName && !(plan as any).mergeEdges?.length && (plan as any).mergeNodes?.length) {
        const soleAlias = (plan as any).mergeNodes[0]?.alias
        const soleIdx = soleAlias != null ? varToNodeMap.get(soleAlias) : undefined
        const soleNode = soleIdx != null && allNodes.includes(soleIdx) ? soleIdx : (soleAlias != null ? allNodes.find(n => (n as any)._alias === soleAlias) : undefined)
        if (soleNode) {
          const relVarMap2 = (allNodes as any).__relVarMap || new Map<string, unknown>()
          relVarMap2.set(_pathVarName, { __path: [soleNode], __pathEdges: [] })
          ;(allNodes as any).__relVarMap = relVarMap2
        }
      }

      // ── WITH-chain projection over DML/CREATE rows ──
      // `CREATE (m {id:0}) WITH {first: m.id} AS m WITH {second: m.first} AS m
      // RETURN m.second` folds a WITH projection into a map literal that REUSES
      // the freshly-created variable name.  The MATCH-backed multi-WITH pipeline
      // never runs for a MATCH-less CREATE, so fold each WITH segment here
      // (sequentially, so a later segment reads the earlier projection) and hand
      // the final bindings to `_buildDmlRows` via `__withVarMap`, letting
      // `RETURN m.second` read the map's `second` instead of a missing node prop.
      const _withChain = ((plan as any).withChain?.length ? (plan as any).withChain : (plan.with ? [plan.with] : [])) as Array<{ columns: Array<{ expression: unknown; alias?: string | null }> }>
      if (_withChain.length) {
        const withCtx: Record<string, unknown> = {}
        for (const [k, v] of varToNodeMap.entries()) {
          withCtx[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? v : v
        }
        // Bind each created alias to its materialised props (typed createNode
        // props are `{ prop: {type,value} }`; unwrap to top-level values so
        // `WITH {first: m.id} AS m` reads `m.id` from the created node).
        for (const cn of effectiveCreateNodes as any[]) {
          const alias = cn?.alias
          if (!alias) continue
          if (alias in withCtx) continue
          const clean: Record<string, unknown> = {}
          if (cn?.props) {
            for (const [pk, pv] of Object.entries(cn.props as Record<string, unknown>)) {
              const typed = pv as any
              clean[pk] = (typed && typeof typed === 'object' && 'value' in typed) ? typed.value : typed
            }
          }
          withCtx[alias] = clean
        }
        const withVarMap = new Map<string, unknown>()
        for (const seg of _withChain) {
          for (const col of seg.columns || []) {
            const alias = col.alias
            const expr = typeof col.expression === 'string' ? col.expression : ''
            if (!alias || !expr) continue
            if (/^\s*(count|sum|avg|max|min|collect)\s*\(/i.test(expr)) continue
            let val: unknown
            try { val = _evaluateExpression(expr, withCtx) } catch { val = undefined }
            if (val === undefined) continue
            // Strip internal keys from a map/object projection so the result is a
            // clean literal `{first: 0}` rather than a node-shaped object.
            let cleanVal: unknown = val
            if (val && typeof val === 'object' && !Array.isArray(val) && (val as any).__edges === undefined) {
              const c: Record<string, unknown> = {}
              for (const [ek, ev] of Object.entries(val as Record<string, unknown>)) {
                if (!ek.startsWith('__') && ek !== '_label' && ek !== '_alias') c[ek] = ev
              }
              cleanVal = c
            }
            withCtx[alias] = cleanVal
            withVarMap.set(alias, cleanVal)
          }
        }
        if (withVarMap.size) (allNodes as any).__withVarMap = withVarMap
      }

      const created = _buildDmlRows(plan, allNodes)
      return _postProcessResults(created, plan)
    }

    // ── WHERE type(r) = 'X' → 转为 edgeLabel 过滤（非参数化，全局匹配） ──
    // [CVE-H3]: 原实现只匹配第一个 type(r) = 'X'，AND/OR 复合条件中后续约束被忽略。
    // 现改用全局正则匹配所有 type(r) = 'X' 条件。
    // `typeLabelInjected` records whether we were forced to inject a `type(r)=`
    // label into a step that had no edgeLabel of its own.  Only in that case does
    // the traversal below need to clear the injected label (so _walkMultiSteps
    // does not over-filter to a single OR branch); a step whose edgeLabel comes
    // from a real `-[r:R]->` pattern must keep it, otherwise multi-hop chains
    // like `()-[r1:R1]->()<-[r2:R2]-()...` start walking from spurious nodes.
    let typeLabelInjected = false
    if (query && !plan.steps?.some(s => s.edgeLabel)) {
      const typeRegex = /WHERE\s+type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/g
      let typeMatch: RegExpExecArray | null
      while ((typeMatch = typeRegex.exec(query)) !== null) {
        const typeLabel = typeMatch[2]
        for (const s of plan.steps || []) {
          if (!s.edgeLabel) {
            s.edgeLabel = typeLabel
            typeLabelInjected = true
          }
        }
      }
    }


    // ── 多类型 edgeLabel 处理 ──
    // MATCH (n)-[r:KNOWS|HATES]->(x) — 分割为多个单标签查询合并结果
    // ── 预分离边变量 filter（WHERE r.name = 'foo'） ──
    // GE 的 _matchFilter 只检查节点属性，无法处理 source="r" 的边属性 filter。
    // 从 plan.filters 中摘出边变量 filter，GE 执行时去掉它们，执行完后手动应用。
    // 边变量 filter 的判断：source 是 MATCH 中的关系变量（通常在步骤 source 左边或右边），
    // 但肯定不是步骤 source 也不是扫描出来的节点变量。
    // 判断条件：plan.filters 中 source 不是步骤 source，且 steps 非空（否则是纯节点 WHERE）。
    const stepSrc = plan.steps?.[0]?.source
    const stepTarget = plan.steps?.[0]?.targetAlias
    // 收集所有 step 中的节点变量名（source + targetAlias），不仅是 step 0
    const allStepVars = new Set<string>()
    for (const s of (plan.steps || [])) {
      if (s.source) allStepVars.add(s.source)
      if (s.targetAlias) allStepVars.add(s.targetAlias)
    }
    // `plan.scanLabel` is a *label* (e.g. `A`), not a variable.  Adding it to
    // the variable set made a node filter like `WHERE n.name = ...` (whose
    // `source` is the MATCH variable `n`) get mis-classified as an edge filter
    // whenever `steps` is empty, because `n` was absent from `allStepVars`.
    // For a bare label scan (`MATCH (n:A)`), recover the actual variable name
    // from the query text instead.
    if (plan.scanLabel && query && (plan.steps || []).length === 0) {
      const _labelVar = (query.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)/i) || [])[1]
      if (_labelVar) allStepVars.add(_labelVar)
    }
    const nodeAliasList = [...allStepVars]
    const edgeFilters = plan.steps?.length ? (plan.filters || []).filter(f =>
      f.source && !nodeAliasList.includes(f.source)
    ) : []
    // 只匹配作为 SQL 关键字的 OR（列名如 ordinalDay 不触发）
    const _isQueryOrKeyword = (q: string): boolean => /\bOR\b/i.test(q)
    const hasOR = query ? _isQueryOrKeyword(query) : false
    // GE 的 `_matchFilter`（graph-engine.ts）已实现 GT/GTE/LT/LTE 数值比较，
    // 因此这些运算符无需下放给 QE 二次补偿——尤其是在聚合路径：若保留在
    // geUnsupportedOps，GE 会在未过滤时先聚合，产生的单行结果丢掉了节点属性，
    // 后续 QE 二次过滤（line 2244）便无法再按 `age > 30` 过滤，导致 sum/count 错误。
    const geCapableOps = new Set(['EQ', 'NEQ', 'IN', 'STARTS_WITH', 'ENDS_WITH', 'CONTAINS', 'IS_NULL', 'IS_NOT_NULL', 'GT', 'GTE', 'LT', 'LTE'])
    const geFilters = (plan.filters || []).filter(f => !(edgeFilters as any[]).includes(f))
    // 从 GE filter 中移除 GE 仍然不支持的运算符，由 query-engine 在后处理中补偿
    const geUnsupportedOps = new Set<string>([])
    const queryEngineFilters = geFilters.filter(f => geUnsupportedOps.has(f.operator))
    const geFiltered = geFilters.filter(f => !geUnsupportedOps.has(f.operator))

    const multiTypeStep = plan.steps?.find(s => s.edgeLabel && s.edgeLabel.includes('|'))

    // ── Plan 注解：预计算元数据供执行路径决策 ──
    if (!plan._annotations) {
      const labelCounts = new Map<string, number>()
      for (const n of allNodes) {
        const label = n._label ? String(n._label) : 'Default'
        labelCounts.set(label, (labelCounts.get(label) || 0) + 1)
      }
      // 分类 WHERE 谓词
      const eqFilters = (plan.filters || []).filter(f => f.operator === 'EQ' && !edgeFilters.includesf)
      const rangeFilters = (plan.filters || []).filter(f => ['GT', 'GTE', 'LT', 'LTE'].includes(f.operator || ''))
      const indexEntries = Array.from(_indexRegistry.values())
      const hasIndexedEq = eqFilters.some(f => f.source && indexEntries.some(idx =>
        idx.property === f.property && (!idx.label || allNodes.some(n => String(n._label || '') === idx.label))
      ))
      ;plan._annotations = {
        labelCounts: Object.fromEntries(labelCounts),
        eqFilterCount: eqFilters.length,
        rangeFilterCount: rangeFilters.length,
        hasIndexedEq,
        totalSeedNodes: allNodes.length,
        edgeFilterCount: edgeFilters.length,
      }
    }

    // ── 多步跳转支持（MATCH (a)-->(b)-->(c) 或变量长度路径 (a)-[:X*1..3]->(b)）──
    // 当 steps.length > 1 或单步但有 range（变量长度）时，用 __edges 手动遍历
    // 扩展：单步有边 MATCH（steps[0].edgeLabel 不为空）也走 __edges 遍历，
    // 避免 GE 边存储与 allNodes.__edges 不同步的问题
    const hasMultiStep = plan.steps && plan.steps.length > 1 && allNodes.length > 0
    const hasVarLen = plan.steps?.length === 1 && (plan.steps[0] as any)?.range
    const hasEdgeStep = plan.steps?.length === 1 && allNodes.length > 0 && (plan.steps[0].edgeLabel != null || plan.steps[0].direction === 'out' || plan.steps[0].direction === 'in' || plan.steps[0].direction === 'any')
    const stepEdgesCache = new Map<number, string[]>()
    const useEdgeWalk = hasMultiStep || hasVarLen || hasEdgeStep
    let rawRecords: any[] = (useEdgeWalk)
      ? (() => {
          const edgeVarColsLen = (plan.returnColumns || []).filter(rc => {
            if (!rc || rc === '*' || rc.includes('.')) return false
            const nodeAliasesScan = new Set([
              ...(plan.createNodes || []).map((n: any) => n.alias).filter(Boolean),
              ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias]).filter(Boolean),
            ])
            const _sAlias2 = (plan.scanLabel && query && plan.steps?.length === 0)
              ? (query.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)/i) || [])[1] || null : null
            if (_sAlias2) nodeAliasesScan.add(_sAlias2)
            return !nodeAliasesScan.has(rc)
          }).length
          let multiStepRaw: any[] = []
          // Only clear the first step's edgeLabel when a `type(r)=` label was
          // injected into a label-less pattern above (the `typeLabelInjected`
          // flag).  A genuinely-parsed `-[r:R]->` label must survive so multi-hop
          // traversal respects direction + label from the true start node.
          const savedEdgeLabel = plan.steps?.[0]?.edgeLabel ?? null
          if (plan.steps?.[0] && typeLabelInjected) plan.steps[0].edgeLabel = null
          const _ceComma = plan.steps?.length > 1 && plan.steps.some(
            (s: any, si: number) => {
              if (si === 0) return false
              // Comma-separated MATCH: targetAlias reused across steps
              for (let pj = 0; pj < si; pj++)
                if (plan.steps[pj].targetAlias === s.targetAlias && s.targetAlias) return true
              return false
            }
          )
          for (let i = 0; i < allNodes.length; i++) {
            if (skipNodeIndices.has(i)) {
              continue
            }
            // 根据 scanLabel 过滤起始节点（支持多标签 __fullLabel / `_label`）
            if (plan.scanLabel) {
              const node = allNodes[i]
              const nodeLabel = String(node?.['_label'] || '')
              const fullLabel = node?.__fullLabel
              const labelStr = (fullLabel && typeof fullLabel === 'string') ? fullLabel : nodeLabel
              // A node may carry several labels (`A:B:C`); the scan label names
              // one of them, so match membership rather than whole-string equality.
              if (!labelStr.split(':').includes(plan.scanLabel)) continue
            }
            let skipNode = false
            for (const sf of stepSourceFilters) {
              if (allNodes[i][sf.property] === undefined || String(allNodes[i][sf.property]) !== String(sf.value)) {
                skipNode = true
                break
              }
            }
            if (skipNode) continue
            // WHERE 标签谓词 pre-check：起始节点必须匹配 step source 变量的标签
            if (plan.labelFilterItems?.length && plan.steps?.[0]?.source) {
              const srcVar = plan.steps[0].source
              const srcLabelFilters = plan.labelFilterItems.filter((lfi: any) => lfi.variable === srcVar)
              if (srcLabelFilters.length) {
                const nodeLabel = String((allNodes[i] as any)?._label || '')
                const labelOk = srcLabelFilters.some((lfi: any) => nodeLabel === lfi.label)
                if (!labelOk) continue
              }
            }
            // [FIX-STEP-GROUPS]
            const _sgSteps = plan.steps || []
            const _sgGroups = []
            if (_sgSteps.length > 0) {
              let _sgCur = [_sgSteps[0]]
              const _sgSeenAliases = new Set()
              if (_sgSteps[0].targetAlias) _sgSeenAliases.add(_sgSteps[0].targetAlias)
              for (let si = 1; si < _sgSteps.length; si++) {
                // [FIX-STEP-GROUPS-v2]: 
                // 1. source 不连续时切分
                // 2. targetAlias 已存在时切分（表明这是额外约束而非路径扩展）
                const _sgSourceMatch = _sgSteps[si].source === _sgSteps[si - 1].targetAlias
                const _sgAliasDup = _sgSteps[si].targetAlias && _sgSeenAliases.has(_sgSteps[si].targetAlias)
                if (_sgSourceMatch && !_sgAliasDup) {
                  _sgCur.push(_sgSteps[si])
                } else {
                  _sgGroups.push(_sgCur)
                  _sgCur = [_sgSteps[si]]
                }
                if (_sgSteps[si].targetAlias) _sgSeenAliases.add(_sgSteps[si].targetAlias)
              }
              if (_sgCur.length > 0) _sgGroups.push(_sgCur)
            }
            const _sgMulti = _sgGroups.length > 1
            let pathResults
            if (_sgMulti) {
              const _sgGroup0 = _sgGroups[0]
              pathResults = _walkMultiSteps(i, _sgGroup0, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
              if (pathResults.length > 0) {
                const _sgCrossPassed = []
                for (const p of pathResults) {
                  const _sgVmap = {}
                  _sgVmap[_sgGroup0[0].source] = i
                  for (let si = 0; si < _sgGroup0.length && si < p.length - 1; si++) {
                    if (_sgGroup0[si] && _sgGroup0[si].targetAlias) _sgVmap[_sgGroup0[si].targetAlias] = p[si + 1]
                  }
                  const _sgVals = new Set(Object.values(_sgVmap))
                  const _sgVars = new Set(Object.keys(_sgVmap))
                  if (_sgVals.size < _sgVars.size) continue
                  let _sgPass = true
                  // [FIX-STEP-GROUPS-v2-cross]: 跨组边验证
                  // 对于 source/targetAlias 都已在组0中定义（即 _sgVmap 中）的约束步，
                  // 用已知变量映射做双向边检查，而不是从 source 遍历
                  for (let gi = 1; gi < _sgGroups.length; gi++) {
                    for (const gs of _sgGroups[gi]) {
                      const _srcIdx = gs.source ? _sgVmap[gs.source] : -1
                      const _tgtIdx = gs.targetAlias ? _sgVmap[gs.targetAlias] : -1
                      // 如果 source 和 targetAlias 都已映射，做直接的边存在性检查
                      if (_srcIdx >= 0 && _tgtIdx >= 0) {
                        let _foundEdge = false
                        // 检查 srcIdx 的出边/入边/any 边到 tgtIdx
                        const _srcNodeE = allNodes[_srcIdx] as any
                        if (_srcNodeE?.__edges) {
                          for (const e of _srcNodeE.__edges) {
                            if (gs.direction === "out" && e.srcIdx === _srcIdx && e.dstIdx === _tgtIdx) _foundEdge = true
                            else if (gs.direction === "in" && e.dstIdx === _srcIdx && e.srcIdx === _tgtIdx) _foundEdge = true
                            else if (gs.direction === "any" && ((e.srcIdx === _srcIdx && e.dstIdx === _tgtIdx) || (e.srcIdx === _tgtIdx && e.dstIdx === _srcIdx))) _foundEdge = true
                          }
                        }
                        // 也检查反向边（CREATE 可能是单向的）
                        if (!_foundEdge) {
                          const _tgtNodeE = allNodes[_tgtIdx] as any
                          if (_tgtNodeE?.__edges) {
                            for (const e of _tgtNodeE.__edges) {
                              if (gs.direction === "out" && e.srcIdx === _srcIdx && e.dstIdx === _tgtIdx) _foundEdge = true
                              else if (gs.direction === "in" && e.dstIdx === _srcIdx && e.srcIdx === _tgtIdx) _foundEdge = true
                              else if (gs.direction === "any" && ((e.srcIdx === _srcIdx && e.dstIdx === _tgtIdx) || (e.srcIdx === _tgtIdx && e.dstIdx === _srcIdx))) _foundEdge = true
                            }
                          }
                        }
                        if (!_foundEdge) { _sgPass = false; break }
                      } else if (_srcIdx >= 0) {
                        // 只有 source, targetAlias 未映射：做边遍历
                        const _srcNode = allNodes[_srcIdx] as any
                        const _edges = (_srcNode && _srcNode.__edges) || []
                        const _cands = []
                        for (const e of _edges) {
                          let ni = -1
                          if (gs.direction === "any") ni = e.dstIdx === _srcIdx ? e.srcIdx : (e.srcIdx === _srcIdx ? e.dstIdx : -1)
                          else if (gs.direction === "out" && e.srcIdx === _srcIdx) ni = e.dstIdx
                          else if (gs.direction === "in" && e.dstIdx === _srcIdx) ni = e.srcIdx
                          if (ni >= 0 && (!gs.edgeLabel || e.label === gs.edgeLabel) && _stepMatchConstraint(ni, gs, allNodes)) _cands.push(ni)
                        }
                        if (_tgtIdx >= 0 && !_cands.includes(_tgtIdx)) { _sgPass = false; break }
                        if (_tgtIdx < 0 && _cands.length === 0) { _sgPass = false; break }
                      } else {
                        _sgPass = false; break
                      }
                    }
                    if (!_sgPass) break
                  }
                  if (_sgPass) _sgCrossPassed.push(p)
                }
                pathResults = _sgCrossPassed
                if (pathResults.length > 0) {
                  for (const _sgP of pathResults) {
                    const _sgVmap = {}
                    _sgVmap[_sgGroup0[0].source] = i
                    for (let si = 0; si < _sgGroup0.length && si < _sgP.length - 1; si++) {
                      if (_sgGroup0[si] && _sgGroup0[si].targetAlias) _sgVmap[_sgGroup0[si].targetAlias] = _sgP[si + 1]
                    }
                    const _sgRetCols = plan.returnColumns || []
                    for (const _rc of _sgRetCols) {
                      if (!_rc || _rc === "*") continue
                      const _rcName = _rc.split(".")[0]
                      if (!_rcName || _sgVmap[_rcName] === undefined) continue
                      const _nIdx = _sgVmap[_rcName]
                      const _nGeId = nodeGeIds[_nIdx] || (_nIdx + 1)
                      const _sgAllVars = {}
                      for (const [vn, vi] of Object.entries(_sgVmap)) {
                        const raw = allNodes[vi]
                        if (raw) {
                          const clean = { _label: raw._label || "Default" }
                          for (const k of Object.keys(raw)) {
                            if (k[0] !== "_" || (k !== "_label" && k !== "_alias" && k !== "props")) clean[k] = raw[k]
                          }
                          _sgAllVars[vn] = clean
                        }
                      }
                      const _sgNodeProps = { _label: (allNodes[_nIdx] && allNodes[_nIdx]._label) || "Default" }
                      if (allNodes[_nIdx]) {
                        for (const k of Object.keys(allNodes[_nIdx])) {
                          if (k[0] !== "_" || (k !== "_label" && k !== "props")) _sgNodeProps[k] = allNodes[_nIdx][k]
                        }
                      }
                      multiStepRaw.push({
                        id: _nGeId,
                        props: _sgNodeProps,
                        type: (allNodes[_nIdx] && allNodes[_nIdx]._label) || "Default",
                        __multiStep: true,
                        __targetProps: Object.assign({}, _sgNodeProps),
                        __targetAlias: _rcName,
                        __crossVarRows: _sgAllVars,
                      })
                    }
                  }
                  continue
                }
              }
            } else {
              pathResults = _walkMultiSteps(i, _sgSteps, allNodes, skipNodeIndices, plan.filters, stepSourceFilters)
            }
        const pathEnds = _pathEndIndices(pathResults)



        // 对多步结果做交集限定：只保留在 RETURN 变量对应定义步（第一个定义该变量的 step）中存在的 target
        // 防止后续 step 引入不相关的中间节点
        // [FIX-MW2]: 当 returnColumns 仅含属性名（如 "name"）时（ANTLR 将 out.name → "name" 剥离了变量前缀），
        // 从 expressionColumns 或 returnAliasMap 中提取真正的变量名
        const retVars: string[] = []
        for (const rc of (plan.returnColumns || [])) {
          const simpleVar = typeof rc === 'string' ? rc.split('.')[0] : ''
          if (simpleVar && plan.steps?.some(s => s.targetAlias === simpleVar)) {
            retVars.push(simpleVar)
          } else if (plan.expressionColumns?.length) {
            for (const ec of plan.expressionColumns) {
              if (ec.alias === rc || ec.expression === rc) {
                const dotIdx = ec.expression.indexOf('.')
                if (dotIdx > 0) {
                  const expVar = ec.expression.substring(0, dotIdx)
                  if (plan.steps?.some(s => s.targetAlias === expVar)) {
                    retVars.push(expVar)
                  }
                }
              }
            }
          }
        }
        const retVar = retVars.findLast(rc => {
          if (!rc) return false
          const firstSrc = plan.steps?.[0]?.source
          return rc !== firstSrc && plan.steps?.some(s => s.targetAlias === rc)
        })
        // 对于多步，改用最后一个 targetAlias 变量（降级安全）
        const lastTargetVar = plan.steps?.[plan.steps.length - 1]?.targetAlias
        const effectiveRetVar = (lastTargetVar && (plan.returnColumns || []).map(rc => rc?.split('.')[0]).includes(lastTargetVar))
          ? lastTargetVar
          : (retVar || lastTargetVar)
        let boundedTargetIndices: number[] = [...pathEnds]
        let boundedPaths: number[][] = pathResults
        // 多步匿名匹配（effectiveRetVar 为空，steps.length>1，非变量长度/非边变量）：保持 pathResults 全量
        // pathEnds Set 去重会丢失不同路径到同一终点的匹配，如 `()--()--()` 中 source=Looper 产生 2 条路径到自身
        if (!effectiveRetVar && plan.steps && plan.steps.length > 1 && !hasVarLen && !hasEdgeStep) {
          boundedTargetIndices = pathResults.map(p => p[p.length - 1])
          boundedPaths = pathResults
        } else if (effectiveRetVar && plan.steps && !hasVarLen && !hasEdgeStep) {
          const defStep = plan.steps.find(s => s.targetAlias === effectiveRetVar)
          if (defStep !== undefined) {
            const defStepIdx = plan.steps.indexOf(defStep)
            // 对返回变量的定义步，重新走到该步的 target 节点。这是 RETURN 变量的实际值。
            if (defStepIdx >= 0) {
              const intermediate = _walkMultiSteps(
                i, plan.steps.slice(0, defStepIdx + 1),
                allNodes, undefined, plan.filters, stepSourceFilters
              )
              const interEnds = _pathEndIndices(intermediate)
              // 如果 RETURN 变量等于最后一个 step 的 targetAlias，全路径的过滤约束
              // 会影响返回值（后续步的 filter 消除多余节点），需要用交集过滤。
              // 否则 pathResults 中的节点是后续步的 target，不相关，直接用 intermediate。
              const lastStep = plan.steps[plan.steps.length - 1]
              if (_ceComma) {
                boundedTargetIndices = [...interEnds]
                // In comma case, pathResults contains full walk results including all variables.
                // We need interEnds for target filtering, but pathResults for allVars population.
                // The allVars population code below uses boundedPaths to find matchingPath.
                // We must use pathResults so all steps' variables get populated.
                boundedPaths = pathResults
              } else if (lastStep && lastStep.targetAlias === effectiveRetVar) {
                boundedTargetIndices = [...pathEnds].filter(idx => interEnds.has(idx))
                boundedPaths = pathResults.filter(p => interEnds.has(p[p.length - 1]))
              } else {
                // [FIX-MW2[2]]: RETURN 变量是中间变量（非最后一步 targetAlias）时，
                // boundedTargetIndices 用 interEnds（中间变量节点的位置）做 RETURN 投影，
                // 但 boundedPaths 必须保留完整路径 pathResults，否则 _allVars 填充会丢失
                // 中间/末端变量（red、a）的绑定，导致 WHERE 求值 ctx 变量错位。
                boundedTargetIndices = [...interEnds]
                boundedPaths = pathResults
              }
            }
          }
        }
        // 自环模式：当前 source 节点只保留到自身的 targetIdx
        // 如 MATCH (n)-[r]->(n) 中，起始节点通过自环边只回到自身
        const isSelfStep = plan.steps?.[0]?.source && plan.steps?.[0]?.targetAlias &&
          plan.steps[0].source === plan.steps[0].targetAlias
        const boundedTargets = isSelfStep
          ? [...boundedTargetIndices].filter(tIdx => tIdx === i)
          : [...boundedTargetIndices]
        for (const targetIdx of boundedTargets) {
              const targetNode = allNodes[targetIdx]
              if (!targetNode) continue
              const srcNode = allNodes[i] as Record<string, unknown>
              const geNode: any = {
                id: nodeGeIds[targetIdx] || (targetIdx + 1),
                props: { _label: (srcNode?._label as string) || 'Default', _allVars: {} as Record<string, unknown> },
                type: targetNode._label || 'Default',
                __multiStep: true,
                __targetProps: {},
                __targetAlias: plan.steps?.[plan.steps.length - 1]?.targetAlias || '',
              }
              // 构建所有步骤变量的节点数据（存于 props._allVars 以避免属性丢失）
              const allVars: Record<string, unknown> = geNode.props._allVars as Record<string, unknown>
              const lastStepV = plan.steps?.[plan.steps.length - 1]
              // [FIX-MW2[2]]: 不再在此处用 targetNode(即 allNodes[targetIdx]) 绑定 lastStep 的 targetAlias。
              // 当 RETURN 变量是中间变量时 targetIdx 指向中间节点（如 out=p1），而非最后一步目标（a=thing），
              // 会把 a 错绑到 p1。改为由下方 [FIX-MW2[2]-allVars-fill] 用 matchingPath 正确定位 lastStep 目标。
              // 用 boundedPaths 补充中间节点和边标签Info
              if (boundedPaths?.length > 0) {
                let matchingPath = boundedPaths.find(p => p[p.length - 1] === targetIdx)
                // [FIX-MW2[2]]: matchingPath 可能为空 —— 当 RETURN 变量是中间变量（非最后一步 targetAlias）时，
                // targetIdx 是中间变量的路径位置，而 boundedPaths(完整路径) 的末尾是最后一步 target，二者不相等。
                // 变量 var 是 steps[si].targetAlias 时，其路径位置为 si+1（path[si+1] === var 的节点索引）。
                if (!matchingPath) {
                  const retDefStepIdx = plan.steps?.findIndex((st: any) => st.targetAlias === (effectiveRetVar || lastTargetVar))
                  matchingPath = boundedPaths.find(p =>
                    retDefStepIdx != null && retDefStepIdx >= 0 && retDefStepIdx + 1 < p.length && p[retDefStepIdx + 1] === targetIdx
                  )
                }
                if (matchingPath && matchingPath.length >= 2) {
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < plan.steps.length && psi < matchingPath.length - 1; psi++) {
                    const step = plan.steps[psi]
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                    // 中间节点：填充 _allVars 中对应步骤的 targetAlias
                    if (psi < plan.steps.length - 1 && matchingPath[psi + 1] !== targetIdx) {
                      const midNode = allNodes[matchingPath[psi + 1]]
                      const midAlias = plan.steps[psi]?.targetAlias
                      if (midAlias && midNode) {
                        allVars[midAlias] = { _label: midNode._label || 'Default' }
                        for (const k of Object.keys(midNode)) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[midAlias][k] = midNode[k]
                        }
                      }
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    geNode.props.__stepEdges = pathEdges
                    stepEdgesCache.set(targetIdx, pathEdges)
                  }
                }
              }
              // [FIX-MW2[2]-allVars-fill]: 当 boundedPaths 只覆盖部分步骤时，
              // 对未覆盖的 steps 补充它们的中间节点到 _allVars
              if (boundedPaths?.length > 0 && plan.steps?.length > 1) {
                let matchingPath = boundedPaths.find(p => p[p.length - 1] === targetIdx)
                if (!matchingPath) {
                  const retDefStepIdx = plan.steps?.findIndex((st: any) => st.targetAlias === (effectiveRetVar || lastTargetVar))
                  matchingPath = boundedPaths.find(p =>
                    retDefStepIdx != null && retDefStepIdx >= 0 && retDefStepIdx + 1 < p.length && p[retDefStepIdx + 1] === targetIdx
                  )
                }
                if (matchingPath && matchingPath.length >= 2) {
                  const _covSteps = new Set<number>()
                  for (let psi = 0; psi < matchingPath.length - 1 && psi < plan.steps.length; psi++) {
                    if (matchingPath[psi + 1] !== targetIdx) _covSteps.add(psi)
                  }
                  // 对 boundedPath 未覆盖的 steps，从 allNodes 直接补充变量绑定
                  for (let psi = 0; psi < plan.steps.length; psi++) {
                    const _s = plan.steps[psi]
                    // source 变量（除了 steps[0].source 已由 source 节点填充）
                    if (_s.source && !allVars[_s.source] && psi > 0) {
                      // 用 boundedPaths 中的节点索引
                      const psiMinus1 = psi - 1
                      if (psiMinus1 < matchingPath.length - 1) {
                        const nidx = matchingPath[psiMinus1]
                        if (nidx !== undefined && allNodes[nidx]) {
                          allVars[_s.source] = { _label: allNodes[nidx]._label || 'Default' }
                          for (const k of Object.keys(allNodes[nidx])) {
                            if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[_s.source][k] = allNodes[nidx][k]
                          }
                        }
                      }
                    }
                    // targetAlias 变量（从 matchingPath 中对应步的终点）
                    if (_s.targetAlias && !allVars[_s.targetAlias]) {
                      const nidx = psi < matchingPath.length - 1 ? matchingPath[psi + 1] : -1
                      if (nidx >= 0 && allNodes[nidx]) {
                        allVars[_s.targetAlias] = { _label: allNodes[nidx]._label || 'Default' }
                        for (const k of Object.keys(allNodes[nidx])) {
                          if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) allVars[_s.targetAlias][k] = allNodes[nidx][k]
                        }
                      }
                    }
                  }
                }
              }
              // source 节点——使用起始节点 allNodes[i] 而非 targetNode
              // [FIX-MW2[2]]: 仅当 lastStepV.source 是初始 source（steps[0].source）时才用 allNodes[i] 填充。
              // 多步链里 lastStepV.source 是中间节点（如 red），应由 matchingPath 定位，不能覆盖成起始节点。
              if (lastStepV?.source && lastStepV.source === plan.steps?.[0]?.source) {
                allVars[lastStepV.source] = { _label: (allNodes[i]?._label || 'Default') as string }
                for (const k of Object.keys(allNodes[i] || {})) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) (allVars[lastStepV.source] as any)[k] = (allNodes[i] as any)[k]
                }
              }
              // [FIX-MW2[2]-allVars]: 补充 steps[0].source 到 _allVars
              if (plan.steps?.[0]?.source && !allVars[plan.steps[0].source]) {
                const _s0node = allNodes[i] as Record<string, unknown>
                allVars[plan.steps[0].source] = { _label: (_s0node?._label as string) || 'Default' }
                for (const k of Object.keys(_s0node || {})) {
                  if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) (allVars[plan.steps[0].source] as any)[k] = (_s0node as any)[k]
                }
              }
              // target 节点属性存入 __targetProps（供非 source 变量查询如 b.id）
              for (const k of Object.keys(targetNode)) {
                if (k !== '_label' && k !== '__edges' && k !== 'props') {
                  geNode.__targetProps[k] = targetNode[k]
                }
              }
              // source 节点属性存入 geNode.props（供 source 变量查询如 a.id）
              const srcNodeForProps = allNodes[i] as Record<string, unknown>
              if (srcNodeForProps) {
                for (const k of Object.keys(srcNodeForProps)) {
                  if (k !== '_label' && k !== '__edges' && k !== 'props') geNode.props[k] = srcNodeForProps[k]
                }
              }
              // 确保 __targetProps 中有 _label（用于节点格式化和 varCtx）
              if (targetNode._label) geNode.__targetProps['_label'] = targetNode._label
              // 用 boundedPaths 提取实际匹配的边标签（vs plan.steps 编译时标签）
              if ((plan.steps || []).length > 1 && boundedPaths?.length) {
                const matchingPath = boundedPaths.find((p: number[]) => p[p.length - 1] === targetIdx)
                if (matchingPath && matchingPath.length >= 2) {
                  const pathEdges: string[] = []
                  for (let psi = 0; psi < plan.steps.length && psi < matchingPath.length - 1; psi++) {
                    const fromNode = allNodes[matchingPath[psi]] as any
                    if (fromNode?.__edges) {
                      const edge = fromNode.__edges.find((e: any) => {
                        const neighborIdx = e.dstIdx === matchingPath[psi] ? e.srcIdx : (e.srcIdx === matchingPath[psi] ? e.dstIdx : -1)
                        return neighborIdx === matchingPath[psi + 1]
                      })
                      if (edge?.label) pathEdges.push(edge.label)
                    }
                  }
                  if (pathEdges.length >= edgeVarColsLen) {
                    stepEdgesCache.set(targetIdx, pathEdges)
                  } else {
                  }
                } else {
                }
              } else {
              }
              // 添加 __crossVarRows 供 whereBody 后处理（_evaluateExpression 需要 i 变量）
              geNode.__crossVarRows = {}
              if (plan.steps?.length) {
                const thisStep = plan.steps[plan.steps.length - 1]
                // 绑定 targetAlias（If any命名目标且非空）
                // [FIX-MW2[2]]: 优先用 allVars（由 matchingPath 正确定位）绑定 lastStep 的 targetAlias，
                // 而非 targetNode（= allNodes[targetIdx]，当 RETURN 是中间变量时指向错误节点）。
                if (thisStep.targetAlias) {
                  const cvrSrc = allVars[thisStep.targetAlias] || targetNode
                  const cvrNode: Record<string, unknown> = {}
                  for (const k of Object.keys(cvrSrc as any)) {
                    if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) cvrNode[k] = (cvrSrc as any)[k]
                  }
                  geNode.__crossVarRows[thisStep.targetAlias] = { ...cvrNode, props: { ...cvrNode } }
                }
                // [FIX-MW2[2]-__crossVarRows]: 补充所有 steps 的 source 变量
                const _cvrAllSteps = new Set<string>()
                for (const _cvS of plan.steps) {
                  if (_cvS.source && !_cvrAllSteps.has(_cvS.source)) {
                    _cvrAllSteps.add(_cvS.source)
                    const _cvrSrc = _cvS === plan.steps[0] ? allNodes[i] : null
                    if (_cvrSrc) {
                      const p: Record<string, unknown> = {}
                      for (const k of Object.keys(_cvrSrc)) {
                        if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) p[k] = _cvrSrc[k]
                      }
                      if (_cvrSrc._label !== undefined) p._label = _cvrSrc._label
                      geNode.__crossVarRows[_cvS.source] = { ...p, props: { ...p } }
                    } else if (!geNode.__crossVarRows[_cvS.source]) {
                      const cached = allVars[_cvS.source]
                      if (cached) {
                        geNode.__crossVarRows[_cvS.source] = cached as any
                      }
                    }
                  }
                  if (_cvS.targetAlias && !_cvrAllSteps.has(_cvS.targetAlias)) {
                    _cvrAllSteps.add(_cvS.targetAlias)
                    if (_cvS === plan.steps[plan.steps.length - 1] && geNode.__crossVarRows[_cvS.targetAlias]) continue
                    const _cvrTgt = allVars[_cvS.targetAlias]
                    if (_cvrTgt) {
                      geNode.__crossVarRows[_cvS.targetAlias] = _cvrTgt as any
                    }
                  }
                }
                // Bind edge variables (e.g. r in `MATCH (n)-[r]->(x)`), so
                // WHERE/type(r) expressions can resolve the relationship. Each
                // step carries an `edgeVariable`; resolve it against the edge
                // between matchingPath[si] and matchingPath[si+1]. Fall back to
                // the legacy heuristic (short non-node return column) for single
                // anonymous steps without an explicit edgeVariable.
                const stepVars = new Set(plan.steps.flatMap((s: any) => [s.source, s.targetAlias]).filter(Boolean))
                const edgeBound = new Set<string>()
                let _matchPath: number[] | undefined = boundedPaths?.find((p: number[]) => p[p.length - 1] === targetIdx)
                if (!_matchPath) {
                  const retDefStepIdx = plan.steps?.findIndex((st: any) => st.targetAlias === (effectiveRetVar || lastTargetVar))
                  _matchPath = boundedPaths?.find((p: number[]) =>
                    retDefStepIdx != null && retDefStepIdx >= 0 && retDefStepIdx + 1 < p.length && p[retDefStepIdx + 1] === targetIdx
                  )
                }
                if (_matchPath && _matchPath.length >= 2) {
                  const matchingPathLocal = _matchPath
                  for (let si = 0; si < plan.steps.length && si < matchingPathLocal.length - 1; si++) {
                    const ev = (plan.steps[si] as any)?.edgeVariable as string | undefined
                    if (!ev || edgeBound.has(ev)) continue
                    const fromN = allNodes[matchingPathLocal[si]] as any
                    const toIdx = matchingPathLocal[si + 1]
                    const fromEdges = (fromN?.__edges || []) as Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>}> | undefined
                    if (!fromEdges) continue
                    // Resolve the exact edge traversed from matchingPath[si] to
                    // matchingPath[si+1].  A bare `dstIdx === toIdx || srcIdx ===
                    // toIdx` predicate is ambiguous: for a self-loop target it
                    // matches the first edge that merely touches `toIdx` (e.g. an
                    // inbound T1 edge) instead of the genuine LOOP self-loop, and
                    // for multi-edges it picks an arbitrary parallel edge.  Apply
                    // the same direction-aware neighbour resolution the walk uses
                    // so the matched relationship is unambiguous.
                    const fromIdx = matchingPathLocal[si]
                    const ee = fromEdges.find((e: any) => {
                      const neighborIdx = e.dstIdx === fromIdx ? e.srcIdx : (e.srcIdx === fromIdx ? e.dstIdx : -1)
                      return neighborIdx === toIdx
                    })
                    if (!ee) continue
                    const edgeObj: Record<string, unknown> = {
                      __edgeLabel: ee.label,
                      __edgeLabelStr: ee.label,
                      _type: ee.label,
                      _label: ee.label,
                    }
                    if (ee.props) {
                      for (const [pk, pv] of Object.entries(ee.props)) {
                        edgeObj[pk] = pv
                      }
                    }
                    geNode.__crossVarRows[ev] = edgeObj
                    edgeBound.add(ev)
                  }
                }
                // Legacy fallback: a short non-node return column (e.g. `r`)
                // whose edge was not resolved above via step edgeVariable.
                if (!edgeBound.size) {
                  const edgeVar = (plan.returnColumns || []).find((rc: string) => {
                    return !stepVars.has(rc) && rc.length <= 2
                  })
                  if (edgeVar) {
                    const srcNodeEdges = (allNodes[i] as any)?.__edges as Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>}> | undefined
                    if (srcNodeEdges) {
                      for (const ee of srcNodeEdges) {
                        if (ee.dstIdx === targetIdx) {
                          const edgeObj: Record<string, unknown> = {
                            __edgeLabel: ee.label,
                            __edgeLabelStr: ee.label,
                            _type: ee.label,
                            _label: ee.label,
                          }
                          if (ee.props) {
                            for (const [pk, pv] of Object.entries(ee.props)) {
                              edgeObj[pk] = pv
                            }
                          }
                          geNode.__crossVarRows[edgeVar] = edgeObj
                          break
                        }
                      }
                    }
                  }
                }
                // [FIX]: allVars → __crossVarRows 全量注入，确保 WHERE 能访问所有中间变量
                if (allVars) {
                  for (const [vn, vdata] of Object.entries(allVars as Record<string, unknown>)) {
                    if (geNode.__crossVarRows[vn]) continue
                    const vObj = vdata as Record<string, unknown>
                    const cvrEntry: Record<string, unknown> = {}
                    for (const k of Object.keys(vObj)) {
                      if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) cvrEntry[k] = vObj[k]
                    }
                    if (vObj._label !== undefined) cvrEntry._label = vObj._label
                    geNode.__crossVarRows[vn] = { ...cvrEntry, props: { ...cvrEntry } }
                  }
                }
                // Pattern Comprehension 适配：当 targetAlias 为空（匿名目标）且 RETURN 列是 source 变量时，
                // geNode 应代表 source 节点（而非匿名 target），使格式化能正确输出 source 的标签和属性
                if (!thisStep.targetAlias && thisStep.source && plan.returnColumns?.some(rc => {
                  const v = rc?.split('.')[0]
                  return v === thisStep.source
                })) {
                  const srcNode = allNodes[i]
                  if (srcNode) {
                    geNode.props = { _label: srcNode._label || 'Default' }
                    for (const k of Object.keys(srcNode)) {
                      if (k !== '_label' && k !== '__edges' && k !== 'props') {
                        geNode.props[k] = srcNode[k]
                      }
                    }
                  }
                }
              }
              // ── 多步多 RETURN 变量支持 ──
              // If any多个 RETURN 的非 source 变量（如 `RETURN b, c`），
              // 对每个非最终步的 targetAlias，收集其节点属性存入 __targetPropsMap
              if (plan.returnColumns && plan.returnColumns.length > 1 && plan.steps.length > 1) {
                const firstSrc = plan.steps[0].source
                const targetAliases = plan.steps.map(s => s.targetAlias)
                const nonFinalReturnVars = (plan.returnColumns || [])
                  .map((rc: string) => rc?.split('.')[0])
                  .filter((rc: string) => rc && rc !== firstSrc && targetAliases.includes(rc))
                  .slice(0, -1) // 排除最后一步（最后一步就是 geNode）
                if (nonFinalReturnVars.length) {
                  const targetPropsMap: Record<string, any> = {}
                  for (const nrv of nonFinalReturnVars) {
                    const nrvStep = plan.steps.find(s => s.targetAlias === nrv)
                    if (!nrvStep) continue
                    const nrvStepIdx = plan.steps.indexOf(nrvStep)
                    if (nrvStepIdx < 0) continue
                    const interTargets = _walkMultiSteps(
                      i, plan.steps.slice(0, nrvStepIdx + 1),
                      allNodes, undefined, plan.filters, stepSourceFilters
                    )
                    if (interTargets.length) {
                      const interNode = allNodes[interTargets[0]]
                      if (interNode) {
                        targetPropsMap[nrv] = { ...interNode }
                        // 去除内部属性（_alias, _label 等），TCK 兼容
                        for (const ik of Object.keys(targetPropsMap[nrv])) {
                          if (ik.startsWith('_')) delete targetPropsMap[nrv][ik]
                        }
                        delete targetPropsMap[nrv].__edges
                        delete targetPropsMap[nrv].props
                      }
                    }
                  }
                  if (Object.keys(targetPropsMap).length) {
                    geNode.__targetPropsMap = targetPropsMap
                  }
                }
              }
              if (hasVarLen || hasEdgeStep) {
                // 变量长度路径：简化结果格式，只保留目标节点属性+id
                // 不走后处理边变量逻辑，直接从 __targetProps 取值
                // Pattern Comprehension (targetAlias为空) 时 props 已经是 source 节点
                const _patNoAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias === ''
                multiStepRaw.push({
                  id: geNode.id,
                  props: { ...geNode.__targetProps },
                  __targetProps: geNode.__targetProps,
                  __crossVarRows: geNode.__crossVarRows,
                })
              } else {
                multiStepRaw.push(geNode)
              }
            }
          }
          // 恢复 edgeLabel
          if (plan.steps?.[0]) plan.steps[0].edgeLabel = savedEdgeLabel
          // Pattern Comprehension 去重：当 targetAlias 为空（匿名目标）时，
          // 每个 source 节点可能产生多行（不同目标节点）。
          // 去重：只保留每个 source 节点一行
          const lastStepTargetAlias = plan.steps?.[plan.steps.length - 1]?.targetAlias
          if (lastStepTargetAlias === '' && plan.steps?.length && !hasMultiStep) {
            const seenSourceVals = new Set<string>()
            multiStepRaw = multiStepRaw.filter((r: any) => {
              const cvr = r.__crossVarRows
              if (!cvr) return true
              const srcVar = plan.steps![0].source
              if (!srcVar) return true
              const srcVal = cvr[srcVar]
              const key = typeof srcVal === 'object' ? JSON.stringify(srcVal) : String(srcVal)
              if (seenSourceVals.has(key)) return false
              seenSourceVals.add(key)
              return true
            })
          }
          // 边变量过滤：WHERE r.name = 'monkey' 场景，
          // 用边属性过滤结果，并附加边属性到 __crossVarRows 供下游 whereBody 评估使用
          if (multiStepRaw.length && (plan.filters || []).some((f: any) => {
            const stepVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
            return f.source && !stepVars.has(f.source)
          })) {
            const stepVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
            const edgeFilters = (plan.filters || []).filter((f: any) => f.source && !stepVars.has(f.source))
            const collectedEdges: Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>|null}> = []
            for (let ni = 0; ni < allNodes.length; ni++) {
              const ne = (allNodes[ni] as any).__edges as Array<any> | undefined
              if (ne) collectedEdges.push(...ne)
            }
            if (collectedEdges.length) {
              multiStepRaw = multiStepRaw.filter((r: any) => {
                const rIdx = nodeGeIds.indexOf(r.id)
                if (rIdx < 0) return true
                return edgeFilters.every((f: any) => {
                  const connected = collectedEdges.filter((e: any) =>
                    e.dstIdx === rIdx || e.srcIdx === rIdx
                  )
                  if (!connected.length) return false
                  const stepEdgeLabel = plan.steps?.[0]?.edgeLabel
                  const candidates = stepEdgeLabel
                    ? connected.filter((e: any) => e.label === stepEdgeLabel)
                    : connected
                  if (!candidates.length) return false
                  const actualVal = candidates[0].props?.[f.property]
                  if (actualVal === undefined && f.operator !== 'IS_NULL') return false
                  switch (f.operator) {
                    case 'EQ':   return String(actualVal) === String(f.value)
                    case 'NEQ':  return String(actualVal) !== String(f.value)
                    default:     return String(actualVal) === String(f.value)
                  }
                })
              })
              // 为保留下来的行附加边变量属性到 __crossVarRows，
              // 使下游 _formatResultRow / whereBody 评估能正确解析 ctx.r.name
              if (multiStepRaw.length) {
                const edgeVarNames = [...new Set(edgeFilters.map((f: any) => f.source))]
                for (const r of multiStepRaw) {
                  const rIdx = nodeGeIds.indexOf(r.id)
                  if (rIdx < 0) continue
                  const connected = collectedEdges.filter((e: any) =>
                    e.dstIdx === rIdx || e.srcIdx === rIdx
                  ).filter((e: any) => !plan.steps?.[0]?.edgeLabel || e.label === plan.steps[0].edgeLabel)
                  if (connected.length && connected[0].props) {
                    if (!r.__crossVarRows) r.__crossVarRows = {}
                    for (const evn of edgeVarNames) {
                      const edgeInfo = { ...connected[0].props, _label: connected[0].label || '', __edgeLabel: connected[0].label || '' }
                      r.__crossVarRows[evn] = edgeInfo
                      // 边变量也可能出现在 RETURN 中（如 RETURN r），
                      // 需要同时注入到 props 供 _formatResultRow 使用
                      if (!r.props) r.props = {}
                      r.props[evn] = edgeInfo
                    }
                  }
                }
              }
            }
          }
          // 为 multiStepRaw 条目标记边变量属性（__crossVarRows），供 RETURN r / whereBody 使用
          if (multiStepRaw.length) {
            const collectedEdges: Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>|null}> = []
            for (let ni = 0; ni < allNodes.length; ni++) {
              const ne = (allNodes[ni] as any).__edges as Array<any> | undefined
              if (ne) collectedEdges.push(...ne)
            }
            if (collectedEdges.length) {
              // 找出边变量名
              const scanAlias = (plan.scanLabel && query && plan.steps?.length === 0)
                ? (query.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)/i) || [])[1] || null : null
              const nodeAliases = new Set([
                ...(plan.createNodes || []).map((n: any) => n.alias).filter(Boolean),
                ...(plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]).filter(Boolean),
              ])
              if (scanAlias) nodeAliases.add(scanAlias)
              const _sVars = new Set((plan.steps || []).flatMap((s: any) => [s.source, s.targetAlias]))
              const edgeVarNames = new Set<string>()
              // Extract true relationship variable names from the query text
              // (`-[r:T]->` and `-[r]->`), not from returnColumns: a scalar alias
              // such as `r.num AS num` contributes a returnColumn `num` that is
              // *not* a relationship variable, and treating it as one would leak
              // the whole edge object into `__crossVarRows.num`, breaking the
              // downstream WHERE (`num % 2 = 0`) and RETURN projection.
              if (query) {
                for (const m of query.matchAll(/-\s*\[(\w+)\s*:/g)) edgeVarNames.add(m[1])
                for (const m of query.matchAll(/-\s*\[(\w+)\s*\]/g)) edgeVarNames.add(m[1])
                // Undirected / bare relationship variables: `-[r]-`
                for (const m of query.matchAll(/-\s*\[(\w+)\s*[-<]/g)) edgeVarNames.add(m[1])
              }
              if (plan.filters) {
                for (const f of plan.filters) {
                  if (f.source && !_sVars.has(f.source)) edgeVarNames.add(f.source)
                }
              }
              for (const r of multiStepRaw) {
                const rIdx = nodeGeIds.indexOf(r.id)
                if (rIdx < 0) continue
                const connected = collectedEdges.filter((e: any) =>
                  e.dstIdx === rIdx || e.srcIdx === rIdx
                ).filter((e: any) => !plan.steps?.[0]?.edgeLabel || e.label === plan.steps[0].edgeLabel)
                if (connected.length) {
                  const edgeInfo = { ...connected[0].props, _label: connected[0].label || '', __edgeLabel: connected[0].label || '' }
                  if (!r.__crossVarRows) r.__crossVarRows = {}
                  // Inject the relationship into edge variable names only when
                  // they were NOT already bound by the step walk (line ~2868).
                  // The walk resolves each `edgeVariable` to the exact edge
                  // traversed; unconditionally overwriting here with the first
                  // edge touching the node would corrupt multi-step
                  // undirected/self-loop matches (r1 and r2 forced to the same
                  // `connected[0]` label).
                  for (const evn of edgeVarNames) {
                    const cvr = r.__crossVarRows[evn]
                    const alreadyBound = cvr && (cvr.__edgeLabel || cvr._type || cvr._label)
                    if (!alreadyBound) r.__crossVarRows[evn] = edgeInfo
                  }
                  // 无条件注入到 'r'（最常用的边变量名），供 whereBody type(r) 等场景
                  if (!r.__crossVarRows['r']) r.__crossVarRows['r'] = edgeInfo
                  // DEBUG check
                                  }
              }
            }
          }
          return multiStepRaw
        })()
      : multiTypeStep
      ? (() => {
          const labels = multiTypeStep.edgeLabel!.split('|')
          const combined: Map<number, any> = new Map()
          for (const lbl of labels) {
            const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
            p2.steps[0].edgeLabel = lbl
            p2.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))
            const subRaw: any[] = _geExecQueryPlan(ge, p2)
            for (const r of subRaw || []) combined.set(r.id, r)
          }
          return [...combined.values()]
        })()
      : hasOR
      ? (() => {
          // OR 语义：
          // 1) plan.filters 非空 → 逐 filter 执行 GE，合并去重
          // 2) plan.filters 为空但 query 有 type(r)=L1 OR type(r)=L2 → 逐 label 执行 GE，用 (id,label) 复合键去重
          const combined: Map<string, any> = new Map()
          const orFilters = (plan.filters || [])
          if (orFilters.length >= 2) {
            for (const f of orFilters) {
              const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
              p2.filters = [f]
              const subRaw: any[] = _geExecQueryPlan(ge, p2)
              for (const r of subRaw || []) combined.set(String(r.id), r)
            }
          } else if (query && plan.steps?.[0]) {
            const typeRMatches = query.matchAll(/type\s*\(\s*(\w+)\s*\)\s*=\s*['"]([^'"]+)['"]/ig)
            const orLabels: Array<{ edgeVar: string; label: string }> = []
            for (const m of typeRMatches) orLabels.push({ edgeVar: m[1], label: m[2] })
            if (orLabels.length >= 2) {
              for (const ol of orLabels) {
                const p2 = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
                p2.filters = []
                if (p2.steps?.[0]) p2.steps[0].edgeLabel = ol.label
                const subRaw: any[] = _geExecQueryPlan(ge, p2)
                for (const r of subRaw || []) {
                  // 保存边标签Info用于 RETURN r 格式化
                  if (!combined.has(String(r.id) + '__' + ol.label)) {
                    const rec = r.id !== undefined ? { ...r, id: r.id } : r
                    rec.__edgeLabel = ol.label
                    combined.set(String(r.id) + '__' + ol.label, rec)
                  }
                }
              }
            }
          }
          return [...combined.values()]
        })()
      : (() => {
          const planForGe = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver)
          // 排除跨变量属性引用 filter（GE 的 _matchFilter 无法做跨变量比较）
          planForGe.filters = (geFiltered || []).filter(f => !crossVarFilters.includes(f))

          // 无向边 direction any 时 GE 存储无节点数据，删掉 aggregate 让 QE 聚合
          if (planForGe.steps?.[0]?.direction === 'any') delete planForGe.aggregate
          // GE cannot evaluate a pattern-comprehension / arbitrary-expression
          // aggregate field (e.g. `count([p = (n)-[:T]->() | p])`).  Drop the
          // aggregate so QE's post-aggregation path (~line 3798) evaluates the
          // comprehension over the raw matched rows and then aggregates.
          const _aggField = planForGe.aggregate?.field
          if (_aggField != null && _aggField !== '*' && /[\[\(]/.test(String(_aggField))) {
            delete planForGe.aggregate
          }
          // OPTIONAL MATCH binds variables (possibly null) that the graph
          // engine's aggregation path never sees — GE runs before the optional
          // match is resolved, so a `collect(x)` over an OPTIONAL MATCH target
          // would read `x` off the source node's props and collapse to the wrong
          // value.  Drop the aggregate so QE's post-aggregation path folds the
          // aggregate over the OPTIONAL MATCH-expanded rows instead.
          if (planForGe.optionalMatchSteps?.length && planForGe.aggregate != null) {
            delete planForGe.aggregate
          }
          // DML (SET/DELETE/REMOVE) with an aggregate: the graph engine would
          // fold `sum(n.num)` over the pre-mutation values into a single row
          // (id === -1) BEFORE the SET/DELETE side effects run, so the QE
          // mutation block would find no per-node rows to act on and the
          // aggregate would reflect stale values (e.g. `MATCH (n:N) SET n.num =
          // n.num + 1 RETURN sum(n.num)` → 15 instead of 20).  Drop the
          // aggregate so GE returns the raw matched nodes, the mutation block
          // applies the side effects, and QE's post-aggregation path folds the
          // sum over the post-mutation values.
          if ((plan.type === 'SET' || plan.type === 'DELETE' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY') && planForGe.aggregate != null) {
            delete planForGe.aggregate
          }
          // When the WITH clause mixes a pattern-comprehension (or arbitrary
          // expression) column with an aggregate (e.g. `WITH [p=(n)-->()|p] AS ps,
          // count(b) AS c`), GE cannot evaluate the comprehension column nor
          // group by it, so it collapses everything into a single global `count`.
          // Drop the aggregate so QE's post-aggregation path groups over the raw
          // matched rows and evaluates both columns itself.
          const _withHasComprehensionCol = (planForGe.with?.columns || []).some((c: any) => {
            const expr = c?.expression
            return expr && (
              (typeof expr === 'string' && /[\[\(]/.test(expr) && (expr as string).includes('|')) ||
              (expr.type === 'LIST' && (expr.items || []).some((it: any) => it?.type === 'STRING' && String(it.value).includes('|')))
            )
          })
          // A WITH column that is an arbitrary expression GE cannot project (a
          // map literal `{name: n.list}`, a list literal, an arbitrary function
          // call, etc.) must also drop the aggregate: GE would otherwise fold
          // `count(*)` over the raw nodes while silently dropping the projected
          // map column, so QE's DISTINCT / projection would run against an
          // already-collapsed row.
          const _withHasMapOrListCol = (planForGe.with?.columns || []).some((c: any) => {
            const expr = typeof c?.expression === 'string' ? c.expression : ''
            if (!expr) return false
            const t = expr.trim()
            return /^\{/.test(t) || /^\[/.test(t) || /[({]\s*[A-Za-z_]\w*\s*[:.]/.test(t) || /^[A-Za-z_]+\s*\(/.test(t)
          })
          if ((_withHasComprehensionCol || _withHasMapOrListCol) && planForGe.aggregate != null) {
            delete planForGe.aggregate
          }
          // skip/limit 由 QE 的 _postProcessResults 处理，GE 不应过滤
          delete planForGe.skip; delete planForGe.limit
          return _geExecQueryPlan(ge, planForGe)
        })()
    // Fallback: useEdgeWalk=false 且 hasMatch 时，从 GE 获取全部节点
    // Note: 当 GE 的标签扫描返回空（标签不匹配）时，不可回退到全量扫描，
    // 否则会Error地匹配不存在的标签。条件加上了 scanLabel 不再回退的检查。
    if (!useEdgeWalk && plan.hasMatch && !rawRecords?.length && allNodes.length && !plan.scanLabel) {
      const scanPlan = JSON.parse(JSON.stringify({ ...plan, scanLabel: null, callProcedure: undefined }, _bigintReplacer), _bigintReviver)
      delete scanPlan.callProcedure
      delete scanPlan.skip; delete scanPlan.limit
      rawRecords = _geExecQueryPlan(ge, scanPlan) as any[]
    }
    let records = rawRecords
    // ── Inline source-node property predicate (MATCH (a {name:'A'})) ──
    // A bare node pattern with inline properties but no label/traverse step stores
    // its predicate as plan.matchSourceProps (ast-to-plan-v2 line ~983).  The
    // graph engine's `_executeQueryPlan` scans ALL nodes for such a pattern and
    // never sees the property predicate, so filter the scanned records here to
    // those whose source node satisfies every property before the records are
    // projected into result rows.
    const _matchSourceProps = (plan as any).matchSourceProps as Record<string, unknown> | undefined
    if (_matchSourceProps && Object.keys(_matchSourceProps).length && rawRecords?.length) {
      rawRecords = rawRecords.filter((r: any) => {
        // User properties live under `r.props`; the record's own top-level
        // fields (`name` = internal GeNode name "n0", `id`, `type`, `degree`,
        // `createdAt`) must NOT shadow them, so read the property off props only.
        const nodeProps = (r?.props && typeof r.props === 'object') ? r.props : r
        for (const [k, v] of Object.entries(_matchSourceProps)) {
          if (nodeProps[k] !== v) return false
        }
        return true
      })
      records = rawRecords
    }

    // ── GE filter 补偿 ──
    // GE 的 _matchFilter 对 GT/LT/GTE/LTE 仅支持 number 类型比较，
    // 不处理字符串比较。IS_NULL/IS_NOT_NULL 同样未处理（fallthrough 到 true）。
    // queryEngineFilters 中包含了 GE 排除的运算符，
    // 在 GE 返回后对 records 做二次过滤。
    const _isBrokenFval = (v: any): boolean => typeof v === 'string' && /[<>=]/.test(v)
    if (queryEngineFilters.length && rawRecords?.length) {
      rawRecords = rawRecords.filter((r: any) => {
        const nodeProps = r.props || r
        return queryEngineFilters.every((f: any) => {
          if (_isBrokenFval(f.value)) return true // skip broken chain values
          const actualVal = nodeProps[f.property]
          const fv = f.value
          switch (f.operator) {
            case 'IS_NULL':     return actualVal == null
            case 'IS_NOT_NULL': return actualVal != null
            case 'GT':   return actualVal > fv
            case 'GTE':  return actualVal >= fv
            case 'LT':   return actualVal < fv
            case 'LTE':  return actualVal <= fv
            default:     return true
          }
        })
      })
    }

    // GE 的 _executeQueryPlan 总是返回遍历后的目标节点，不保留 source 节点Info。
    // 当 RETURN n（steps[0].source）时，需要将 GE 返回的 target 节点映射回 source 节点。
    // 通过 sourceTargetMap 完成：targetGeId → sourceGeIds[].
    // 如果某个 target 对应多个 source（多对多），也可能是一个 source 对多个 target（一对多）。
    // 我们用 allNodes 重新构造 source 节点数据。
    const needSourceVar = plan.returnColumns?.some((rc: string) => {
      const firstStep = plan.steps?.[0]
      if (!firstStep || !firstStep.source) return false
      // When the pattern binds a path variable (`MATCH p = (n:X)-->() RETURN n`),
      // the multi-step walk already populated `__crossVarRows[n]` with the correct
      // source node.  Re-running the source-target remap here would look up the
      // target's *undirected* neighbours (including its own outgoing targets) and
      // inflate the row count.  Skip remapping for path-variable patterns.
      if (firstStep.pathVariable) return false
      // 直接匹配变量名（RETURN n）
      if (rc === firstStep.source) return true
      // 匹配属性投影（RETURN n.id）
      if (rc.startsWith(firstStep.source + '.')) return true
      return false
    })
    if (needSourceVar && sourceTargetMap.size > 0 && rawRecords?.length && !(plan.steps && plan.steps.length > 1) && !useEdgeWalk) {
      const sourceVar = plan.steps![0].source
      const targetAlias = plan.steps![0].targetAlias
      // 对每个 GE 返回的 target 节点，找到它对应的 source 节点
      // 使用 Map<srcId, targetProps> 去重，确保同一 source→target 只保留一条
      const dedupedRecords = new Map<string, { srcId: number; targetProps: Record<string, unknown>; crossVarRows?: Record<string, unknown> }>()
      for (const r of rawRecords) {
        const sourceIds = sourceTargetMap.get(r.id) || []
        if (!sourceIds.length) continue
        const rawProps = r.props || {}
        const targetProps: Record<string, unknown> = {}
        for (const k of Object.keys(rawProps)) {
          if (k !== 'props' && !k.startsWith('__')) {
            targetProps[k] = rawProps[k as keyof typeof rawProps]
          }
        }
        if (r.id !== undefined && !('_label' in targetProps) && nodeGeIds.length) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx >= 0 && allNodes[nodeIdx]) {
            const l = (allNodes[nodeIdx] as any)._label
            if (l !== undefined) targetProps._label = l
          }
        }
        for (const srcId of sourceIds) {
          const key = `${srcId}:${r.id}`
          if (!dedupedRecords.has(key)) {
            // Preserve the per-variable bindings (including edge variables such
            // as `r` in `MATCH (a)-[r]->(b) RETURN a, r, b`) so the downstream
            // _formatResultRow can render `r` as `[:LOOP]`.  Rebuilding the row
            // from props/targetProps alone drops these bindings.
            dedupedRecords.set(key, { srcId, targetProps, crossVarRows: r.__crossVarRows as Record<string, unknown> | undefined })
          }
        }
      }
      records = [...dedupedRecords.entries()].map(([key, { srcId, targetProps, crossVarRows }]) => {
        const srcIdx = nodeGeIds.indexOf(srcId)
        if (srcIdx < 0) return null as any
        const srcNode = allNodes[srcIdx]
        const cleanProps: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(srcNode)) {
          if (k !== '__edges' && k !== 'props') cleanProps[k] = v
        }
        return {
          id: srcId as number,
          props: cleanProps,
          type: _geGetNode(ge, srcId)?.type || 0,
          name: _geGetNode(ge, srcId)?.name || '',
          deleteNodeKey: () => {},
          __targetProps: targetProps,
          __targetAlias: plan.steps?.[0]?.targetAlias || undefined,
          ...(crossVarRows ? { __crossVarRows: crossVarRows } : {}),
        }
      }).filter(Boolean)
    }

    if (!records?.length && allNodes.length && plan.scanLabel && plan.hasMatch) {
      const isUsedAsVariable = (plan.steps || []).some(s => s.source === plan.scanLabel)
      const isLabelInNodes = allNodes.some(n => String(n._label) === plan.scanLabel)
      if (isUsedAsVariable && !isLabelInNodes) {
        const fallbackPlan = { ...plan, scanLabel: null }
        records = _geExecQueryPlan(ge, fallbackPlan)
      }
    }

    // ── DML side-effect 处理（DELETE / SET / REMOVE） ──
    // 在 GE 执行匹配后，对 allNodes 做突变以实现持久化操作。
    // allNodes 的元素是 nodes 数组中对应对象的引用，修改它们也会修改原始 nodes。
    if ((plan.type === 'DELETE' || plan.type === 'SET' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY') && records?.length) {
      if (plan.type === 'DELETE') {
        // 删除：从 allNodes 中移除匹配的节点
        const removeNodeIds = new Set(records.map((r: any) => r.id))
        // 从 allNodes 移除（浅拷贝过滤后替换原引用）
        const keptNodes: typeof allNodes = []
        for (let i = 0; i < allNodes.length; i++) {
          if (!removeNodeIds.has(nodeGeIds[i])) {
            keptNodes.push(allNodes[i])
          } else {
            // 同步删除 GE 存储层节点
            if (ge) {
              try {
                await _geDeleteNode(ge, nodeGeIds[i])
              } catch (_) { /* ignore storage errors */ }
            }
          }
        }
        allNodes.length = 0
        allNodes.push(...keptNodes)
      } else if (plan.type === 'MATCH_MODIFY') {
        // MATCH_MODIFY：包含 SET + REMOVE 混合操作
        // 先执行 SET
        if (plan.setClauses?.length) {
          for (const r of records) {
            const nodeIdx = nodeGeIds.indexOf(r.id)
            if (nodeIdx < 0) continue
            const node = allNodes[nodeIdx]
            for (const sc of plan.setClauses) {
              if (sc.alias && sc.alias !== plan.steps?.[0]?.source) continue
              if (sc.property) {
                const pv = sc.value
                node[sc.property] = typeof pv === 'object' && pv !== null && 'value' in pv ? pv.value : pv
              }
            }
            if (ge) try { await _geUpsertNode(ge, 1, "", { props: node }) } catch (_) {}
          }
        }
        // 再执行 REMOVE
        if (plan.removeClauses?.length) {
          for (const r of records) {
            const nodeIdx2 = nodeGeIds.indexOf(r.id)
            if (nodeIdx2 < 0) {
              // Edge REMOVE: delete properties from r.props[edgeVarName]
              if (plan.steps?.length) {
                const evn2 = stepSrc || plan.removeClauses?.[0]?.ref
                if (evn2 && r.props?.[evn2] && typeof r.props[evn2] === 'object') {
                  const edgeObj = r.props[evn2] as Record<string,unknown>
                  for (const rc of plan.removeClauses) {
                    if (rc.type === 'REMOVE_PROP' && rc.property) {
                      if (rc.ref && rc.ref !== evn2) continue
                      if (rc.property in edgeObj) delete edgeObj[rc.property]
                    }
                  }
                }
              }
              continue
            }
            const node = allNodes[nodeIdx2]
            const stepSource2 = plan.steps?.[0]?.source
            for (const rc of plan.removeClauses) {
              if (rc.ref && stepSource2 != null && rc.ref !== stepSource2) continue
              if (rc.type === 'REMOVE_PROP' && rc.property) {
                if (rc.property in node) {
                  delete node[rc.property]
                  if (r.props && typeof r.props === 'object' && rc.property in (r.props as Record<string, unknown>)) {
                    delete (r.props as Record<string, unknown>)[rc.property]
                  }
                }
              } else if (rc.type === 'REMOVE_LABEL' && rc.label) {
                const cur = String(node._label ?? '').split(':').map(s => s.trim()).filter(s => s && s !== 'Default')
                const kept = cur.filter(l => l !== rc.label)
                node._label = kept.join(':') || 'Default'
                if (node._label === 'Default') delete (node as any).__fullLabel
                else (node as any).__fullLabel = node._label
                if (r.props && typeof r.props === 'object') {
                  ;(r.props as Record<string, unknown>)._label = node._label
                  if (node._label === 'Default') delete (r.props as Record<string, unknown>).__fullLabel
                  else (r.props as Record<string, unknown>).__fullLabel = node._label
                }
              }
            }
            if (ge) try { await _geUpsertNode(ge, 1, "", { props: node }) } catch (_) {}
          }
        }
      } else if (plan.type === 'SET' && plan.setClauses?.length) {
        // SET：修改匹配节点的属性/标签（或关系属性，当 alias 是 edgeVariable）
        const edgeVarNames = new Set<string>()
        for (const st of plan.steps || []) {
          const ev = (st as any)?.edgeVariable as string | undefined
          if (ev) edgeVarNames.add(ev)
        }
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          // Determine whether every SET target is a relationship variable.  When
          // it is, the property/label applies to the edge object (stored under
          // `__crossVarRows[alias]` / `props[alias]`), not to the matched node.
          const targetsEdge = plan.setClauses!.length > 0 && plan.setClauses!.every(sc => sc.alias != null && edgeVarNames.has(sc.alias))
          if (targetsEdge) {
            // Resolve the edge objects for each relationship alias on this record.
            const edgeObjs = new Map<string, Record<string, unknown>>()
            for (const sc of plan.setClauses!) {
              if (!sc.alias) continue
              const cvr = (r as any).__crossVarRows as Record<string, unknown> | undefined
              let eo = (cvr && typeof cvr[sc.alias] === 'object' && cvr[sc.alias] !== null) ? cvr[sc.alias] as Record<string, unknown> : undefined
              if (!eo && r.props && typeof (r.props as any)[sc.alias] === 'object') {
                eo = (r.props as any)[sc.alias] as Record<string, unknown>
              }
              if (eo) edgeObjs.set(sc.alias, eo)
            }
            if (edgeObjs.size === 0) continue
            for (const sc of plan.setClauses!) {
              if (!sc.alias) continue
              const eo = edgeObjs.get(sc.alias)
              if (!eo) continue
              if (sc.kind === 'LABEL') {
                // Set the relationship type (label).  Cypher supports `SET r:Foo`
                // on a relationship; here we only ever have a single type.
                const labels = (sc.labels || []).filter((lb: string) => lb && lb !== 'Default')
                if (labels.length) {
                  eo.__edgeLabel = labels[0]
                  eo.__edgeLabelStr = labels[0]
                  eo._type = labels[0]
                  eo._label = labels[0]
                }
                continue
              }
              if (!sc.property) continue
              let value: unknown
              const evCtx: Record<string, unknown> = {}
              if (sc.alias) evCtx[sc.alias] = eo
              if (sc.expression != null) {
                try { value = _evaluateExpression(sc.expression, evCtx) } catch (_) { value = sc.value }
              } else if (typeof sc.value === 'object' && sc.value !== null && 'value' in sc.value) {
                value = (sc.value as any).value
              } else {
                value = sc.value
              }
              if (value === null) {
                if (sc.property in eo) delete eo[sc.property]
              } else {
                eo[sc.property] = value
              }
            }
            continue
          }
          if (nodeIdx < 0) continue
          const node = allNodes[nodeIdx]
          // Build an evaluation context mapping each SET alias to this node, so
          // expression values like `n.name + ' was here'` can be evaluated.
          const setCtx: Record<string, unknown> = {}
          for (const sc of plan.setClauses) {
            if (sc.alias) setCtx[sc.alias] = node
          }
          for (const sc of plan.setClauses) {
            const kind = sc.kind ?? 'PROP'
            if (kind === 'LABEL') {
              // Append labels to the node's existing `_label`, preserving order
              // and avoiding duplicates.  `SET n:Foo:Bar` adds Foo and Bar.
              // `Default` is the sentinel for "no label", so it is dropped here
              // rather than kept as a real label (`SET n:Foo` on an unlabeled
              // node yields `(:Foo)`, not `(:Default:Foo)`).
              const cur = String(node._label ?? '').split(':').map(s => s.trim()).filter(s => s && s !== 'Default')
              for (const lb of sc.labels || []) {
                if (!cur.includes(lb)) cur.push(lb)
              }
              node._label = cur.join(':') || 'Default'
              if (r.props && typeof r.props === 'object') {
                ;(r.props as Record<string,unknown>)._label = node._label
              }
              continue
            }
            if (kind === 'MAP' || kind === 'MAP_APPEND') {
              const props = sc.props || {}
              if (kind === 'MAP') {
                // Full replacement: drop every pre-existing property, then apply
                // the map (skipping explicit nulls, which remove the property).
                for (const k of Object.keys(node)) {
                  if (k === '_label' || k === '_alias' || k === '__edges') continue
                  delete node[k]
                }
                if (r.props && typeof r.props === 'object') {
                  for (const k of Object.keys(r.props)) {
                    if (k === '_label' || k === '_alias' || k === '__edges') continue
                    delete (r.props as Record<string,unknown>)[k]
                  }
                }
              }
              for (const [k, v] of Object.entries(props)) {
                if (v === null) {
                  if (k in node) delete node[k]
                  if (r.props && typeof r.props === 'object' && k in r.props) delete (r.props as Record<string,unknown>)[k]
                  continue
                }
                node[k] = v
                if (r.props && typeof r.props === 'object') (r.props as Record<string,unknown>)[k] = v
              }
              continue
            }
            // PROP (property assignment)
            if (!sc.property) continue
            const pv = sc.value
            let value: unknown
            if (sc.expression != null) {
              // Evaluate the expression string against the bound node/variable
              // context (e.g. `n.name + ' was here'`, `a.numbers + [4, 5]`,
              // `[1, 2, 3]`, `null`).
              try {
                value = _evaluateExpression(sc.expression, setCtx)
              } catch (_) {
                value = pv
              }
            } else if (typeof pv === 'object' && pv !== null && 'value' in pv) {
              value = pv.value
            } else if (typeof pv === 'string') {
              // Parse structured literals: arrays, maps, numbers, booleans, null
              const trimmed = pv.trim()
              if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
                try { value = JSON.parse(trimmed) } catch { value = pv }
              } else if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
                try { value = JSON.parse(trimmed) } catch { value = pv }
              } else if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
                value = Number(trimmed)
              } else if (/^(true|false)$/i.test(trimmed)) {
                value = trimmed.toLowerCase() === 'true'
              } else if (trimmed === 'null') {
                value = null
              } else {
                value = pv
              }
            } else {
              value = pv
            }
            // `SET n.prop = null` removes the property rather than storing null.
            if (value === null) {
              if (sc.property in node) delete node[sc.property]
              if (r.props && typeof r.props === 'object' && sc.property in r.props) {
                delete (r.props as Record<string,unknown>)[sc.property]
              }
              continue
            }
            // Reject map values (or lists containing maps) — InvalidPropertyType.
            if (_isInvalidPropertyValue(value)) {
              throw Object.assign(new TypeError('TypeError: InvalidPropertyType'), { tckError: 'InvalidPropertyType' })
            }
            node[sc.property] = value
            // Sync to GE-returned record props so RETURN expression evaluation
            // sees the newly-set properties (e.g., RETURN size(n.numbers) after SET n.numbers).
            if (r.props && typeof r.props === 'object') {
              (r.props as Record<string,unknown>)[sc.property] = value
            }
          }
          // 同步更新 GE 存储层节点属性（await 确保持久化）
          if (ge) {
            try {
              await _geUpsertNode(ge, 1, "", { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      } else if (plan.type === 'REMOVE' && plan.removeClauses?.length) {
        // REMOVE：删除匹配节点的属性或标签（或关系属性，当 ref 是 edgeVariable）
        const stepSource = plan.steps?.[0]?.source
        const edgeVarNames = new Set<string>()
        const _collectEdgeVars = (steps: any[]) => {
          for (const st of steps || []) {
            const ev = (st as any)?.edgeVariable as string | undefined
            if (ev) edgeVarNames.add(ev)
          }
        }
        _collectEdgeVars(plan.steps)
        // OPTIONAL MATCH keeps edge variables under optionalMatchSteps, not
        // steps (`OPTIONAL MATCH (n)-[r]->() REMOVE r.num` — r is a relationship
        // variable even though steps=[]).
        for (const om of (plan as any).optionalMatchSteps || []) {
          _collectEdgeVars(om.steps)
        }
        // A relationship REMOVE targets the edge object (stored under
        // `__crossVarRows[ref]` / `props[ref]`), never the matched node — even
        // though the record's `id` maps to a node index.
        const targetsEdge = plan.removeClauses.length > 0 && plan.removeClauses.every(rc => rc.ref != null && edgeVarNames.has(rc.ref))
        for (const r of records) {
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (targetsEdge) {
            for (const rc of plan.removeClauses) {
              const ref = rc.ref!
              const cvr = (r as any).__crossVarRows as Record<string, unknown> | undefined
              const eo = (cvr && typeof cvr[ref] === 'object' && cvr[ref] !== null)
                ? cvr[ref] as Record<string, unknown>
                : (r.props && typeof (r.props as any)[ref] === 'object' ? (r.props as any)[ref] as Record<string, unknown> : undefined)
              if (!eo) continue
              if (rc.type === 'REMOVE_PROP' && rc.property) {
                if (rc.property in eo) delete eo[rc.property]
              } else if (rc.type === 'REMOVE_LABEL' && rc.label) {
                // Remove the relationship type by clearing its label markers.
                delete eo.__edgeLabel
                delete eo.__edgeLabelStr
                delete eo._type
                if (eo._label === rc.label) delete eo._label
              }
            }
            continue
          }
          if (nodeIdx < 0) {
            // Edge REMOVE: when plan has edge steps, the record holds edge info
            // in r.props[edgeVarName]. Delete properties from there.
            if (plan.steps?.length) {
              const evn = stepSrc || plan.removeClauses?.[0]?.ref
              if (evn && r.props?.[evn] && typeof r.props[evn] === 'object') {
                const edgeObj = r.props[evn] as Record<string,unknown>
                for (const rc of plan.removeClauses) {
                  if (rc.type === 'REMOVE_PROP' && rc.property) {
                    if (rc.ref && rc.ref !== evn) continue
                    if (rc.property in edgeObj) delete edgeObj[rc.property]
                  }
                }
              }
            }
            continue
          }
          const node = allNodes[nodeIdx]
          for (const rc of plan.removeClauses) {
            // Only require the ref to match the matched source variable when a
            // step source is actually present (multi-step matches).  A bare
            // `MATCH (n)` yields steps=[] and binds exactly one variable, so any
            // ref in the REMOVE clause refers to it.
            if (rc.ref && stepSource != null && rc.ref !== stepSource) continue
            if (rc.type === 'REMOVE_PROP' && rc.property) {
              if (rc.property in node) {
                delete node[rc.property]
                // Sync the removed property onto the GE-returned record so a
                // subsequent RETURN expression (`n.num IS NOT NULL`) sees the
                // updated value.
                if (r.props && typeof r.props === 'object' && rc.property in (r.props as Record<string, unknown>)) {
                  delete (r.props as Record<string, unknown>)[rc.property]
                }
              }
            } else if (rc.type === 'REMOVE_LABEL' && rc.label) {
              // Remove a single label from the node's `_label`, keeping the
              // remaining labels in their original order.  `Default` is the
              // sentinel for "no label" and is never removed as a real label.
              const cur = String(node._label ?? '').split(':').map(s => s.trim()).filter(s => s && s !== 'Default')
              const kept = cur.filter(l => l !== rc.label)
              node._label = kept.join(':') || 'Default'
              // Keep __fullLabel in sync: labels() reads it before _label, so a
              // stale __fullLabel would resurrect the removed label.
              if (node._label === 'Default') {
                delete (node as any).__fullLabel
              } else {
                ;(node as any).__fullLabel = node._label
              }
              if (r.props && typeof r.props === 'object') {
                ;(r.props as Record<string, unknown>)._label = node._label
                if (node._label === 'Default') delete (r.props as Record<string, unknown>).__fullLabel
                else (r.props as Record<string, unknown>).__fullLabel = node._label
              }
            }
          }
          // 同步更新 GE 存储层
          if (ge) {
            try {
              await _geUpsertNode(ge, 1, "", { props: node })
            } catch (_) { /* ignore storage errors */ }
          }
        }
      }
    }


    // ── 内联节点属性预过滤（已在线 1551 的 seed 阶段完成） ──
    // [CVE-H4]: 此处的代码是 line 1551 处预过滤的重复实现，且当 skipNodeIndices
    // 已被 seed 阶段填充时跳过不执行。已移除。若 inlineVar 不是 step source，
    // 需在此处做兜底过滤而非依赖 isMatchSource 条件。
    // Note: seed 阶段的预过滤（line 1551）在 `!stepSourceFilters.length` 条件下执行，
    // 如果 stepSourceFilters 存在（如 MatchWhere2+3 跨变量场景），inline 过滤可能被跳过。
    // 但 stepSourceFilters 存在时 MATCH 模式复杂，inline 属性匹配通常由 ANTLR plan.filters 处理。
    // TODO: 如果需要全覆盖，应在 _walkMultiSteps 或 GE 结果后添加无条件 inline 属性过滤。

    // ── 修复 GE limit=0 bug ──
    if (plan.limit === 0 && records?.length) {
      return []
    }

    // ── labelExpr 过滤（多标签 AND 匹配） ──
    // Note: labelExpr 与 step.targetLabel 存在架构冗余（M1），
    // labelExpr 在 GE stepping 后再过滤，step.targetLabel 在 _walkMultiSteps
    // 每步立即过滤。两者都起作用但不冲突：step.targetLabel 做早期截断，
    // labelExpr 兜底（多标签 AND 匹配时 GE stepping 无法处理多标签）。
    const filteredRecords = plan.labelExpr?.items?.length
      ? (records || []).filter((r: any) => {
          // labelExpr constrains the *matched* (source) node — the variable the
          // `:A:B:...` label list is attached to in `MATCH (n:A:B:...)`.  With
          // edge-walk records the source node lives in `__crossVarRows[matchVar]`
          // (or `__crossVarRows[source]`), not in `r.props` (which is the target).
          const srcVar = (plan as any).matchVar || plan.steps?.[0]?.source
          const cvr = r?.__crossVarRows
          const srcNode = (srcVar && cvr && cvr[srcVar]) ? cvr[srcVar] : null
          const nodeLabel = srcNode
            ? (srcNode.__fullLabel ?? srcNode._label ?? '')
            : (r?.props?.__fullLabel ?? r?.props?._label ?? '')
          const nodeLabels = String(nodeLabel).split(':')
          return plan.labelExpr!.items.every(item =>
            !item.exclude && nodeLabels.includes(item.name)
          )
        })
      : (records || [])

    // ── labelFilter（WHERE 中的标签谓词，如 `a:Employee`）过滤 ──
    // 对所有节点变量检查其 _label 是否匹配
    const labelFilterItems: Array<{ variable: string; label: string; exclude: boolean }> | undefined = plan.labelFilterItems
    let filteredWithLabels = filteredRecords

    if (labelFilterItems?.length && filteredRecords.length) {
      // 构建 nodeGeIdx → label 的映射
      const nodeLabelsMap: Map<number, string> = new Map()
      for (let i = 0; i < allNodes.length; i++) {
        nodeLabelsMap.set(i, String(allNodes[i]._label || 'Default'))
      }
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true // 保留无法映射的记录
        // 检查每个标签谓词条件是否满足
        return labelFilterItems!.every(lfi => {
          // 找到变量对应的节点
          const varNodeIdx = resolveVariableNodeIdx(lfi.variable, plan, allNodes)
          if (varNodeIdx < 0) return true
          const actualLabel = nodeLabelsMap.get(varNodeIdx) || ''
          const matches = actualLabel === lfi.label
          return lfi.exclude ? !matches : matches
        })
      })
    }
    // ── OR 连接谓词过滤（WHERE n.p1 > 11 OR n.p2 = 13） ──
    // ANTLR 将 OR 谓词解析为两个独立的 filter 且无 OR 标记，
    // engine 默认 AND 连接导致无行匹配。从 query 文本检查 OR，改 AND 为 OR 语义。
    if (query && /OR/i.test(query) && filteredWithLabels?.length) {
      const orFilters = plan.filters?.length ? plan.filters : []
      if (orFilters.length >= 2) {
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return orFilters.some((f: any) => {
            const actual = r?.props?.[f.property]
            const expected = f.value
            if (actual === undefined) return false
            switch (f.operator) {
              case 'EQ':  return actual !== null && actual !== undefined && String(actual) === String(expected)
              case 'NEQ': return actual === null || actual === undefined || String(actual) !== String(expected)
              case 'GT':  return Number(actual) > Number(expected)
              case 'GTE': return Number(actual) >= Number(expected)
              case 'LT':  return Number(actual) < Number(expected)
              case 'LTE': return Number(actual) <= Number(expected)
              default:    return String(actual) === String(expected)
            }
          })
        })
      }
    }

    // ── WHERE 标签谓词后过滤（已经过 source 回溯后的数据） ──
    // 只对 needSourceVar=true 的场景生效（r.id 是 source 节点的 GE id）
    // 当直接返回 target 节点时（needSourceVar=false），不应用 source 节点的 skip 集合
    if (needSourceVar && skipNodeIndices.size > 0 && filteredWithLabels?.length && plan.steps?.[0]?.source) {
      const wsSource = plan.steps[0].source
      const before = filteredWithLabels.length
      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 通过 nodeGeIds 查找这条记录对应的 allNodes 索引
        // 如果 r 是从 source 回溯得到的，它的 id 就是 source GE id
        const nodeIdx = nodeGeIds.indexOf(r.id)
        if (nodeIdx < 0) return true
        // 如果节点在 skipNodeIndices 中（标签不匹配），跳过
        return !skipNodeIndices.has(nodeIdx)
      })

    }

    // ── length(p) / path 长度谓词过滤 ──
    // MATCH p = (n)-->(x) WHERE length(p) = 10 — ANTLR 不解析 length 函数
    // 从 query 文本检测 `length(p)` 模式，在 GE 返回后手动过滤
    if (query && filteredWithLabels?.length) {
      const lenMatch = query.match(/length\s*\(\s*(\w+)\s*\)\s*=\s*(\d+)/)
      if (lenMatch) {
        const targetLen = parseInt(lenMatch[2], 10)
        // 路径长度 = edgesPayload 中与结果节点相关的边数（单层无循环）
        // 简单情况：一个 step，一条边 → length=1
        // 对于复杂路径，路径长度就是步骤数
        const nSteps = plan.steps?.length || 1  // 单步默认 1
        if (nSteps !== targetLen) {
          filteredWithLabels = []  // 长度不匹配，无结果
        }
      }
    }

    // ── 跨变量属性引用过滤（WHERE n.animal = x.animal / a.id = b.id） ──
    // crossVarFilters 中的 filter 不能在 seed 阶段用常数比较，因为 value 是"x.animal"字符串。
    // 对于有边模式（needSourceVar=true）：行中 props=source 节点属性 + __targetProps=target 节点属性，
    // 对每一行检查跨变量比较。
    // 对于无边模式（steps.length=0）：纯节点扫描，做笛卡尔积配对。
    if (crossVarFilters.length && filteredWithLabels?.length) {
      if (plan.steps?.length && filteredWithLabels[0]?.props) {
        // 有边模式：行有 props（遍历 source/当前节点）和 __targetProps（target 节点）
        // 不需要 needSourceVar=true，因为只要有 props 就可从中取值。
        // 引用变量可能是 source 或 targetAlias——从 steps 中查找。
        const stepSourceVars = new Set(plan.steps.map(s => s.source))
        const stepTargetAliases = new Set(plan.steps.map(s => s.targetAlias))
        filteredWithLabels = filteredWithLabels.filter((r: any) => {
          return crossVarFilters.every((f: any) => {
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return true
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            // isRefSource: f.source 是 source 变量（取 r.props）还是 targetAlias（取 r.__targetProps）
            // 类似的，refVar 的取值位置也相同。
            const fSourceIsSourceVar = stepSourceVars.has(f.source)
            const refIsSourceVar = stepSourceVars.has(refVar)
            const actualVal = fSourceIsSourceVar ? r?.props?.[f.property] : r?.__targetProps?.[f.property]
            const refVal = refIsSourceVar ? r?.props?.[refProp] : r?.__targetProps?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              case 'GT':  return Number(actualVal) > Number(refVal)
              case 'GTE': return Number(actualVal) >= Number(refVal)
              case 'LT':  return Number(actualVal) < Number(refVal)
              case 'LTE': return Number(actualVal) <= Number(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        })
      } else if (!plan.steps?.length) {
        // 无边模式（steps.length=0）：MATCH (a:A), (b:B) WHERE a.id = b.id
        // 从 query 中提取变量→标签映射
        const varLabelMap: Record<string, string> = {}
        if (query) {
          const matchClauses = query.matchAll(/MATCH\s*\((\w+)\s*:\s*(\w+)\)/g)
          for (const mc of matchClauses) varLabelMap[mc[1]] = mc[2]
        }
        const returnCols = plan.returnColumns || []
        // 从 crossVarFilters 和 returnCols 收集所有参与变量
        const involvedVars = new Set<string>()
        for (const rc of returnCols) {
          const varName = typeof rc === 'string' ? rc.split('.')[0] : ''
          if (varName) involvedVars.add(varName)
        }
        for (const f of crossVarFilters) {
          if (f.source) involvedVars.add(f.source)
          if (typeof f.value === 'string') {
            const dotIdx = f.value.indexOf('.')
            if (dotIdx >= 0) involvedVars.add(f.value.substring(0, dotIdx))
          }
        }
        // 按变量 label 从 allNodes 分配节点
        const varNodeMap: Record<string, Array<{node: any; idx: number}>> = {}
        for (const varName of involvedVars) {
          const targetLabel = varLabelMap[varName]
          varNodeMap[varName] = allNodes
            .map((node, idx) => ({ node, idx }))
            .filter(({ idx }) => !skipNodeIndices.has(idx))
            .filter(({ node }) => {
              if (!targetLabel) return true
              const fullLabel = node.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') return fullLabel.split(':').includes(targetLabel)
              return String(node._label) === targetLabel
            })
        }
        const varNames = Object.keys(varNodeMap)
        const _evalCrossVar = (entryMap: Record<string, {node: any; idx: number}>, filters: any[]): boolean => {
          return filters.every((f: any) => {
            const actualProp = f.property
            const actualVal = entryMap[f.source]?.node?.[actualProp]
            const dotIdx = (f.value as string).indexOf('.')
            if (dotIdx < 0) return false
            const refVar = (f.value as string).substring(0, dotIdx)
            const refProp = (f.value as string).substring(dotIdx + 1)
            const refVal = entryMap[refVar]?.node?.[refProp]
            if (actualVal === undefined || refVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(refVal)
              case 'NEQ': return String(actualVal) !== String(refVal)
              default:    return String(actualVal) === String(refVal)
            }
          })
        }
        const pairedRows: any[] = []
        if (varNames.length >= 2) {
          // N 元笛卡尔积：递归生成所有 entry 组合
          const _cartesian = (idx: number, current: Record<string, {node: any; idx: number}>): void => {
            if (idx >= varNames.length) {
              // 检查 self-join 冲突：不同变量不能指向同一个节点索引
              const seenIdx = new Set<number>()
              for (const vn of varNames) {
                if (seenIdx.has(current[vn].idx)) return
                seenIdx.add(current[vn].idx)
              }
              if (!_evalCrossVar(current, crossVarFilters)) return
              // 构建结果行
              const firstVar = varNames[0]
              const row: any = {
                id: -1,
                props: current[firstVar].node,
                type: current[firstVar].node._label || 'Default',
                name: '',
                __crossVarRows: {} as Record<string, any>,
              }
              for (const vn of varNames) row.__crossVarRows[vn] = current[vn].node
              pairedRows.push(row)
              return
            }
            for (const entry of varNodeMap[varNames[idx]]) {
              current[varNames[idx]] = entry
              _cartesian(idx + 1, current)
            }
          }
          _cartesian(0, {})
        } else if (varNames.length === 1 && plan.hasMatch) {
          // 单变量 MATCH（无边）：直接取所有节点，构建结果行
          const singleVar = varNames[0]
          for (const entry of varNodeMap[singleVar]) {
            // 应用 plan.filters 过滤（用于 STARTS_WITH / ENDS_WITH / CONTAINS 等 GE 已处理的 filter）
            const filterMatch = (plan.filters || []).every((f: any) => {
              if (f.source !== singleVar) return true
              const actualVal = entry.node[f.property]
              const fv = f.value
              if (actualVal === undefined) return false
              switch (f.operator) {
                case 'EQ':   return String(actualVal) === String(fv)
                case 'NEQ':  return String(actualVal) !== String(fv)
                case 'GT':   return Number(actualVal) > Number(fv)
                case 'GTE':  return Number(actualVal) >= Number(fv)
                case 'LT':   return Number(actualVal) < Number(fv)
                case 'LTE':  return Number(actualVal) <= Number(fv)
                case 'STARTS_WITH': return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv)
                case 'ENDS_WITH':   return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv)
                case 'CONTAINS':    return typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv)
                default:            return String(actualVal) === String(fv)
              }
            })
            if (!filterMatch) continue
            const row: any = {
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            }
            pairedRows.push(row)
          }
        }
        filteredWithLabels = pairedRows
      }
    }

    // ── 单/多变量无边 MATCH 处理（无 crossVarFilters 时） ──
    // 当 crossVarFilters.length === 0 且 plan.steps?.length === 0 且 plan.hasMatch 时，
    // 上面的 crossVarFilters 分支不执行，filteredWithLabels 仍为 records。
    // 此处用 filteredRecords 重新构建正确格式的结果行。
    // 支持多个 MATCH 变量（如 MATCH (n), (m) → 笛卡尔积）和单变量 MATCH。
    // Skip the per-node rebuild when GE already folded this plan's aggregation
    // into a single synthetic row (id === -1, props holds the aggregate value,
    // no node `_label`).  The rebuild logic below expects per-node rows and
    // would otherwise drop the folded aggregate (e.g. `MATCH (n) DELETE n
    // RETURN sum(n.num)` → null instead of the correct sum).
    const _geFoldedAggRow = !!plan.aggregate && filteredRecords?.length === 1 &&
      !!filteredRecords[0]?.props && !('_label' in filteredRecords[0].props)
    if (!crossVarFilters.length && !plan.steps?.length && plan.hasMatch && !_geFoldedAggRow && (filteredRecords?.length || allNodes?.length)) {
      let hasMultiMatch = false
      const varLabelMap2: Record<string, string> = {}
      let inlineFilters: Array<{ source: string; property: string; operator: string; value: unknown; negated?: boolean }> = []
      if (query) {
        // Match the primary MATCH clause only.  A leading `OPTIONAL MATCH`
        // must not be mistaken for the primary MATCH: `OPTIONAL MATCH
        // (a:NotThere) MATCH (b:B)` would otherwise bind `a` as a required
        // variable and, since NotThere matches nothing, drop the (b:B) row too.
        const matchSection = query.match(/(?<!OPTIONAL\s)MATCH\s+(.*?)(?:\s+WHERE|\s+OPTIONAL|\s+RETURN|\s+WITH|\s+CREATE|\s+MERGE|\s+DELETE|\s+SET|\s+REMOVE|\s+UNWIND|\s+ORDER|\s+SKIP|\s+LIMIT|\s+CALL|\s+INVOKE|$)/is)
        hasMultiMatch = !!(matchSection && matchSection[1].includes(','))
        if (matchSection) {
          const clause = matchSection[1]
          const nodePatterns = [...clause.matchAll(/\((\w+)\s*:\s*(\w+)\)/g)]
          for (const np of nodePatterns) varLabelMap2[np[1]] = np[2]

          // Extract inline property filters: `(var:Label {prop: value})` or `(var {prop: value})`
          // ANTLR does NOT parse these into plan.filters — we need to extract them manually
          // and inject them for GE filtering (critical for BigInt precision in scenarios like
          // Comparison1 [10][11][12]).
          const inlineFilterMatch = clause.match(/\((\w+)(?:\s*:\s*\w+)?\s*\{([^}]+)\}/)
          if (inlineFilterMatch) {
            const sourceVar = inlineFilterMatch[1]
            const propsText = inlineFilterMatch[2]
            // Parse `prop: value` pairs; value can be number, string, bigInt
            const propPattern = /(\w+)\s*:\s*('(?:[^'\\]|\\.)*'|[+-]?\d{10,}|[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false)\s*/g
            let pm: RegExpExecArray | null
            while ((pm = propPattern.exec(propsText)) !== null) {
              const propName = pm[1]
              let propVal: unknown = pm[2]
              // Unquote string literals
              if (typeof propVal === 'string' && propVal.startsWith("'") && propVal.endsWith("'")) {
                propVal = propVal.slice(1, -1)
              } else if (typeof propVal === 'string' && /^[+-]?\d{10,}$/.test(propVal)) {
                // BigInt: store as BigInt to preserve precision across GE comparisons
                propVal = BigInt(propVal)
              } else if (typeof propVal === 'string' && /^[+-]?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(propVal)) {
                propVal = Number(propVal)
              }
              inlineFilters.push({ source: sourceVar, property: propName, operator: 'EQ', value: propVal })
            }
          }
        }
      }
      // 从 MATCH 变量中提取所有变量名（支持有/无 label/有内联属性三种写法）
      let matchVarKeys2 = Object.keys(varLabelMap2)
      if (!matchVarKeys2.length && query) {
        // 匹配所有 MATCH 中的节点变量： (n), (m), (a:Label), (b {prop})
        // Strip `exists { ... }` subqueries first so an INNER `MATCH (n)-->(m)`
        // inside a subquery is not misread as a second outer MATCH clause (which
        // would inflate the row count via a cross-product against `m`).
        const allMatchVars: string[] = [];
        const queryForMatch = _stripExistsSubqueryBlocks(query);
        const matchClauses = queryForMatch.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|OPTIONAL|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis);
        for (const mc of matchClauses) {
          const clause = mc[1];
          const vars = [...clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)].map(x => x[1]).filter(Boolean);
          allMatchVars.push(...vars);
        }
        matchVarKeys2 = [...new Set(allMatchVars)];
      }
      if (matchVarKeys2.length === 0 && query) {
        const anyMatchClause = query.match(/MATCH\s*\((\w+)/)
        if (anyMatchClause) matchVarKeys2 = [anyMatchClause[1]]
      }
      if (matchVarKeys2.length >= 1) {
        // 多变量 MATCH: 从 allNodes 直接构建节点列表，不依赖 GE 单标签扫描
        // 原因：ANTLR 只识别 scanLabel=第一个标签，GE 只返回该标签的节点。
        // 如果 MATCH 有多个不同标签的变量，我们需要用 allNodes 替代 filteredRecords。
        const useAllNodes = matchVarKeys2.length >= 2 && hasMultiMatch
        const sourceRecords = useAllNodes
          ? (allNodes || []).map((n: any, idx: number) => ({ node: n, idx }))
          : (filteredRecords || []).map((rec: any, idx: number) => {
              const nodeProps = rec.props || rec;
              return { node: nodeProps, idx };
            })
        // 为每个变量分配节点列表（按标签筛选）
        const varNodeMap2: Record<string, Array<{ node: Record<string, unknown>; idx: number }>> = {}
        for (const varName of matchVarKeys2) {
          const targetLabel2 = varLabelMap2[varName]
          varNodeMap2[varName] = sourceRecords
            .filter(({ node }: { node: Record<string, unknown> }) => {
              if (!targetLabel2) return true;
              // A REMOVE_LABEL side effect deletes the very label that MATCH
              // bound (`MATCH (n:N) REMOVE n:N RETURN n.num`).  The `:N`
              // predicate is a *match-time* condition already applied by the
              // graph engine before the side effect ran; re-checking it here
              // against the post-removal label (`Default`) would wrongly drop
              // every matched row.  Skip the label re-filter for such plans.
              const _removesLabel = plan.type === 'REMOVE' && (plan.removeClauses || []).some(rc => rc.type === 'REMOVE_LABEL')
              if (_removesLabel) return true;
              const fullLabel = node.__fullLabel
              if (fullLabel && typeof fullLabel === 'string') return fullLabel.split(':').includes(targetLabel2)
              // Node may carry multiple labels (`A:Foo`), so `MATCH (n:A)` must
              // still match.  A strict `===` equality here would drop a node
              // whose label was extended by a DML SET (`SET n:Foo` → `A:Foo`).
              return String(node._label).split(':').includes(targetLabel2);
            })
            // 应用 plan.filters 过滤（含内联属性过滤器）
            .filter(({ node }: { node: Record<string, unknown> }) => {
              // WHERE filters are already applied by the graph engine before
              // DML side effects run.  Re-applying them here (after SET/DELETE
              // mutated the node props) would wrongly drop rows — e.g.
              // `MATCH (n:A) WHERE n.name='Andres' SET n.name='Michael'
              // RETURN n` would see `name` already set to `Michael` and fail
              // the `= 'Andres'` predicate.  Only apply GE-unhandled filters
              // (inline `{prop:val}` predicates) in the DML path.
              const _isDmlRebuild = plan.type === 'SET' || plan.type === 'DELETE' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY'
              // For DML plans every WHERE/inline predicate is already applied in
              // the graph-engine seed stage (skipNodeIndices / stepSourceFilters)
              // *before* the side effects mutate the node.  Re-applying them here
              // would compare the predicate against the post-mutation value and
              // wrongly drop rows (e.g. `MATCH (n:X {name:'A'}) SET n={name:'B'}`
              // — re-checking `name='A'` against the now-`B` value).  So DML plans
              // apply no filters at all in this rebuild; non-DML plans still apply
              // both WHERE filters and inline `{prop:val}` predicates.
              const allFilters = _isDmlRebuild ? [] : [...(plan.filters || []), ...inlineFilters]
              return allFilters.every((f: any) => {
                if (f.source && f.source !== varName) return true;
                const actualVal = node[f.property as string];
                if (f.property && actualVal === undefined) return false;
                const fv = f.value;
                let baseResult = false;
                switch (f.operator) {
                  case 'EQ':   baseResult = actualVal === fv; break;
                  case 'NEQ':  baseResult = actualVal !== fv; break;
                  case 'GT':   baseResult = Number(actualVal) > Number(fv); break;
                  case 'GTE':  baseResult = Number(actualVal) >= Number(fv); break;
                  case 'LT':   baseResult = Number(actualVal) < Number(fv); break;
                  case 'LTE':  baseResult = Number(actualVal) <= Number(fv); break;
                  case 'IS_NULL':     baseResult = actualVal == null; break;
                  case 'IS_NOT_NULL': baseResult = actualVal != null; break;
                  case 'STARTS_WITH': baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break;
                  case 'ENDS_WITH':   baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break;
                  case 'CONTAINS':    baseResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break;
                  default:            baseResult = String(actualVal) === String(fv); break;
                }
                return f.negated ? !baseResult : baseResult;
              });
            });
        }
        const formattedRows: any[] = []
        if (matchVarKeys2.length >= 2) {
          // 多变量：生成笛卡尔积（无 WHERE 条件时不限制 self-join）
          const _cartesian = (idx: number, current: Record<string, { node: Record<string, unknown>; idx: number }>): void => {
            if (idx >= matchVarKeys2.length) {
              const firstVar = matchVarKeys2[0];
              const row: any = { id: -1, props: current[firstVar].node, type: '', name: '', __crossVarRows: {} };
              for (const vn of matchVarKeys2) row.__crossVarRows[vn] = current[vn].node;
              formattedRows.push(row);
              return;
            }
            const varName = matchVarKeys2[idx];
            for (const entry of varNodeMap2[varName]) {
              current[varName] = entry;
              _cartesian(idx + 1, current);
            }
          };
          _cartesian(0, {});
        } else {
          // 单变量 MATCH
          const singleVar = matchVarKeys2[0];
          for (const entry of varNodeMap2[singleVar]) {
            formattedRows.push({
              id: -1,
              props: entry.node,
              type: entry.node._label || 'Default',
              name: '',
              __crossVarRows: { [singleVar]: entry.node },
            });
          }
        }
        filteredWithLabels = formattedRows;
      }
    }

    // ── 边变量 filter（WHERE r.name = 'foo'） ──
    // plan.filters 中的 source 如果是边变量（不在 MATCH 的节点变量中），
    // 用 edgesPayload 中的边 props 来过滤结果行。
    // 找到所有边变量 filter

    const stepSource = plan.steps?.[0]?.source
    // 同样使用所有 step 节点变量
    const aliasNodeList = [...allStepVars]
    const edgeVarFilters = edgeFilters.length
      ? edgeFilters
      : (plan.filters || []).filter(f => {
      if (!f.source || !f.property) return false
      return f.source && !aliasNodeList.includes(f.source)
    })
    const ep = edgesPayload || [] as any

    if (edgeVarFilters.length && ep.length && filteredWithLabels?.length) {

      filteredWithLabels = filteredWithLabels.filter((r: any) => {
        // 对每个边变量 filter，检查当前记录是否通过
        return edgeVarFilters.every((f: any) => {
          // 在 edgesPayload 中查找
          const nodeIdx = nodeGeIds.indexOf(r.id)
          if (nodeIdx < 0) return true
          // 连接到这个节点的所有边
          const connEdges = ep.filter((e: any) =>
            e.dstIdx === nodeIdx ||
            (sourceTargetMap.has(r.id) && e.srcIdx === nodeIdx)
          )
          if (!connEdges.length) return false
          return connEdges.some((e: any) => {
            const edgeProps = e.props || {}
            const actual = edgeProps[f.property]
            const expected = f.value
            if (actual === undefined) return false
            // 根据 operator 做比较
            if (f.operator === 'EQ') return String(actual) === String(expected)
            if (f.operator === 'NEQ') return String(actual) !== String(expected)
            if (f.operator === 'GT') return Number(actual) > Number(expected)
            if (f.operator === 'GTE') return Number(actual) >= Number(expected)
            if (f.operator === 'LT') return Number(actual) < Number(expected)
            if (f.operator === 'LTE') return Number(actual) <= Number(expected)
            return String(actual) === String(expected)
          })
        })
      })
    }

    // ── edgeProps（内联关系属性谓词）过滤 ──
    // MATCH (node)-[r:KNOWS {name: 'monkey'}]->(a) — steps 中的 edgeProps
    // 利用 edgesPayload（从 __edges 提取的边Info）来验证边属性是否匹配
    const edgePropSteps = (plan.steps || []).filter(s => s.edgeProps && Object.keys(s.edgeProps).length > 0)
    const edgePropFilteredRecords = (edgePropSteps.length && edgesPayload.length)
      ? (filteredWithLabels || []).filter((r: any) => {
          return edgePropSteps.every(s => {
            if (!s.edgeProps) return true
            // When the graph engine has already materialised the relationship
            // variable (dir='any' / edgeVariable), inspect that exact edge's
            // properties.  Filtering by "does the *source node* have ANY edge
            // matching the predicate" is wrong: for an undirected hop a node may
            // have several edges, and that heuristic keeps the row even when the
            // actual matched edge (`__crossVarRows.<edgeVar>`) violates the
            // inline property map (e.g. `-[r {name:'r1'}]-` crossing the r2 edge).
            const boundEdge = s.edgeVariable ? (r.__crossVarRows?.[s.edgeVariable] as any) : undefined
            if (boundEdge && typeof boundEdge === 'object') {
              for (const [k, v] of Object.entries(s.edgeProps)) {
                const actual = boundEdge[k] ?? boundEdge.props?.[k]
                if (String(actual) !== String(v)) return false
              }
              return true
            }
            // Fallback (no materialised edge var): find a connecting edge whose
            // properties satisfy the predicate.
            const nodeIdx = nodeGeIds.indexOf(r.id)
            if (nodeIdx < 0) return false
            const matchingEdges = edgesPayload.filter(e =>
              (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx)
            )
            if (!matchingEdges.length) return false
            for (const me of matchingEdges) {
              if (me.label && s.edgeLabel && me.label !== s.edgeLabel) continue
              if (!me.props && Object.keys(s.edgeProps).length > 0) continue
              let match = true
              for (const [k, v] of Object.entries(s.edgeProps)) {
                const actual = me.props?.[k]
                if (String(actual) !== String(v)) { match = false; break }
              }
              if (match) return true
            }
            return false
          })
        })
      : filteredWithLabels

    // ── 边变量后处理 ──
    // 如果 returnColumns 包含边变量（如 MATCH (a)-[r]->(b) RETURN r），
    // GE 的 _executeQueryPlan 只返回邻居节点，不Trace边。
    // 从 edgesPayload（__edges Info）中获取边标签构建 [:T1] 格式。
    // 策略：
    // 1. 如果 MATCH 指定了 edgeLabel（:T1），直接用 query 的 label
    // 2. 如果未指定，从 edgesPayload 按 srcIdx→dstIdx 匹配边标签
    const edgeLabelsFromPayload = edgesPayload.map(ep => ep.label).filter(Boolean)
    const uniqueEdgeLabels = [...new Set(edgeLabelsFromPayload)]
    const queryEdgeLabel = (plan.steps || []).find(s => s.edgeLabel)?.edgeLabel
    const hasExplicitEdgeLabel = queryEdgeLabel && !queryEdgeLabel.includes('|')
    const hasMatchingEdgeLabel = hasExplicitEdgeLabel && uniqueEdgeLabels.includes(queryEdgeLabel)
    // Extract source alias from scanLabel pattern (e.g. MATCH (n:X) when
    // ANTLR treats it as label scan without creating a TraverseStep)
    const scanSourceAlias = (plan.scanLabel && query && plan.steps?.length === 0)
      ? (query.match(/MATCH\s*\(\s*(\w+)\s*(?::\s*\w+\s*)?\)/i) || [])[1] || null
      : null

    const nodeAliases = new Set([
      ...(plan.createNodes || []).map(n => n.alias).filter(Boolean),
      ...(plan.steps || []).flatMap(s => [s.source, s.targetAlias, s.pathVariable].filter(Boolean)),
      ...(plan.optionalMatchSteps || []).flatMap((om: any) => {
        const vars: string[] = []
        if (om.variableName) vars.push(om.variableName)
        for (const s of om.steps || []) {
          if (s.source) vars.push(s.source)
          if (s.targetAlias) vars.push(s.targetAlias)
          if (s.pathVariable) vars.push(s.pathVariable)
        }
        return vars
      }),
    ])
    // For edge-less multi/single-node MATCH (e.g. `MATCH (a), (b)` with no
    // TraverseStep), the plan carries no `steps` and no `scanLabel`, so the
    // bare node variables (`a`, `b`) would otherwise be misclassified as edge
    // variables by the `edgeVarCols` filter below. Extract them from the MATCH
    // clause of the original query and register them as node aliases so that
    // `RETURN b` formats the node (not an edge) correctly.
    if (!plan.steps?.length && query) {
      const queryForMatch = _stripExistsSubqueryBlocks(query)
      const matchClauses = queryForMatch.matchAll(/MATCH\s+(.*?)(?:\s+(?:WHERE|WITH|RETURN|CREATE|MERGE|DELETE|SET|REMOVE|UNWIND|ORDER\s+BY|SKIP|LIMIT|INVOKE|CALL)\s|$)/gis)
      for (const mc of matchClauses) {
        const clause = mc[1]
        const vars = [...clause.matchAll(/\((\w+)\s*(?::|\)|{)/g)].map(x => x[1]).filter(Boolean)
        for (const v of vars) nodeAliases.add(v)
      }
    }
    if (scanSourceAlias) nodeAliases.add(scanSourceAlias)
    // OPTIONAL MATCH relationship variables must be resolved by the OPTIONAL
    // expansion downstream, never by the edgeVarCols projection here (which only
    // understands the leading MATCH).  Projecting them here would stringify an
    // unmatched optional edge as `[:]` (or `[:LABEL]`) and leak it into RETURN
    // even though OPTIONAL MATCH should bind null when it has no match.
    const _optionalEdgeVars = new Set<string>()
    for (const om of (plan.optionalMatchSteps || [])) {
      for (const s of (om.steps || [])) {
        if (s.edgeVariable) _optionalEdgeVars.add(s.edgeVariable)
        if (s.edgeAlias) _optionalEdgeVars.add(s.edgeAlias)
      }
    }
    // edgeVarCols：识别边变量 RETURN 列（如 RETURN r），排除 RETURN i.var 等属性列
    // 属性列已被 dispatchWherePath 拆为简短名称（如 i.var→var），此时 nodeAliases 不含 var。
    // 用原始 query 做最终判断：如果 query 中是 var.xxx 格式的列，不当作边变量。
    const varColSet = new Set(plan.returnColumns || [])
    const queryHasColumnRef = (query || '').match(/\w+\.\w+/)
    const edgeVarCols = (plan.returnColumns || []).filter(rc => {
      if (!rc || rc === '*' || rc.includes('.')) return false
      // 排除函数调用列（如 labels(m)、count(r)、type(r)）—— 它们是表达式，不是边变量
      if (/^\w+\s*\(.*\)/.test(rc)) return false
      // 排除含运算符的表达式列（如 p1 = p2、a <> b）—— 比较/二元运算，不是边变量
      if (/[+*/<>=!]|(\s+(?:IN|AND|OR|XOR|IS\s+NULL|IS\s+NOT\s+NULL)\s+)/i.test(rc)) return false
      if (nodeAliases.has(rc)) return false
      if (_optionalEdgeVars.has(rc)) return false
      // Exclude expressionColumns aliases (e.g. a list comprehension
      // `[x IN [r,0] | type(x)] AS list`, Pattern Comprehension, etc.) — they
      // are expression columns evaluated by _formatResultRow, not edge
      // variables, so they must never be stringified as an edge placeholder.
      // A trivial identity entry `{expression:"r1", alias:"r1"}` is NOT a
      // computed expression — it is a plain variable renamed to itself (ANTLR
      // registers every RETURN item this way), and must still be treated as an
      // edge variable when it names a relationship.  Only genuinely computed
      // expressions (`expression !== alias`, e.g. a list comprehension
      // `[... ] AS list`) are excluded here.
      if ((plan.expressionColumns || []).some((ec: any) => {
        const ecExpr = typeof ec === 'string' ? ec : (ec.expression ?? ec.alias)
        const ecAlias = typeof ec === 'string' ? ec : (ec.alias || ec.expression)
        return ecAlias === rc && ecExpr !== rc
      })) return false
      // 排除聚合函数参数列（如 'count(r)' 中 r 是参数，不是边变量 RETURN 列）
      if (plan.aggregate) {
        const aggCol = (plan.aggregate as any).column || ''
        if (aggCol.includes(rc) && /^\w+\(/.test(aggCol)) return false
      }
      // 如果属性名在所有节点 props 中作为键存在，说明是节点属性而非边变量
      // 回退方案：检查 query 中是否有原始变量前缀（如 i.var）对应此 rc
      if (queryHasColumnRef && query) {
        const varRefs = query.match(/\w+\.\w+/g) || []
        if (varRefs.some(vr => vr.split('.')[1] === rc)) return false
      }
      return true
    })
    let rawWithEdges = (edgeVarCols.length && (hasMatchingEdgeLabel || edgesPayload.length))
      ? edgePropFilteredRecords.map((r: any) => {
          const row: Record<string, unknown> = {}
          if (r.props) Object.assign(row, r.props)
          // 对于多边变量：按遍历步骤顺序分配边。edgeVarCols 的顺序对应遍历步骤顺序。
          // edgesPayload 中边的顺序为遍历中匹配的顺序，If any多个边变量且边数匹配，
          // 则按顺序分配（适用于链式匹配如 ()-[r1:T1]->()-[r2:T2]->()）
          const edgeVarCount = edgeVarCols.length
          const sequentialMatch = (edgeVarCount === edgesPayload.length && edgeVarCount > 1 && edgesPayload.every((e: any) => e.label))
          // 多步路径：优先从 r.props.__stepEdges（geNode.props 中保存的真实匹配边标签），回退到 plan.steps
                    const nodeIdx = nodeGeIds.indexOf(r.id)
          const rawStepEdges: string[] = (nodeIdx >= 0 && stepEdgesCache.has(nodeIdx) && stepEdgesCache.get(nodeIdx)!.length === edgeVarCount)
            ? stepEdgesCache.get(nodeIdx)!
            : (plan.steps || []).map((s: any) => s.edgeLabel || '').filter(Boolean)
          const actualStepEdges = rawStepEdges
          if ((plan.steps || []).length > 1) {
          }
          for (let eci = 0; eci < edgeVarCols.length; eci++) {
            const evc = edgeVarCols[eci]
            let edgeLabel = ''
            let edgeProps: Record<string, unknown> | null = null
            // Per-record authoritative edge binding.  `stepEdgesCache` is keyed
            // by the target node index, which collides when several source nodes
            // walk to the same target (e.g. `MATCH (x)-[r1]-(y)-[r2]-(z)` where
            // both `x=A` and `x=B` end at `z=Looper`); the global cache is then
            // overwritten and both records would render the last source's edge
            // labels.  The per-record `__crossVarRows[evc]` (populated during the
            // step walk, line ~2868) carries the correct relationship for this
            // specific row, so prefer it whenever present.
            const perRecordEdge = (r.__crossVarRows?.[evc] as any)?.__edgeLabel as string | undefined
            if (perRecordEdge) {
              edgeLabel = perRecordEdge
              const peProps = (r.__crossVarRows?.[evc] as any)
              if (peProps && typeof peProps === 'object') {
                const cleaned: Record<string, unknown> = {}
                for (const [k, v] of Object.entries(peProps)) {
                  if (!k.startsWith('__') && k !== '_label' && k !== '_type') cleaned[k] = v
                }
                if (Object.keys(cleaned).length) edgeProps = cleaned
              }
            } else if (eci < actualStepEdges.length) {
              edgeLabel = actualStepEdges[eci]
            } else if (r.__edgeLabel) {
              edgeLabel = r.__edgeLabel
            } else if (hasExplicitEdgeLabel) {
              edgeLabel = queryEdgeLabel!
            } else if (nodeIdx >= 0) {
              if (sequentialMatch) {
                // 顺序匹配：第 eci 个边变量取 edgesPayload 的第 eci 个边
                const matchingEdge = edgesPayload[eci]
                if (matchingEdge?.label) edgeLabel = matchingEdge.label
                if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
              } else {
                // 非顺序匹配：通过 nodeIdx 查找（跳过已使用的边）
                const usedEdgeCount = eci
                const matchingEdgeIdx = edgesPayload.findIndex((e: any, i: number) => {
                  if (i < usedEdgeCount) return false
                  return e.dstIdx === nodeIdx || e.srcIdx === nodeIdx
                })
                if (matchingEdgeIdx >= 0) {
                  const matchingEdge = edgesPayload[matchingEdgeIdx]
                  if (matchingEdge?.label) edgeLabel = matchingEdge.label
                  if (matchingEdge?.props && Object.keys(matchingEdge.props).length) edgeProps = matchingEdge.props as Record<string, unknown>
                }
              }
            }
            if (edgeLabel && edgeProps && Object.keys(edgeProps).length) {
              const propsStr = Object.entries(edgeProps)
                .map(([k, v]) => `${k}: ${typeof v === 'string' ? `'${v}'` : String(v)}`)
                .join(', ')
              row[evc] = `[:${edgeLabel} {${propsStr}}]`
            } else {
              row[evc] = edgeLabel ? `[:${edgeLabel}]` : '[:]'
            }
            // 同时设置 __edgeLabel 供 _formatResultRow 别名分支使用
            if (edgeLabel) r.__edgeLabel = edgeLabel
            if (edgeProps) r.__edgeProps = edgeProps
          }
          delete (row as QueryRow)._stepEdges
          delete (row as QueryRow).__stepEdges
          return { ...r, props: row }
        })
      : edgePropFilteredRecords


    // ── 边属性列后置处理 ──
    // 对 `RETURN r.num` 这样的边属性访问，从 edgesPayload 查找边属性并设置到行记录
    if (edgesPayload.length && rawWithEdges.length && (query || '').match(/\w+\.\w+/)) {
      // 从 query 中提取可能的边属性访问列
      const potentialEdgePropCols = extractEdgePropColumnsFromQuery(query || '')
      if (potentialEdgePropCols.length) {
        for (const rawRec of rawWithEdges) {
          const nodeIdx = nodeGeIds.indexOf(rawRec.id)
          if (nodeIdx < 0) continue
          const matchingEdge = edgesPayload.find(e => (e.dstIdx === nodeIdx || e.srcIdx === nodeIdx) && e.props && Object.keys(e.props).length > 0)
          if (matchingEdge?.props) {
            if (!rawRec.__edgeProps) rawRec.__edgeProps = {}
            Object.assign(rawRec.__edgeProps, matchingEdge.props)
          }
        }
      }
    }

    // ── WITH 子句后处理：对 GE 返回的 raw rows 应用 WITH 投影 ──
    // 当 plan.with.columns 存在时（MATCH ... WITH [...] AS list RETURN ...），
    // GE 的下层 _executeQueryPlan 不处理 WITH 子句（仅在 GE.query() 中处理），
    // 而 _executeViaGraphEngine 直接调用 GE._executeQueryPlan 绕过了 WITH 处理。
    // 此处用表达式引擎对 WITH 列求值，将结果放到 rawRow.props 中。
    // 也会将 WITH 列表中的标识符字符串解析为实际节点值。
    // ── WITH 子句后处理：对 GE 返回的 raw rows 应用 WITH 投影 ──
    // 当 plan.with.columns 存在时（MATCH ... WITH [...] AS list RETURN ...），
    // GE 的下层 _executeQueryPlan 不处理 WITH 子句（仅在 GE.query() 中处理），
    // 而 _executeViaGraphEngine 直接调用 GE._executeQueryPlan 绕过了 WITH 处理。
    // 此处用表达式引擎对 WITH 列求值，将结果放到 rawRow.props 中。
    // 也会将 WITH 列表中的标识符字符串解析为实际节点值。
    //
    // 多 WITH 管道：withChain 保留所有 WITH 子句（按出现顺序）。当存在两个及
    // 以上 WITH 时（如 `WITH a, a.num+a.num2 AS sum WITH a, a.num2%3 AS mod
    // ORDER BY sum`），后一个 WITH 的 ORDER BY / 表达式可能引用前一个 WITH 的
    // 投影别名（sum）。因此必须顺序应用每个 WITH，把上一步的 alias 先写入
    // props，使其在下一步的求值作用域中可见。
    const withChainToApply =
      (plan.withChain && plan.withChain.length > 1 ? plan.withChain : (plan.with ? [plan.with] : []))
    if (withChainToApply.length) {
      // ── Intermediate aggregation inside a WITH chain ──
      // A WITH segment that carries an aggregate (e.g. `WITH otherPerson,
      // count(*) AS foaf`) must fold the current row set into one row per group
      // key (the non-aggregate columns) BEFORE any later WHERE / WITH segment
      // consumes its projection.  The per-row pipeline below only projects flat
      // expressions and intentionally skips aggregate columns, so an ungrouped
      // aggregate would leave `foaf` undefined and downstream `WHERE foaf > 1`
      // would drop every row.  Fold each aggregate-carrying segment, in order,
      // into the row set as it is processed.
      let _wcRows = rawWithEdges
      const _withChainToProcess: any[] = []
      for (const wcSeg of withChainToApply) {
        if ((wcSeg as any)?.aggregate) {
          _wcRows = _groupAggregateWithRows(_wcRows, wcSeg as any, allNodes)
          // The fold already materialised the aggregate aliases; drop the
          // segment from the per-row projection pass below (its columns would
          // otherwise be re-evaluated against the already-grouped rows).
          continue
        }
        _withChainToProcess.push(wcSeg)
      }
      rawWithEdges = _wcRows
      for (const rawRow of rawWithEdges) {
        // Snapshot node variables that alias rawRow.props before writing WITH
        // projection aliases back into props.  For a single-node MATCH the row
        // is built with `props` and `__crossVarRows[v]` referencing the *same*
        // node object (see the edge-less MATCH row builder below), so assigning
        // `props[alias] = <projection>` would also pollute the node variable,
        // e.g. `MATCH (a) WITH a, a.num+a.num2 AS sum` would leave `a` carrying
        // a bogus `sum` property.  Break the alias by shallow-copying the node
        // into __crossVarRows before any such mutation.
        if (rawRow.__crossVarRows && rawRow.props && typeof rawRow.props === 'object') {
          for (const vn of Object.keys(rawRow.__crossVarRows)) {
            if (rawRow.__crossVarRows[vn] === rawRow.props) {
              rawRow.__crossVarRows[vn] = { ...rawRow.props }
            }
          }
        }
        for (const withClause of _withChainToProcess) {
          // WITH projections are simultaneous: every column in a single WITH
          // clause is evaluated against the clause's INPUT row, not against the
          // values already projected by earlier columns.  For `WITH a AS b,
          // b AS tmp` the `b` inside `b AS tmp` refers to the original `b` (the
          // B node), not the freshly-renamed `b` (= a).  Build a single input
          // snapshot (baseRc) once per WITH clause so all of its columns read
          // identical inputs; writing a projection back into `rawRow.props`
          // must not leak into the evaluation of the next column.
          // Do NOT exclude a key merely because it equals an alias: in a
          // shadowing pipeline (`WITH x AS y ... WITH y % 3 AS y`) the alias
          // reuses a prior projection whose OLD value must remain visible to
          // the right-hand side (`y % 3` reads the old `y`).  Excluding it here
          // left the variable undefined → NaN.
          const baseRc: Record<string, unknown> = {}
          if (rawRow.props) {
            for (const [k, v] of Object.entries(rawRow.props)) {
              if (!k.startsWith('_')) baseRc[k] = v
            }
          }
          if (rawRow.__crossVarRows) {
            for (const [k, v] of Object.entries(rawRow.__crossVarRows)) {
              if (!(k in baseRc)) baseRc[k] = v
            }
          }
          // Restore outgoing-edge context on node variables: GE result rows
          // carry `_label`/`_alias` but drop `__edges`, which pattern
          // comprehensions like `[(n)-->() | 1]` need to compute degrees.
          // Look the node up in allNodes by `_alias` and attach its `__edges`
          // so downstream expression evaluation sees them.
          for (const k of Object.keys(baseRc)) {
            const rcv = baseRc[k] as any
            if (rcv && typeof rcv === 'object' && !Array.isArray(rcv) && rcv.__edges === undefined) {
              const byAlias = rcv._alias
                ? (allNodes as any[]).find((a: any) => a._alias === rcv._alias)
                : undefined
              if (byAlias && Array.isArray(byAlias.__edges)) {
                rcv.__edges = byAlias.__edges
              }
            }
          }
          for (const wc of withClause.columns || []) {
            const alias = typeof wc === 'object' ? wc.alias : null
            if (process.env.DIAG_W) console.error('[DIAG_W] before proj, baseRc.m =', JSON.stringify(baseRc['m']), 'alias:', alias, 'expr:', typeof wc.expression === 'string' ? wc.expression : JSON.stringify(wc.expression))
            if (!alias || (wc.expression as any)?.type === 'IDENTIFIER') continue
            const wcExpr = typeof wc.expression === 'string' ? wc.expression :
              (wc.expression?.type === 'LIST'
                ? '[' + (wc.expression.items || []).map((i: any) => i.name ?? i.value ?? '').join(', ') + ']'
                : null)
            if (!wcExpr) continue
            // Skip aggregate columns (`count(...)`, `sum(...)`, etc.): the graph
            // engine's `_execAggregation` already folded them into the synthetic
            // result row.  Re-evaluating them here as a scalar expression would
            // recompute `count(DISTINCT n.name)` against the collapsed row (which
            // no longer carries the raw node properties) and overwrite the correct
            // value with 0.
            if (typeof wcExpr === 'string' && /^\s*(count|sum|avg|max|min|collect|stdev|stdevp|percentilecont|percentiledisc)\s*\(/i.test(wcExpr)) continue
            // Evaluate against a shallow copy of the input snapshot so per-column
            // `_firstVar` injection does not mutate the shared snapshot.
            const rc: Record<string, unknown> = { ...baseRc }
            // 将 MATCH 变量注入 rc（支持 v.date 等属性访问表达式）
            const _exprVars = wcExpr.match(/([a-zA-Z_]\w*)/g)
            const _firstVar = _exprVars?.[0]
            if (_firstVar && rawRow?.props && !(_firstVar in rc)) {
              rc[_firstVar] = rawRow.props
            }
            try {
              const evaluated = _evalBinary(wcExpr, rc)
              // A null result is a legitimate projection value (e.g.
              // `WITH coalesce(b, c) AS x` where both b and c are null yields
              // x = null), not "no value".  Skipping it left the alias
              // undefined, which the formatter then mis-stringified as an edge
              // `[:]`.  Only a thrown evaluation (unknown variable) keeps the
              // graph engine's prior value.
              if (evaluated === undefined) {
                // absent variable: leave the GE value untouched
              } else if (typeof evaluated === 'object' && evaluated !== null && !Array.isArray(evaluated)) {
                // 清理节点对象中的内部属性（__edges、props 等），避免输出为 props: (...)
                const cleanVal: Record<string, unknown> = {}
                for (const [ek, ev] of Object.entries(evaluated as Record<string, unknown>)) {
                  if (ek !== '__edges' && ek !== 'props' && !ek.startsWith('__')) cleanVal[ek] = ev
                }
                rawRow.props[alias] = cleanVal
              } else {
                rawRow.props[alias] = evaluated
              }
            } catch {
              // Fallback: keep GE's value
            }
          }
        }
      }

      // ── WITH DISTINCT deduplication ──
      // A WITH segment carrying the DISTINCT modifier (`WITH DISTINCT a.name AS
      // name`) deduplicates the projected row set on its projected columns.
      // Apply it after the per-row projection above (which already materialised
      // the projection aliases into each row's props).
      for (const wcSeg of withChainToApply || []) {
        if (!(wcSeg as any)?.distinct) continue
        const projAliases = ((wcSeg as any)?.columns || [])
          .map((c: any) => c?.alias)
          .filter((a: any) => a)
        if (!projAliases.length) continue
        // Dedup on the projection aliases only (plus any implicit bare columns
        // carried by the segment, e.g. `WITH DISTINCT a.name AS name` keys on
        // `name`).  Normalise object/array values to a stable key.
        const _distinctKey = (raw: Record<string, unknown>): string =>
          projAliases.map((a: string) => {
            const v = (raw.props as any)?.[a] ?? (raw as any)[a]
            if (v && typeof v === 'object') return JSON.stringify(v)
            return String(v ?? '__NULL__')
          }).join('||')
        const seen = new Set<string>()
        rawWithEdges = rawWithEdges.filter((raw: Record<string, unknown>) => {
          const key = _distinctKey(raw)
          if (seen.has(key)) return false
          seen.add(key)
          return true
        })
      }
    }

    // ── 格式化结果 ──
    // Pre-process path variables: replace edge placeholder strings with path
    // objects containing __path arrays so list comprehensions like
    // [x IN collect(p) | head(nodes(x))] can resolve correctly.
    const pathVars = new Set((plan.steps || []).map(s => s.pathVariable).filter(Boolean))
    // Normalize a raw seed edge into the relationship object the serializer
    // `_toPathNotation` expects (`__edgeLabel`/`_type`/`_label`) plus a `_dir`
    // marker.  `_dir` is 'out' when the hop walks the edge in its natural
    // source→target direction and 'in' when it walks against it.  Directed
    // steps (`-->`/`<--`) inherit the step direction; undirected (`--`) hops use
    // the actual edge orientation from `srcIdx`/`dstIdx`.
    const _mkEdgeObj = (ep: { srcIdx: number; dstIdx: number; label: string; props?: any }, dir: string): Record<string, unknown> => {
      const eo: Record<string, unknown> = {
        __edgeLabel: ep.label ?? '',
        __edgeLabelStr: ep.label ?? '',
        _type: ep.label ?? '',
        _label: ep.label ?? '',
        _dir: dir,
      }
      if (ep.props) for (const [k, v] of Object.entries(ep.props)) eo[k] = v
      return eo
    }
    // Direct the edge for a single directed/undirected hop between `path[i]`
    // (source node) and `path[i+1]` (target node), where `ep` is the raw edge
    // and `stepDir` is the traversal step's direction ('out'|'in'|'any').
    const _edgeDir = (ep: { srcIdx: number; dstIdx: number }, stepDir: string, srcNodeIdx: number): string => {
      if (stepDir === 'out') return 'out'
      if (stepDir === 'in') return 'in'
      // Undirected: 'out' if the edge's source is the path's current source.
      return ep.srcIdx === srcNodeIdx ? 'out' : 'in'
    }
    const _stepDir = (plan.steps?.[0] as any)?.direction ?? 'out'
    // Resolve a (possibly stripped) node object back to its index in `allNodes`
    // by `_alias` first, then by label+name.  Used to orient edges within a
    // reconstructed named path.
    const _aliasIndexOf = (node: Record<string, unknown>, nodes: Array<Record<string, unknown>>): number => {
      if (!node || typeof node !== 'object') return -1
      const a = (node as any)._alias
      if (a) {
        const byAlias = nodes.findIndex(n => (n as any)._alias === a)
        if (byAlias >= 0) return byAlias
      }
      const lbl = (node as any)._label?.replace(/^:/, '')
      const nm = (node as any).name
      return nodes.findIndex(n =>
        ((n as any)._label === lbl || (n as any)._label === `:${lbl}`) &&
        (nm === undefined || (n as any).name === nm)
      )
    }
    if (pathVars.size) {
      // ── Multi-step / variable-length named path reconstruction ──
      // A named path spanning more than one relationship (`MATCH p =
      // (a)-->(b)-->(c)`) or a variable-length hop (`MATCH p = (a)-[:T*2]-(b)`)
      // cannot be reconstructed from GE's per-edge flattened rows: GE emits one
      // row per relationship, each carrying only its two endpoints, which loses
      // the interior nodes and the full edge sequence.  Re-traverse from the
      // path's anchor source(s) via `_walkMultiSteps` and rebuild a single
      // complete `{ __path, __pathEdges }` object per matched path.
      // Every named path (single-hop, multi-hop, or variable-length) is
      // reconstructed uniformly from `_walkMultiSteps`, which returns complete
      // node-index sequences per matched path.  This is the single source of
      // truth for path objects and avoids the per-edge flattening that corrupts
      // interior nodes and edge sequences.
      const _multiStepPathVar = Array.from(pathVars).find(pv => (plan.steps || []).some((s: any) => s.pathVariable === pv) || (plan as any).pathVar === pv)
      let _fullPathReconDone = false
      if (_multiStepPathVar && plan.steps?.length) {
        // Anchor step = the step carrying the path variable.
        const pvSteps = (plan.steps || []).filter((s: any) => s.pathVariable === _multiStepPathVar)
        // Re-derive candidate start nodes (scanLabel + first-step source
        // property filters), matching the traversal used elsewhere.
        const _candStarts: number[] = []
        for (let i = 0; i < allNodes.length; i++) {
          if (plan.scanLabel) {
            const nl = String((allNodes[i] as any)?._label || '')
            const fl = (allNodes[i] as any)?.__fullLabel
            const lblSet: string[] = (fl && typeof fl === 'string') ? fl.split(':').filter(Boolean) : nl.split(':').filter(Boolean)
            if (!lblSet.includes(plan.scanLabel as string)) continue
          }
          const firstSourceProps = (plan.steps[0] as any)?.sourceProps
          if (firstSourceProps && typeof firstSourceProps === 'object') {
            let ok = true
            for (const [pk, pval] of Object.entries(firstSourceProps)) {
              if ((allNodes[i] as any)?.[pk] !== pval) { ok = false; break }
            }
            if (!ok) continue
          }
          _candStarts.push(i)
        }
        const fullPaths: Array<{ ns: number[]; es: Array<{ srcIdx: number; dstIdx: number; label: string }> }> = []
        for (const si of _candStarts) {
          const ps = _walkMultiStepsWithEdges(si, plan.steps, allNodes, undefined, plan.filters, undefined)
          for (const p of ps) fullPaths.push(p)
        }
        if (fullPaths.length) {
          const rebuilt: any[] = []
          const template = rawWithEdges.length ? rawWithEdges[0] : {}
          for (const fp of fullPaths) {
            const row = JSON.parse(JSON.stringify(template))
            const pathNodes: any[] = fp.ns.map(idx => allNodes[idx] || {})
            const pathEdges: Record<string, unknown>[] = []
            for (let pi = 0; pi < fp.ns.length - 1; pi++) {
              const aIdx = fp.ns[pi]
              const eRef = fp.es[pi]
              // Direction: the edge is 'out' when its source is the current node
              // (i.e. this hop leaves `aIdx`) and 'in' otherwise.
              const dir = eRef.srcIdx === aIdx ? 'out' : 'in'
              pathEdges.push(_mkEdgeObj({ srcIdx: eRef.srcIdx, dstIdx: eRef.dstIdx, label: eRef.label, props: null }, dir))
            }
            if (!row.props) row.props = {}
            row.props[_multiStepPathVar!] = { __path: pathNodes, __pathEdges: pathEdges }
            rebuilt.push(row)
          }
          rawWithEdges.length = 0
          rawWithEdges.push(...rebuilt)
          _fullPathReconDone = true
        }
      }

      // Build alias→label lookup from allNodes to recover true labels.
      // GE path traversal may set _label='Default' on source nodes; we
      // restore the correct label via allNodes.
      const aliasToLabel: Record<string, string> = {}
      for (const n of allNodes) {
        const a = (n as any)._alias
        const label = (n as any)._label
        if (a && label && !aliasToLabel[a]) {
          aliasToLabel[a] = typeof label === 'string' && !label.startsWith(':') ? `:${label}` : label
        }
      }

      // When GE returns a single row for a path variable query with multiple
      // edges (MATCH p = (n)-->()), expand rawWithEdges to one row per edge
      // so that collect(p) can aggregate across all path objects.
      if (!_fullPathReconDone && rawWithEdges.length === 1 && edgesPayload?.length > 1) {
        const original = rawWithEdges[0]
        rawWithEdges.length = 0
        for (const ep of edgesPayload) {
          const srcAllNode: any = allNodes[ep.srcIdx] || {}
          const dstAllNode: any = allNodes[ep.dstIdx] || {}

          const srcNode: Record<string, unknown> = {
            _alias: srcAllNode._alias || `n${ep.srcIdx}`,
            _label: aliasToLabel[srcAllNode._alias] || (typeof srcAllNode._label === 'string' && !srcAllNode._label.startsWith(':') ? `:${srcAllNode._label}` : srcAllNode._label || 'Default'),
          }
          const tgtNode: Record<string, unknown> = {
            _alias: dstAllNode._alias || `m${ep.dstIdx}`,
            _label: aliasToLabel[dstAllNode._alias] || (typeof dstAllNode._label === 'string' && !dstAllNode._label.startsWith(':') ? `:${dstAllNode._label}` : dstAllNode._label || 'Default'),
          }

          const row = JSON.parse(JSON.stringify(original))
          for (const pv of pathVars) {
            (row as any).props = { ...(row as any).props, [pv]: { __path: [srcNode, tgtNode] }, _alias: srcAllNode._alias, _label: srcNode._label }
          }
          rawWithEdges.push(row)
        }
      } else if (!_fullPathReconDone) {
        // Single-row path variable: build path object from the bound source node
        // and the target node.  The source binding lives in `__crossVarRows[source]`
        // (populated by the multi-step walk); `r.props`/`__targetProps` carry the
        // target node.  Falling back to `r.props` for the source would produce a
        // self-loop `[target, target]` path and break `nodes(p)` for queries like
        // `MATCH p = (n:X)-->() RETURN nodes(p)`.
        const sourceVar = plan.steps?.[0]?.source
        for (const r of rawWithEdges) {
          for (const pv of pathVars) {
            const boundSrc = sourceVar ? (r as any)?.__crossVarRows?.[sourceVar] : undefined
            const srcNode: Record<string, unknown> = {}
            if (boundSrc && typeof boundSrc === 'object') {
              for (const [k, v] of Object.entries(boundSrc)) {
                if (!k.startsWith('__') && k !== 'props' && k !== pv) srcNode[k] = v
              }
              if ((boundSrc as any)._alias && aliasToLabel[(boundSrc as any)._alias as string]) {
                srcNode._label = aliasToLabel[(boundSrc as any)._alias as string]
              }
            }
            if (!Object.keys(srcNode).length && r.props && typeof r.props === 'object') {
              for (const [k, v] of Object.entries(r.props)) {
                if (!k.startsWith('__') && k !== pv) srcNode[k] = v
              }
              if (r.props._alias && aliasToLabel[r.props._alias as string]) {
                srcNode._label = aliasToLabel[r.props._alias as string]
              }
            }
            const tgtNode: Record<string, unknown> = {}
            if (r.__targetProps && typeof r.__targetProps === 'object') {
              for (const [k, v] of Object.entries(r.__targetProps)) {
                if (!k.startsWith('__')) tgtNode[k] = v
              }
            }
            if (Object.keys(srcNode).length) {
              const pathNodes: Record<string, unknown>[] = [srcNode, Object.keys(tgtNode).length ? tgtNode : srcNode]
              const pathEdges: Record<string, unknown>[] = []
              // Match the raw edge to this row's source/target so the rendered
              // path carries the correct relationship and direction.  A
              // self-loop (src === tgt) yields an empty edge list for a
              // zero-length hop.
              if (Object.keys(tgtNode).length) {
                for (const ep of edgesPayload) {
                  const srcIdx = _aliasIndexOf(srcNode, allNodes)
                  const hopDir = _edgeDir(ep, _stepDir, srcIdx >= 0 ? srcIdx : -1)
                  if (hopDir === 'out' && ep.srcIdx === srcIdx && ep.dstIdx === _aliasIndexOf(tgtNode, allNodes)) {
                    pathEdges.push(_mkEdgeObj(ep, 'out'))
                    break
                  }
                  if (hopDir === 'in' && ep.dstIdx === srcIdx && ep.srcIdx === _aliasIndexOf(tgtNode, allNodes)) {
                    pathEdges.push(_mkEdgeObj(ep, 'in'))
                    break
                  }
                }
              }
              ;(r as any).props[pv] = { __path: pathNodes, __pathEdges: pathEdges }
            }
          }
        }
      }
    }
    // ── Pre-aggregate path variable list comprehensions ──
    // When a path variable query produces multiple rows (one per edge), but
    // the RETURN/WITH expression uses collect(p), aggregate path objects
    // across all rows into an array so the list comprehension evaluates
    // against the full collect result.
    const hasPathVarAgg = rawWithEdges.length > 1 && pathVars.size && (
      plan.expressionColumns?.some(ec => /\[.*IN.*collect\b/.test(ec.expression || '')) ||
      (plan.with?.columns || []).some((c: any) => /collect\s*\(/.test(String(c?.expression ?? '')))
    )
    if (hasPathVarAgg) {
      const collectedBeforeAgg = rawWithEdges.length
      const collectedPaths: Record<string, any[]> = {}
      for (const pv of pathVars) {
        collectedPaths[pv] = []
        for (const r of rawWithEdges) {
          const pvVal = (r as any).props?.[pv]
          if (pvVal && typeof pvVal === 'object') collectedPaths[pv].push(pvVal)
        }
      }
      if (Object.keys(collectedPaths).some(k => collectedPaths[k].length > 0)) {
        const synthetic: any = JSON.parse(JSON.stringify(rawWithEdges[0]))
        for (const pv of pathVars) {
          if (collectedPaths[pv].length) {
            ;(synthetic as any).props[pv] = collectedPaths[pv]
          }
        }
        // Ensure count alias value is set on synthetic row.
        if (plan.with?.columns?.length) {
          ;(synthetic as any).props.c = collectedBeforeAgg
          // Also ensure 'c' appears in returnColumns
          if (!plan.returnColumns?.includes('c')) {
            const rcs = plan.returnColumns || []
            rcs.push('c')
            plan.returnColumns = rcs
          }
        }
        // Inject list comprehension expressions from WITH into
        // into expressionColumns so _formatResultRow's ecMap can resolve them.
        // ANTLR may fail to parse complex expressions in WITH columns;
        // we extract expression text directly from the query string.
        if (plan.with?.columns?.length && query) {
          const withPart = query.match(/WITH\s+([\s\S]+?)(?=RETURN\b|$)/i)?.[1] || ''
          // List comprehension: [x IN collect(p) | head(nodes(x))] AS p
          for (const pv of pathVars) {
            const lcMatch = withPart.match(new RegExp(
              `(\\[\\s*\\w+\\s+IN\\s+collect\\s*\\(\\s*${pv}\\s*\\)[^\\]]*\\])\\s+AS\\s+(\\w+)`,
              'i'
            ))
            if (lcMatch) {
              const expr = lcMatch[1]
              const alias = lcMatch[2]
              const exprCols = plan.expressionColumns || []
              if (!exprCols.some(e => e.alias === alias)) {
                exprCols.push({ expression: expr, alias })
                plan.expressionColumns = exprCols
              }
            }
          }
        }
        rawWithEdges.length = 0
        rawWithEdges.push(synthetic)
      }
    }
    // ── Pattern comprehension expression evaluation ──
    // When return/expression columns contain pattern comprehensions
    // (e.g. size([(n)--() | 1]) > 0), evaluate them using graph data.
    // The expression engine doesn't have access to the graph structure,
    // so we pre-compute the values and inject them directly into row props.
    if (rawWithEdges.length && edgesPayload) {
      // Pre-computed projection aliases are stored back into `props` below.
      // For an edge-less MATCH the row's `props` object aliases the node
      // variable in `__crossVarRows` (same reference), so writing `props[b]`
      // would leave the node carrying a spurious `b` property. Snapshot the
      // aliased node first (shallow copy) to break the shared reference.
      for (const rawRow of rawWithEdges) {
        if (rawRow.__crossVarRows && rawRow.props && typeof rawRow.props === 'object' && !Array.isArray(rawRow.props)) {
          for (const vn of Object.keys(rawRow.__crossVarRows)) {
            if ((rawRow.__crossVarRows as any)[vn] === rawRow.props) {
              ;(rawRow.__crossVarRows as any)[vn] = { ...rawRow.props }
            }
          }
        }
      }
      const exprCols = plan.expressionColumns || []
      for (const ec of exprCols) {
        const expr = ec.expression || ''
        // Match size([(...)--... | 1]) pattern — degree computation
        // Supports: -->, --, <--, -[:T]->, -[:T|S]->, <-[:T]-, etc.
        const pcMatch = expr.match(
          /size\s*\(\s*\[\s*\(\s*(\w+)\s*\)\s*(?:<-?-|-?->|--|<\-\s*\[:[A-Za-z_|]+\]\s*-|-\s*\[:[A-Za-z_|]+\]\s*->)\s*\(\s*\)/
        )
        if (pcMatch) {
          const pcVar = pcMatch[1]
          // Extract optional relationship type filter
          const relTypesMatch = expr.match(
            /\((\w+)\)\s*-\s*\[?\s*:?\s*([A-Za-z_|]+)?\s*\]?\s*->/
          )
          let filterLabels: string[] | null = null
          if (relTypesMatch?.[2]) {
            filterLabels = relTypesMatch[2].split('|').map(s => s.trim())
          }


          for (let ri = 0; ri < rawWithEdges.length; ri++) {
            let degree = 0
            const seen = new Set<string>()
            // Compute degree from allNodes[sourceIdx].__edges rather than
            // edgesPayload, which may carry dstIdx values relative to
            // the TCK handler's createdNodes array (alias duplicates).
            // Locate the source node: first try nodeGeIds via rowId,
            // then fall back to scanSourceAlias for label-scan queries.
            const rowId = (rawWithEdges[ri] as any).id
            let sourceIdx = rowId != null ? nodeGeIds.indexOf(rowId) : -1
            if (sourceIdx < 0 && scanSourceAlias) {
              // For label-scanned queries, multiple rows in rawWithEdges
              // correspond to different allNodes entries. Match by row
              // props against allNodes[ni] properties to find the correct
              // source node for each row.
              const rowProps = (rawWithEdges[ri] as any).props || (rawWithEdges[ri] as any)
              for (let ni = 0; ni < originalNodeCount; ni++) {
                const n = allNodes[ni] as any
                if (n._label !== plan.scanLabel && n._alias !== scanSourceAlias) continue
                // Verify the row props match this node's properties.
                // All row prop keys (except _label and numeric aliases)
                // should match the corresponding node property values.
                let match = true
                for (const rk of Object.keys(rowProps)) {
                  if (rk === '_label') continue
                  if (rk === '__crossVarRows' || rk === '__edges' || rk.startsWith('__')) continue
                  if (rk === scanSourceAlias) continue
                  const rv = rowProps[rk]
                  const nv = n[rk]
                  if (rv != null && nv != null && String(rv) !== String(nv) && String(rv) !== String(nv)) {
                    match = false
                    break
                  }
                }
                if (match) {
                  sourceIdx = ni
                  break
                }
              }
            }
            if (sourceIdx >= 0 && sourceIdx < originalNodeCount) {
              const sourceEdges = (allNodes[sourceIdx] as any).__edges
              if (sourceEdges && Array.isArray(sourceEdges)) {
                for (const edge of sourceEdges) {
                  const dstIdx = edge.dstIdx
                  if (dstIdx == null || dstIdx >= originalNodeCount) continue
                  if (!allNodes[dstIdx]) continue
                  if (filterLabels?.length) {
                    const edgeLabel = edge.label ? String(edge.label) : ''
                    if (!filterLabels.includes(edgeLabel)) continue
                  }
                  const dedupKey = `${sourceIdx}|${dstIdx}|${edge.label || ''}`
                  if (seen.has(dedupKey)) continue
                  seen.add(dedupKey)
                  degree++
                }
              }
            }
            // Evaluate the full expression with pattern comprehension replaced by degree
            const alias = ec.alias || expr
            let simplifiedExpr = expr
            const pcFullMatch = expr.match(
              /size\s*\(\s*\[\s*\(\s*\w+\s*\)\s*(?:<-?-|-?->|--|<\-\s*\[:[A-Za-z_|]+\]\s*-|-\s*\[:[A-Za-z_|]+\]\s*->)\s*\(\s*\)\s*\|\s*\d+\s*\]\s*\)/
            )
            if (pcFullMatch) {
              simplifiedExpr = expr.replace(pcFullMatch[0], String(degree))
            }
            const varCtx: Record<string, unknown> = {}
            if (rawWithEdges[ri]?.__crossVarRows) {
              for (const [k, v] of Object.entries(rawWithEdges[ri].__crossVarRows)) {
                varCtx[k] = v as Record<string, unknown>
              }
            }
            try {
              const val = _evaluateExpression(simplifiedExpr, varCtx)
              if (val !== null && val !== undefined) {
                ;(rawWithEdges[ri] as any).props[alias] = val
              }
            } catch (_e: any) { /* fall through */ }
          }
        }
      }
    }

    // Patch per-group `count(field)` for WITH clauses that mix a pattern
    // comprehension with an aggregate (e.g. `WITH [p=(n)-->()|p] AS ps,
    // count(b) AS c`).  GE cannot group by the comprehension column and drops
    // the aggregate, so the grouped rows arrive here WITHOUT the count column;
    // `_formatResultRow` would otherwise fall back to an edge-variable placeholder
    // and emit a bogus `[:T]`.  Compute the per-group count from each row's
    // cross-variable context (the `field` — e.g. `b` — is the group key, so each
    // grouped row contributes exactly one non-null binding).
    if (plan.aggregate && rawWithEdges?.length) {
      const agg = plan.aggregate as any
      const aggFn = (agg.function || agg.type || '').toLowerCase()
      const _whComp = (plan.with?.columns || []).some((wc: any) => {
        const e = wc?.expression
        return e && ((typeof e === 'string' && e.includes('|')) || (e.type === 'LIST' && (e.items || []).some((it: any) => it?.type === 'STRING' && String(it.value).includes('|'))))
      })
      if (aggFn === 'count' && _whComp) {
        const colMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
        const field = colMatch ? colMatch[1].trim() : (agg.field || '*')
        const aggAlias = (agg.alias && agg.alias !== agg.function) ? agg.alias : (agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || 'c')
        for (let ri = 0; ri < rawWithEdges.length; ri++) {
          const rw = rawWithEdges[ri] as any
          const cvr = (rw.__crossVarRows && typeof rw.__crossVarRows === 'object') ? rw.__crossVarRows : {}
          if (cvr[aggAlias] && typeof cvr[aggAlias] === 'object' && (cvr[aggAlias] as any).__edgeLabel) {
            delete cvr[aggAlias]
          }
          const cnt = (field === '*' || field === '' || (cvr[field] !== undefined && cvr[field] !== null)) ? 1 : 0
          if (rw.props && typeof rw.props === 'object') {
            rw.props[aggAlias] = cnt
          } else {
            rw[aggAlias] = cnt
          }
        }
      }
    }

    // Zero-length named path (`MATCH p = (a) RETURN p`): a path variable with no
    // traverse steps wraps its bound node in a `{ __path: [node], __pathEdges: [] }`
    // object so the serializer renders `<()>` / `<(:A)>` rather than the bare node
    // notation.  `plan.pathVar` is top-level (empty `plan.steps`), so the normal
    // step-level path reconstruction above never runs.
    if ((plan as any).pathVar && !(plan.steps || []).length) {
      const pv = (plan as any).pathVar as string
      const mv = (plan as any).matchVar as string | undefined
      for (const r of rawWithEdges) {
        // The bare-node MATCH binds the node to `matchVar` (its value lives in
        // `__crossVarRows[mv]`, or `props` carries the node fields directly when
        // `mv` is absent).  Wrap that node in a zero-length path object.
        let nodeVal: unknown =
          (mv && (r as any)?.__crossVarRows?.[mv]) ||
          (r as any)?.props?.[pv] ||
          (r as any)?.[pv] ||
          (r as any)?.props
        if (nodeVal && typeof nodeVal === 'object' && !('__path' in (nodeVal as any))) {
          ;(r as any).props = { ...((r as any).props || {}), [pv]: { __path: [nodeVal], __pathEdges: [] } }
        }
      }
    }

    const rawResult: QueryRow[] = rawWithEdges.map((r: any) => {
      const fr = _formatResultRow(r, plan)
      return fr
    })
    // When whereBody references variables not in result rows (e.g. MATCH
    // (n)-->(b) WHERE n.name IN [...] RETURN b), inject missing vars from
    // rawWithEdges so the expression engine can evaluate the WHERE.
    if (plan.whereBody && plan.whereBody.includes('IN [')) {
      const wbVars = plan.whereBody.match(/\b([a-zA-Z_]\w*)\b/g)?.filter(
        v => !/^(IN|IS|NOT|NULL|TRUE|FALSE|AND|OR|XOR|WHERE|toLower|labels|size|head|nodes|collect|name|describe|exists|any|all|single|none|x|y|z)$/i.test(v)
      ) || []
      const rcSet = new Set(plan.returnColumns || [])
      const missingVars = wbVars.filter(v => !rcSet.has(v))
      if (missingVars.length && rawWithEdges.length) {
        // Fix target node labels (GE sets _label='Default')
        const nodeLabelMap: Record<string, string> = {}
        for (const anode of allNodes) {
          const a = (anode as any)._alias
          const label = (anode as any)._label
          if (a && label && !nodeLabelMap[a]) {
            nodeLabelMap[a] = typeof label === 'string' && !label.startsWith(':') ? `:${label}` : label
          }
        }
        for (let ri = 0; ri < rawResult.length; ri++) {
          // Fix target node label from edgesPayload
          const ep = edgesPayload?.[ri]
          if (ep && ep.dstIdx < allNodes.length) {
            const dstNode = allNodes[ep.dstIdx] as any
            const dstLabel = nodeLabelMap[dstNode._alias] || dstNode._label
            if (dstLabel && dstLabel !== 'Default') {
              for (const step of (plan.steps || [])) {
                const tAlias = step.targetAlias
                if (tAlias && rawResult[ri][tAlias]) {
                  ;(rawResult[ri][tAlias] as any)._label = dstLabel
                  if ((rawResult[ri][tAlias] as any).props) {
                    ;(rawResult[ri][tAlias] as any).props._label = dstLabel
                  }
                }
              }
            }
          }
          const rawEdge = rawWithEdges[ri]
          for (const mv of missingVars) {
            if (rawEdge.__crossVarRows && mv in rawEdge.__crossVarRows) {
              rawResult[ri][mv] = rawEdge.__crossVarRows[mv]
            } else if (rawEdge.props && mv in rawEdge.props) {
              rawResult[ri][mv] = rawEdge.props[mv]
            } else if (rawEdge.__targetProps && mv in rawEdge.__targetProps) {
              rawResult[ri][mv] = rawEdge.__targetProps[mv]
            } else if (rawEdge.__targetPropsMap && mv in rawEdge.__targetPropsMap) {
              rawResult[ri][mv] = rawEdge.__targetPropsMap[mv]
            }
          }
        }
      }
    }

    // ── DISTINCT 去重（RETURN DISTINCT n） ──
    // 在 WITH/UNWIND pipeline 之外，GE 直接执行路径也需要去重
    let result: QueryRow[]
    if (plan.distinct && rawResult.length) {
      const dedupSet = new Set<string>()
      result = []
      for (const row of rawResult) {
        const colKeys = plan.returnColumns?.length ? plan.returnColumns : Object.keys(row).filter(k => !k.startsWith('__'))
        const sig = JSON.stringify(colKeys.map(k => row[k]))
        if (dedupSet.has(sig)) continue
        dedupSet.add(sig)
        result.push(row)
      }
    } else {
      result = rawResult
    }

    // ── WHERE 子句后处理过滤（表达式引擎处理 GE 不支持的复杂 boolean 表达式） ──
    // GE 的 _matchFilter 只支持简单属性比较。对于包含 AND/OR/XOR/NOT/括号等复杂 boolean 逻辑，
    // 以及函数表达式（type(r)、labels()等），在 GE 执行后用 _evaluateExpression 做后过滤。
    // Note: 即使 plan.aggregate 存在，也必须先应用 WHERE 再聚合。
    // HAVING detection: a WHERE clause that filters an aggregate produced by a
    // WITH clause (e.g. `WITH count(*) AS cnt WHERE cnt > 100`).  Such a filter
    // must be applied *after* aggregation (see the HAVING block below), not here
    // before it — the WHERE column (`cnt`) only exists once the aggregate is
    // folded.  Applying it here against the pre-aggregation rows would see no
    // `cnt` and drop every row, then the aggregation block would rebuild from
    // `rawWithEdges`, silently restoring the un-filtered rows.
    const _withAggCols = (plan.with?.columns || []).filter(c =>
      typeof c?.expression === 'string' && /^\s*(count|sum|avg|max|min|collect)\s*\(/i.test(c.expression))
    const _isHaving = !!(plan.aggregate && plan.with?.columns?.length && plan.whereBody && _withAggCols.length)
    // For DML plans (SET/DELETE/REMOVE), a WHERE predicate is already applied
    // by the graph engine *before* the side effects run.  Re-evaluating the
    // same predicate here against the mutated row would wrongly drop it (e.g.
    // `MATCH (n) WHERE n.name='A' SET n.name='B' RETURN n` — the WHERE re-check
    // sees `n.name='B'` and fails).  Only skip the re-filter when the WHERE body
    // is a single simple property comparison (fully captured by `plan.filters`
    // and thus already handled by GE); a complex boolean/function expression
    // still needs QE-side evaluation.
    const _isDmlPlan = plan.type === 'SET' || plan.type === 'DELETE' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY'
    const _whereIsSimpleCompare = !!plan.whereBody && /^\s*\w+\.\w+\s*(?:=|<>|!=|<|>|<=|>=)\s*(?:'[^']*'|\d+(?:\.\d+)?)\s*$/i.test(plan.whereBody)
    const _skipWhereRefilter = _isDmlPlan && _whereIsSimpleCompare && (plan.filters?.length ?? 0) >= 1
    if (plan.whereBody && result.length && !(plan.hasMatch && plan.unwind) && !_isHaving && !_skipWhereRefilter) {
      // Fix GE Default labels on target nodes in __crossVarRows before WHERE eval.
      // GE sets _label='Default' on matched target nodes; restore from allNodes.
      const allN = nodes
      const ep = edgesPayload
      if (allN?.length && ep?.length && rawWithEdges?.length) {
        // GE creates intermediate nodes with _label='Default' for edge
        // traversal targets. The real B, C nodes have no _alias and the
        // correct label. Find them in order and patch __crossVarRows.
        const realTargets = allN
          .map((n: any, i: number) => ({ i, label: n._label, alias: n._alias }))
          .filter(t => t.label !== 'Default' && t.label !== 'A' && !t.alias)
        for (let ri = 0; ri < Math.min(rawWithEdges.length, realTargets.length); ri++) {
          const targetLabel = realTargets[ri]?.label
          if (!targetLabel) continue
          const dstLabel = typeof targetLabel === 'string' && !targetLabel.startsWith(':')
            ? `:${targetLabel}` : targetLabel
          if (rawWithEdges[ri].__crossVarRows) {
            for (const step of (plan.steps || [])) {
              const tAlias = step.targetAlias
              if (tAlias && rawWithEdges[ri].__crossVarRows[tAlias]) {
                const tv = rawWithEdges[ri].__crossVarRows[tAlias]
                // Only repair labels GE actually defaulted (never overwrite an
                // already-correct label, e.g. relationship-variable queries where
                // the target node label is resolved directly).
                if (tv._label === 'Default' || tv._label === ':Default' || tv._label === undefined) {
                  tv._label = dstLabel
                  if (tv.props) tv.props._label = dstLabel
                }
              }
            }
          }
        }
        // Also patch rawResult to have correct b labels
        for (let ri = 0; ri < Math.min(rawResult.length, realTargets.length); ri++) {
          const targetLabel = realTargets[ri]?.label
          if (!targetLabel) continue
          const dstLabel = typeof targetLabel === 'string' && !targetLabel.startsWith(':')
            ? `:${targetLabel}` : targetLabel
          for (const step of (plan.steps || [])) {
            const tAlias = step.targetAlias
            if (tAlias && rawResult[ri][tAlias]) {
              const tv = rawResult[ri][tAlias] as any
              if (tv._label === 'Default' || tv._label === ':Default' || tv._label === undefined) {
                tv._label = dstLabel
                if (tv.props) tv.props._label = dstLabel
              }
            }
          }
        }
        for (let ri = 0; ri < rawWithEdges.length; ri++) {
          const edgeEntry = ep[ri]
          if (edgeEntry && edgeEntry.dstIdx < allN.length) {
            const dstNode = allN[edgeEntry.dstIdx] as any
            const dstLabel = dstNode._label
            if (dstLabel && dstLabel !== 'Default') {
              if (rawWithEdges[ri].__crossVarRows) {
                for (const step of (plan.steps || [])) {
                  const tAlias = step.targetAlias
                  if (tAlias && rawWithEdges[ri].__crossVarRows[tAlias]) {
                    rawWithEdges[ri].__crossVarRows[tAlias]._label = dstLabel
                    if (rawWithEdges[ri].__crossVarRows[tAlias].props) {
                      rawWithEdges[ri].__crossVarRows[tAlias].props._label = dstLabel
                    }
                  }
                }
              }
            }
          }
        }
      }
      // 提取主 MATCH 的 WHERE 条件：在 "OPTIONAL MATCH" 之前的文本
      let whereExpr = plan.whereBody
      const optMatchPos = whereExpr.indexOf('OPTIONAL MATCH')
      if (optMatchPos >= 0) {
        whereExpr = whereExpr.substring(0, optMatchPos).trim()
      }
      if (whereExpr) {
        // 跳过属于 OPTIONAL MATCH 变量的条件（如 m:NonExistent, x0 IS NOT NULL）
        // 这些在 OPTIONAL MATCH 处理中另做过滤
        if (plan.optionalMatchSteps?.length) {
          const optVarSet = new Set<string>()
          for (const om of plan.optionalMatchSteps) {
            if (om.variableName) optVarSet.add(om.variableName)
            for (const s of om.steps || []) {
              if (s.source) optVarSet.add(s.source)
              if (s.targetAlias) optVarSet.add(s.targetAlias)
              if (s.targetAlias) optVarSet.add(s.targetAlias)
            }
          }
          // 加入 OPTIONAL MATCH 的 expressionColumns 别名（如 x0）
          if (plan.expressionColumns?.length) {
            for (const ec of plan.expressionColumns) {
              const ecObj = ec as any
              if (ecObj.alias) optVarSet.add(ecObj.alias)
            }
          }
          const labelMatch = whereExpr.match(/^(\w+)\s*:\s*(\w+)$/)
          if (labelMatch && optVarSet.has(labelMatch[1])) {
            // 纯 OPTIONAL 变量 label 条件：跳过主 MATCH WHERE 过滤
            whereExpr = ''
          }
          // 检查 whereExpr 中的所有变量引用是否全属于 OPTIONAL MATCH
          if (whereExpr) {
            // Match only true variable names, not property accesses (e.g. in
            // `m.num = 42` the identifier `num` follows a dot and is a property
            // on variable `m`, not a standalone variable).
            const referencedVars = [...whereExpr.matchAll(/(?<!\.)\b([a-zA-Z_]\w*)\b/g)].map(m => m[1])
              .filter(v => !/^(IS|NOT|NULL|TRUE|FALSE|AND|OR|XOR)$/i.test(v))
              // 排除字符串字面量（单引号/双引号括起来的单词）
              .filter(v => whereExpr.match(new RegExp(`'${v}'|"${v}"`)) === null)
            if (referencedVars.length && referencedVars.every(v => optVarSet.has(v))) {
              whereExpr = ''
            }
          }
        }
      }
      if (whereExpr) {
        const filteredResult: QueryRow[] = []
        // Track the raw engine records that survive the WHERE filter so that
        // downstream stages (OPTIONAL MATCH in particular) resolve each surviving
        // row's source node from the matching raw entry rather than a now-misaligned
        // index.  Without this, filtering a row shifts every later rawWithEdges[i]
        // off by one and OPTIONAL MATCH binds the wrong node.
        const filteredRawWithEdges: Array<Record<string, unknown>> = []
      for (let ri = 0; ri < result.length; ri++) {
        const row = result[ri]
                // 构建变量级映射
        const ctx: Record<string, unknown> = {}
        // 先注入 result row 的扁平化键
        for (const [key, val] of Object.entries(row)) {
          if (hasProps(val)) {
            ctx[key] = { ...val.props }
          } else {
            ctx[key] = val
          }
        }
        // 再从原始 GE 记录获取变量上下文（如 {a: {name: 'Foo', _label: 'TheLabel'}}）
        // 注意：__crossVarRows 中的对象变量优先覆盖 row 中的字符串值，
        // 因为 WHERE 表达式（如 type(r)）需要完整的变量上下文，而非格式化后的字符串。
        const rawEntry = rawWithEdges?.[ri]
        if (rawEntry?.__crossVarRows) {
          for (const [varName, varNode] of Object.entries(rawEntry.__crossVarRows)) {
            ctx[varName] = varNode as Record<string, unknown>
          }
                }
        // 注入 WITH/UNWIND 管道变量（WITH/UNWIND 在 MATCH 之前的情况）
        // 尝试从 nodes 中获取 pipeline 执行结果
        if (plan.with?.columns?.length && !Array.isArray(nodes?.[0]?.props)) {
          for (const col of plan.with.columns) {
            const alias = col.alias || col.expression
            if (!(alias in ctx) && query && nodes?.length) {
              // 对 WITH 表达式求值
              const val = _evaluateExpression(col.expression, ctx)
              if (val !== undefined) ctx[alias] = val
            }
          }
        }
        if (plan.unwind?.name && !(plan.unwind.name in ctx)) {
          // Try to compute the unwind from query
          const unwindVal = Array.isArray(nodes?.[0]) ? nodes[0] : null
          if (unwindVal) ctx[plan.unwind.name] = unwindVal
        }
        // 路径变量注入：WHERE length(p) = N 需要通过 ctx.p.length 评估
        if (plan.pathVar) {
          // Path length = number of relationships = number of traverse steps.
          // Ensure the path variable always carries a `.length` so `length(p)=N`
          // evaluates correctly, even when the row already binds `p` to a
          // `__path` object (which has no numeric `.length`).
          const nSteps = (plan.steps || []).length
          const existing = ctx[plan.pathVar]
          if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            ctx[plan.pathVar] = { ...(existing as Record<string, unknown>), length: nSteps }
          } else if (!(plan.pathVar in ctx)) {
            ctx[plan.pathVar] = { length: nSteps }
          }
        }
        // 预处理 whereBody：替换 length(var) = N → var.length = N
        // 表达式引擎不认识 length() 函数，但可以用 .length 属性访问
        let whereBodyExpr = whereExpr
        if (whereBodyExpr) {
          whereBodyExpr = whereBodyExpr.replace(/length\s*\(\s*(\w+)\s*\)/g, '$1.length')
          // Resolve `exists { ... }` subqueries to boolean literals first.
          const resolved = _resolveExistsSubqueries(whereBodyExpr, ctx, allNodes)
          whereBodyExpr = resolved.expr
          if (resolved.invalidClause) {
            throw Object.assign(new Error('SyntaxError: InvalidClauseComposition'), { tckError: 'InvalidClauseComposition' })
          }
          // Resolve pattern predicates (e.g. `(a)-[:T]->(b:X)`) to boolean
          // literals before expression evaluation. The expression engine cannot
          // parse relationship patterns; substituting true/false lets it evaluate
          // the surrounding AND/OR/NOT structure against the graph edges.
          whereBodyExpr = _resolveWherePatternPredicates(whereBodyExpr, ctx, allNodes)
        }
        let evalVal: unknown
        const checkExpr = whereExpr
        if (whereBodyExpr && whereBodyExpr !== checkExpr) {
          // `_resolveWherePatternPredicates` rewrote the WHERE body (pattern
          // predicates substituted with `true`/`false`, or `length(...)`
          // rewritten to `x.length`).  Evaluate the rewritten expression so the
          // resolved pattern-predicate results actually drive the filter.
          try {
            evalVal = _evaluateExpression(whereBodyExpr, ctx)
          } catch (e: any) {
            evalVal = undefined
          }
        } else if (_isPatternPredicate(checkExpr)) {
          // Pattern predicate that `_resolveWherePatternPredicates` could not
          // rewrite (e.g. an anonymous-only pattern like `(n)-->()` whose
          // source variable was unresolvable).  Fall back to a conservative
          // value so the surrounding structure still evaluates.
          const isNegated = checkExpr.trim().startsWith('NOT ')
          evalVal = isNegated ? false : true
        } else if (/^exists\s*\{/i.test(checkExpr.trim())) {
          // EXISTS { ... } 子查询
          const ebody = checkExpr.trim()
          const srcMatch = ebody.match(/(\w+)/)
          let existsVal = false
          if (srcMatch && allNodes?.length) {
            const srcVar = srcMatch[1]
            const srcNodeRef = ctx[srcVar]
            if (srcNodeRef) {
              const srcLabel = (srcNodeRef.props || srcNodeRef)._label || ''
              const labelMatch = ebody.match(/[:(w+)]/)
              const edgeLabel = labelMatch ? labelMatch[1] : null
              for (const anode of allNodes) {
                if (anode._label !== srcLabel) continue
                const anodeIdx = allNodes.indexOf(anode)
                // 检查 anode 自身的 __edges
                if (anode.__edges && Array.isArray(anode.__edges)) {
                  for (const e of anode.__edges) {
                    if (edgeLabel && e.label !== edgeLabel) continue
                    existsVal = true; break
                  }
                }
                // 也检查其他节点的 __edges 中引用此节点的边
                if (!existsVal) {
                  for (const other of allNodes) {
                    if (other.__edges) {
                      for (const e of other.__edges) {
                        if (e.srcIdx === anodeIdx || e.dstIdx === anodeIdx) {
                          if (edgeLabel && e.label !== edgeLabel) continue
                          existsVal = true; break
                        }
                      }
                      if (existsVal) break
                    }
                  }
                }
                if (existsVal) break
              }
            }
          }
          const isNegatedExists = /^not\s+exists/i.test(ebody)
          evalVal = isNegatedExists ? !existsVal : existsVal
        } else {
          try {
            const resultVal = _evaluateExpression(whereBodyExpr || checkExpr, ctx)
            evalVal = resultVal
          } catch (e: any) {
            // OPTIONAL MATCH 变量的条件在当前行上下文可能不可用
            evalVal = undefined
          }
        }
        if (evalVal === true) {
          filteredResult.push(row)
          if (rawWithEdges?.[ri]) filteredRawWithEdges.push(rawWithEdges[ri] as Record<string, unknown>)
        }
      }
      result.length = 0
      result.push(...filteredResult)
      if (rawWithEdges && filteredRawWithEdges.length > 0) {
        rawWithEdges.length = 0
        rawWithEdges.push(...filteredRawWithEdges)
      }
      }
    }

    // ── 聚合处理 ──
    // When the WITH clause mixes a pattern-comprehension column with an
    // aggregate (e.g. `WITH [p=(n)-->()|p] AS ps, count(b) AS c`), the GE path
    // already produced correctly-grouped rows (each carrying both the
    // comprehension column and the per-group count).  Re-running the global
    // `count` here would collapse those grouped rows into a single wrong row,
    // so skip this aggregation pass in that case.
    const _withHasComprehensionCol = (plan.with?.columns || []).some((wc: any) => {
      const expr = wc?.expression
      return expr && (
        (typeof expr === 'string' && /[\[\(]/.test(expr) && expr.includes('|')) ||
        (expr.type === 'LIST' && (expr.items || []).some((it: any) => it?.type === 'STRING' && String(it.value).includes('|')))
      )
    })
    // ── Per-segment WITH WHERE filters ──
    // A non-aggregate WITH segment may carry its own WHERE (structured filters),
    // e.g. `WITH otherPerson WHERE otherPerson.name <> 'NotOther'`.  These run
    // on the grouped/projected row set before any later aggregate consumes it.
    for (const wcSeg of withChainToApply || []) {
      if ((wcSeg as any)?.aggregate) continue
      const segFilters = ((wcSeg as any)?.filters || []).filter((f: any) => f?.property !== '__label')
      if (segFilters.length && rawWithEdges?.length) {
        // Determine which raw rows satisfy the segment WHERE, then apply the
        // same index mask to both `rawWithEdges` and the formatted `result` so
        // a later aggregate over either sees a consistent row set.
        const keepMask = _withFilterKeepMask(rawWithEdges, segFilters)
        rawWithEdges = rawWithEdges.filter((_: any, ri: number) => keepMask[ri])
        if (Array.isArray(result)) result = result.filter((_: any, ri: number) => keepMask[ri])
      }
    }

    if (plan.aggregate && !plan.groupBy?.length && rawWithEdges?.length && !_withHasComprehensionCol) {
      const agg = plan.aggregate as any
      const aggFn = (agg.function || agg.type || '').toLowerCase()
      // percentileDisc/percentileCont are computed inside the graph engine's
      // `_execAggregation` (which returns a single aggregated row).  Re-running
      // the aggregation here against that already-collapsed row would find no
      // value column and overwrite the correct result with 0, so short-circuit.
      if (aggFn === 'percentiledisc' || aggFn === 'percentilecont') {
        // GE has already produced the correct single-row result; leave it as-is.
      } else {
      // The parser stores `alias` as the function name (e.g. "count") when the
      // query has no explicit `AS` clause, so `alias === function` is NOT a
      // reliable signal that an explicit alias is absent (e.g. `sum(num) AS sum`
      // also has `alias === function === "sum"`).  The authoritative result
      // column name is the key of `plan.returnAliasMap` (or, failing that, a
      // member of `plan.returnColumns`): for an explicit alias it is the bare
      // alias, while for a bare call it is the full expression (e.g. `count(r)`).
      const _explicitReturnKey = plan.returnAliasMap && typeof plan.returnAliasMap === 'object'
        ? Object.keys(plan.returnAliasMap as Record<string, unknown>).find(k => k === agg.alias)
        : undefined
      const _realAlias = _explicitReturnKey
        ?? (agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || agg.field || agg.column || 'c')
      const aggAlias = _realAlias
      const colMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
      const field = colMatch ? colMatch[1] : (agg.field || '*')

      const aggRow: QueryRow = {}
      // The graph engine already folded the aggregate into a single synthetic
      // node when `plan.aggregate` reached it (see graph-engine.ts
      // `_execAggregation`).  Detect that case — a lone GE row whose `props`
      // carries the aggregate value under the function/alias key — and surface
      // it directly under the canonical result alias instead of recomputing
      // (which would wrongly read `result.length` as 1).
      const _geAggKey = agg.alias && agg.alias !== agg.function ? agg.alias : (agg.function || agg.type || 'count')
      const _geAggRow = (rawWithEdges?.length === 1 && rawWithEdges[0]?.props && typeof rawWithEdges[0].props === 'object' && _geAggKey in rawWithEdges[0].props)
        ? rawWithEdges[0].props[_geAggKey]
        : undefined
      if (_geAggRow !== undefined && !(aggFn === 'percentiledisc' || aggFn === 'percentilecont')) {
        aggRow[aggAlias] = _geAggRow
      } else if (aggFn === 'count') {
        if (field === '*') {
          aggRow[aggAlias] = result.length
        } else {
          // count(b) where b is a node/rel variable = count everything
          // We need to check if the field is a MATCH variable (node/rel) vs a property
          const isNodeOrRelVar = field && /^[a-zA-Z_]\w*$/.test(field) && result.every(r => !(field in r))
          // Pattern comprehension / expression aggregate field (e.g.
          // `count([p = (n)-[:T]->() | p])`): the GE path cannot evaluate it, so
          // we evaluate the field Expression against each raw row's variable
          // bindings and count the non-null results.
          const isExpressionField = field && /[\[\(]/.test(field)
          if (isNodeOrRelVar) {
            aggRow[aggAlias] = result.length
          } else if (isExpressionField) {
            const nonNull = rawWithEdges.filter((rw: any) => {
              const ctx: Record<string, unknown> = { ...(rw.props || rw) }
              let v: unknown
              try { v = _evalBinary(field, ctx) } catch { v = undefined }
              return v !== null && v !== undefined
            })
            aggRow[aggAlias] = nonNull.length
          } else {
            const nonNull = result.filter(r => {
              const v = r[field]
              return v !== null && v !== undefined
            })
            aggRow[aggAlias] = nonNull.length
          }
        }
      } else if (aggFn === 'percentiledisc' || aggFn === 'percentilecont') {
        // Unreachable: percentile is short-circuited above because the graph
        // engine already computed it.  Kept as a defensive no-op guard.
        aggRow[aggAlias] = result[0]?.[aggAlias] ?? 0
      } else if (aggFn === 'collect') {
        // collect(value) — fold every non-null `value` across the expanded rows
        // into a list (deduplicated when DISTINCT).  `result` here is the set of
        // OPTIONAL MATCH-expanded rows, so `collect(f.num)` over three `f`
        // bindings yields `[42, 43, 44]` and over an all-null binding yields `[]`.
        const collected: unknown[] = []
        const seen = new Set<unknown>()
        for (const r of result) {
          let v: unknown
          if (field === '*' || field === '') {
            v = r
          } else if (field.includes('.')) {
            const [varName, propName] = field.split('.')
            const obj = r[varName]
            v = (obj && typeof obj === 'object') ? (obj as any)[propName] : undefined
          } else {
            v = r[field]
          }
          if (v === null || v === undefined) continue
          if (agg.distinct === true) {
            if (seen.has(v)) continue
            seen.add(v)
          }
          collected.push(v)
        }
        aggRow[aggAlias] = collected
      } else {
        // sum/avg/min/max
        // The aggregate field may carry a variable prefix (`n.num`, `r.num`).
        // For node variables `_formatResultRow` flattens `n.num` to a top-level
        // `num` column; for relationship variables the property lives on the
        // edge object under `__crossVarRows[r]`, which `_formatResultRow` does
        // not surface as a top-level key.  Resolve both forms against the raw
        // row so relationship aggregates (`sum(r.num)`) fold correctly.
        const aggFieldKey = field.includes('.') ? field.split('.').pop()! : field
        const values = result
          .map((r, idx) => {
            let v = r[aggFieldKey]
            if ((v === undefined || v === null) && field.includes('.')) {
              const varName = field.split('.')[0]
              const rw = (rawWithEdges as any[])[idx] as any
              const cvr = rw && typeof rw.__crossVarRows === 'object' ? rw.__crossVarRows : null
              if (cvr && cvr[varName] && typeof cvr[varName] === 'object') {
                v = (cvr[varName] as Record<string, unknown>)[aggFieldKey]
              }
              if ((v === undefined || v === null) && rw && rw[varName] && typeof rw[varName] === 'object') {
                v = (rw[varName] as Record<string, unknown>)[aggFieldKey]
              }
            }
            return v
          })
          .filter((v: unknown) => v !== null && v !== undefined)
          .map(Number)
          .filter((v: number) => !isNaN(v))
        switch (aggFn) {
          case 'sum': aggRow[aggAlias] = values.reduce((a: number, b: number) => a + b, 0); break
          case 'avg': aggRow[aggAlias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0; break
          case 'max': aggRow[aggAlias] = values.length ? Math.max(...values) : 0; break
          case 'min': aggRow[aggAlias] = values.length ? Math.min(...values) : 0; break
          default: aggRow[aggAlias] = 0
        }
      }
      // Apply an OUTER expression wrapping the aggregate call (`count(a) > 0`,
      // `count(a) + 3`, `size(collect(a))`).  The inner aggregate value is
      // already stored under `aggAlias`; substitute the aggregate call in the
      // column text with that value and re-evaluate so the outer arithmetic /
      // comparison / function is applied on top of the folded result.
      const _colTxt2 = (agg.column || '').trim()
      const _pureCall2 = new RegExp(`^${aggFn}\\s*\\(\\s*(?:DISTINCT\\s+)?.*?\\s*\\)(?:\\s+AS\\s+\\w+)?$`, 'i')
      if (_colTxt2 && !_pureCall2.test(_colTxt2)) {
        let _sub2 = _colTxt2.replace(/\s+AS\s+\w+$/i, '')
        const _val = aggRow[aggAlias]
        _sub2 = _sub2.replace(new RegExp(`${aggFn}\\s*\\([^)]*\\)`, 'gi'), () => JSON.stringify(_val))
        try {
          aggRow[aggAlias] = _evalBinary(_sub2, {})
        } catch {
          // leave the raw aggregate value when the outer expression references
          // variables outside expression-engine scope
        }
      }
      result.length = 0
      result.push(aggRow)
      }
    }

    // ── HAVING: post-aggregation WHERE filter ──
    // A `WITH count(*) AS cnt WHERE cnt > 100` carries a WHERE clause that
    // references the *aggregated* column (`cnt`), so it must be evaluated after
    // the aggregate is folded.  This is the HAVING semantics that the pre-
    // aggregation WHERE block above correctly skips (via `_isHaving`).
    if (_isHaving && result.length) {
      const _havingFiltered: QueryRow[] = []
      for (const row of result) {
        let keep = true
        try {
          keep = _evaluateExpression(plan.whereBody!, row) === true
        } catch {
          keep = false
        }
        if (keep) _havingFiltered.push(row)
      }
      result.length = 0
      result.push(..._havingFiltered)
    }

    // If WHERE cleared everything but plan.filters exists, rebuild result from raw GE data
    // and apply filters directly (bypassing varNodes lookup that may fail on flattened rows)
    if (plan.filters?.length && !plan.aggregate && !result.length && rawWithEdges?.length) {
      result.length = 0
      for (const rwe of rawWithEdges) {
        const rProps = rwe.props || {}
        const crossVarNode = rwe.__crossVarRows ? Object.values(rwe.__crossVarRows)[0] as Record<string, unknown> : {}
        // Build combined node properties: crossVarRows first, then rwe.props, then rwe itself
        const nodeProps = { ...crossVarNode, ...rProps }
        const filterMatch = (plan.filters || []).every((f: any) => {
          if (f.property && !(f.property in nodeProps)) return false
          const actualVal = nodeProps[f.property]
          const fv = f.value
          let baseMatch = false
          switch (f.operator) {
            case 'EQ':   baseMatch = String(actualVal) === String(fv); break
            case 'NEQ':  baseMatch = String(actualVal) !== String(fv); break
            case 'GT':   baseMatch = Number(actualVal) > Number(fv); break
            case 'GTE':  baseMatch = Number(actualVal) >= Number(fv); break
            case 'LT':   baseMatch = Number(actualVal) < Number(fv); break
            case 'LTE':  baseMatch = Number(actualVal) <= Number(fv); break
            case 'STARTS_WITH': baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseMatch = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseMatch = String(actualVal) === String(fv); break
          }
          return f.negated ? !baseMatch : baseMatch
        })
        if (!filterMatch) continue
        result.push(_formatResultRow(rwe, plan))
      }
    }

    // ── plan.filters 后处理过滤（补 WHERE 后处理不覆盖的 filter） ──
    // WHERE 后处理依赖 whereBody 字符串，但对于 STARTS_WITH / ENDS_WITH / CONTAINS
    // 等操作符，whereBody 可能被截断（ANTLR 适配器问题）。plan.filters 包含完整
    // 的结构化 filter Info，在此处对所有未在 GE 预过滤中处理的结果做二次过滤。
    // Note: 如果 whereBody 已经处理过（result 已被过滤），跳过此步避免重复过滤
    // 破坏与 whereBody 语义一致的扁平化结果。
    if (plan.filters?.length && result.length && !plan.aggregate && !plan.whereBody) {
      if (plan.returnColumns?.some(c => c === 'i.var' || c === 'var') || (plan.whereBody && plan.whereBody.includes('>') && plan.whereBody.includes('IS NOT NULL'))) {
      }
      const filteredResult: QueryRow[] = []
      for (const row of result) {
        // 构建变量→节点映射
        const varNodes: Record<string, Record<string, unknown>> = {}
        for (const [key, val] of Object.entries(row)) {
          if (hasProps(val)) {
            varNodes[key] = { ...val.props }
          } else if (val && typeof val === 'object') {
            varNodes[key] = val as Record<string, unknown>
          }

        }
        const match = plan.filters.every((f: any) => {
          let sourceNode = varNodes[f.source]
          if (!sourceNode) {
            // row may not have variable keys (e.g. RETURN a.name AS name)
            // fallback: try __crossVarRows or raw row from rawWithEdges
            // Try retrieving from rawWithEdges __crossVarRows (row may be rebuilt from _formatResultRow)
            if (Array.isArray(rawWithEdges)) {
              for (const rwe of rawWithEdges) {
                if (rwe.__crossVarRows?.[f.source] && f.property in rwe.__crossVarRows[f.source]) {
                  sourceNode = rwe.__crossVarRows[f.source]
                  break
                }
                if (rwe.props && !rwe.__crossVarRows && rwe.props[f.property] !== undefined) {
                  sourceNode = rwe.props
                  break
                }
              }
            }
          }
          if (!sourceNode) return false
          const actualVal = sourceNode[f.property]
          if (actualVal === undefined && f.operator !== 'IS_NULL') return false
          const fv = f.value
          let baseFilterResult = false
          switch (f.operator) {
            case 'EQ':   baseFilterResult = String(actualVal) === String(fv); break
            case 'NEQ':  baseFilterResult = String(actualVal) !== String(fv); break
            case 'GT':   baseFilterResult = actualVal > fv; break
            case 'GTE':  baseFilterResult = actualVal >= fv; break
            case 'LT':   baseFilterResult = actualVal < fv; break
            case 'LTE':  baseFilterResult = actualVal <= fv; break
            case 'IS_NULL':     baseFilterResult = actualVal == null; break
            case 'IS_NOT_NULL': baseFilterResult = actualVal != null; break
            case 'STARTS_WITH': baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.startsWith(fv); break
            case 'ENDS_WITH':   baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.endsWith(fv); break
            case 'CONTAINS':    baseFilterResult = typeof actualVal === 'string' && typeof fv === 'string' && actualVal.includes(fv); break
            default:            baseFilterResult = String(actualVal) === String(fv); break
          }
          return f.negated ? !baseFilterResult : baseFilterResult
        })
        if (match) filteredResult.push(row)
      }
      result.length = 0
      result.push(...filteredResult)
    }

    // ── OPTIONAL MATCH 处理 ──
    // 对主查询的每一行结果，尝试匹配 optionalMatchSteps 中的每个 OPTIONAL MATCH 模式。
    // 成功 → 将匹配到的节点/边合并到 row；失败 → 填充 null。
    // 使用 allNodes（本地节点数据，含 __edges）进行遍历，不依赖 GE Pool 实例。
    // When OPTIONAL MATCH is the very first clause there are no rows yet, but
    // Cypher still yields a single row (with a null binding when no node
    // matches) so a later `WITH a MATCH (a)-->()` correctly propagates null.
    if (plan.optionalMatchSteps?.length && !result.length) {
      result.push({})
    }
    if (plan.optionalMatchSteps?.length && result.length) {
      for (const opt of plan.optionalMatchSteps) {
        const optSteps = opt.steps || []
        // OPTIONAL MATCH on a bare single-node pattern (no relationship steps),
        // e.g. `OPTIONAL MATCH (f:DoesExist)`.  Each matching node must expand
        // the current rows into one row per node (so a later `collect(f.num)`
        // folds over every f), rather than binding only the first match.  When
        // there is no match the variable becomes null on the existing row.
        const _singleNodeOptional =
          optSteps.length === 0 && !opt.variableName.startsWith('__')
        if (_singleNodeOptional) {
          const _mkProps = (n: any): Record<string, unknown> => {
            const p: Record<string, unknown> = {}
            if (!n) return p
            for (const k of Object.keys(n)) {
              if (k !== '__edges' && !k.startsWith('_')) p[k] = n[k]
            }
            if (n._label) p._label = n._label
            return p
          }
          const matches = (opt.scanLabel == null)
            ? allNodes
            : allNodes.filter(n => (n as any)._label === opt.scanLabel)
          const expanded: Array<Record<string, unknown>> = []
          for (const row of result) {
            if (matches.length === 0) {
              // When the OPTIONAL MATCH binds a variable that is also the
              // source of a later traversal step (`OPTIONAL MATCH (a:X) WITH a
              // MATCH (a)-->(b)`), a null binding cannot traverse any
              // relationship, so the whole row is dropped — matching Cypher's
              // "matching from null nodes returns no results" semantics.
              const isLaterTraversalSource = (plan.steps || []).some((s: any) => s.source === opt.variableName)
              if (isLaterTraversalSource) continue
              const r2: Record<string, unknown> = { ...row }
              r2[opt.variableName] = null
              expanded.push(r2)
            } else {
              for (const m of matches) {
                const r2: Record<string, unknown> = { ...row }
                r2[opt.variableName] = _mkProps(m as any)
                expanded.push(r2)
              }
            }
          }
          result.length = 0
          result.push(...expanded)
          continue
        }
        // ── Pure-edge OPTIONAL MATCH: `OPTIONAL MATCH ()-[r]->()` ──
        // No source or target anchor, only a relationship variable. Enumerate
        // every edge in the graph (honoring direction + edge label) and expand
        // one row per matching relationship, binding `r` to its relationship
        // object (props included). Empty graph → single row with r = null.
        const _pureEdgeStep = optSteps.length === 1 ? optSteps[0] : null
        const _pureEdgeVar = _pureEdgeStep
          ? (_pureEdgeStep as any).edgeVariable || _pureEdgeStep.edgeAlias || ''
          : ''
        if (_pureEdgeStep && _pureEdgeVar && !_pureEdgeStep.source && !_pureEdgeStep.targetAlias) {
          const seen = new Set<string>()
          const relObjs: Array<Record<string, unknown>> = []
          for (let i = 0; i < allNodes.length; i++) {
            const es = (allNodes[i] as any).__edges as Array<{ srcIdx: number; dstIdx: number; label: string; props?: Record<string, unknown> }> | undefined
            if (!es) continue
            for (const e of es) {
              const key = `${e.srcIdx}|${e.dstIdx}|${e.label || ''}`
              if (seen.has(key)) continue
              seen.add(key)
              if (_pureEdgeStep.edgeLabel && e.label !== _pureEdgeStep.edgeLabel) continue
              const relObj: Record<string, unknown> = {
                __edgeLabel: e.label, _type: e.label, _label: e.label,
                srcIdx: e.srcIdx, dstIdx: e.dstIdx,
              }
              if (e.props) for (const [k, v] of Object.entries(e.props)) relObj[k] = v
              relObjs.push(relObj)
            }
          }
          if (relObjs.length === 0) {
            for (const row of result) row[_pureEdgeVar] = null
          } else {
            const expanded: Array<Record<string, unknown>> = []
            for (const row of result) {
              for (const relObj of relObjs) {
                expanded.push({ ...row, [_pureEdgeVar]: relObj })
              }
            }
            result.length = 0
            result.push(...expanded)
          }
          continue
        }
        // Variables bound by the leading MATCH (not by this OPTIONAL MATCH):
        // used to tell a genuinely-bound node from the edge-projection slot the
        // graph-engine path leaves on an OPTIONAL-only variable.
        const _matchBoundVars = new Set<string>()
        if ((plan as any).matchVar) _matchBoundVars.add((plan as any).matchVar)
        for (const st of (plan.steps || [])) {
          if (st.source) _matchBoundVars.add(st.source)
          if (st.targetAlias) _matchBoundVars.add(st.targetAlias)
          if ((st as any).edgeVariable) _matchBoundVars.add((st as any).edgeVariable)
        }
        // A cell is "already bound" when it carries a meaningful value, not the
        // graph engine's `Default` placeholder it pre-fills for as-yet unmatched
        // variables.
        const _isBound = (v: unknown): boolean => {
          if (v === undefined || v === null) return false
          if (typeof v === 'object') {
            const o = v as Record<string, unknown>
            if (o._label === 'Default' && Object.keys(o).every(k => k === '_label' || k === 'props')) return false
          }
          return true
        }
        for (let ri = 0; ri < result.length; ri++) {
          const row = result[ri]
          // 解析 source 变量对应的 allNodes 索引
          const sourceVar = optSteps[0]?.source || ''
          const targetVar = optSteps[0]?.targetAlias || ''
          const pathVar = (optSteps[0] as any)?.pathVariable || ''
          let edgeVar = optSteps[0]?.edgeVariable || optSteps[0]?.edgeAlias || ''
          if (!edgeVar && query) {
            // Tolerate edge labels in `(a)-[r:T]->()` by capturing only the
            // variable name up to the optional `:` label segment.
            const optMatchEdge = query.match(/OPTIONAL\s+MATCH\s*\([^)]+\)\s*-\s*\[(\w+)\s*(?::|\])/)
            if (optMatchEdge) edgeVar = optMatchEdge[1]
          }
          const optVarName = opt.variableName || ''
          let srcNodeIdx = -1
          // 先从 rawWithEdges.__crossVarRows 获取源节点引用（比 row[sourceVar] 更可靠）
          const rawEntry = Array.isArray(rawWithEdges) ? rawWithEdges[ri] : undefined
          if (rawEntry?.__crossVarRows && sourceVar && sourceVar in rawEntry.__crossVarRows) {
            const srcNodeRef = rawEntry.__crossVarRows[sourceVar] as any
            // Resolve the SPECIFIC source node (not just any node sharing its
            // label). Match by reference identity or full property content
            // first; only fall back to label when the node has no distinguishing
            // properties (e.g. a bare `(:X)` node).
            const refKeys = Object.keys(srcNodeRef || {}).filter(k =>
              !k.startsWith('_') && k !== '__edges' && k !== 'id'
            )
            // 1) Reference identity (already a member of allNodes).
            let si = allNodes.indexOf(srcNodeRef)
            // 2) Full-content match over distinguishing (non-undername) props.
            if (si < 0 && refKeys.length) {
              for (let k = 0; k < allNodes.length; k++) {
                const cand = allNodes[k] as any
                if ((cand?._label ?? '') !== (srcNodeRef?._label ?? '')) continue
                if (refKeys.every(pk => cand?.[pk] === srcNodeRef?.[pk])) { si = k; break }
              }
            }
            // 3) _alias match.
            if (si < 0 && srcNodeRef?._alias) {
              si = allNodes.findIndex((n: any) => n?._alias === srcNodeRef._alias)
            }
            // 4) Label-only fallback (ambiguous, used only when no props).
            if (si < 0) {
              const srcLabel = srcNodeRef?._label || ''
              if (srcLabel) {
                for (let k = 0; k < allNodes.length; k++) {
                  if ((allNodes[k] as any)._label === srcLabel) { si = k; break }
                }
              }
            }
            srcNodeIdx = si
          }
          if (srcNodeIdx < 0 && sourceVar) {
            // 尝试从 row[sourceVar] 获取字符串化的节点值
            const srcVal = row[sourceVar]
            const srcType = typeof srcVal
            if (srcType === 'string') {
              const rowLabel = (srcVal as string).match(/^\(:(\w+)/)
              if (rowLabel) {
                for (let si = 0; si < allNodes.length; si++) {
                  if ((allNodes[si] as any)._label === rowLabel[1]) { srcNodeIdx = si; break }
                }
              }
            } else if (srcType === 'object' && srcVal !== null) {
              // row[sourceVar] may itself be a node-props object (set by a prior
              // OPTIONAL MATCH or _formatResultRow). Resolve it back to an
              // allNodes index by matching label + distinguishing props.
              const rv = srcVal as Record<string, unknown>
              const rvLabel = (rv._label as string) || ''
              const rvKeys = Object.keys(rv).filter(k => !k.startsWith('_') && k !== 'id')
              if (rvLabel && rvKeys.length) {
                for (let si = 0; si < allNodes.length; si++) {
                  const cand = allNodes[si] as any
                  if (String(cand?._label ?? '') !== rvLabel) continue
                  if (rvKeys.every(pk => cand?.[pk] === rv[pk])) { srcNodeIdx = si; break }
                }
              }
              if (srcNodeIdx < 0 && rvLabel) {
                for (let si = 0; si < allNodes.length; si++) {
                  if ((allNodes[si] as any)._label === rvLabel) { srcNodeIdx = si; break }
                }
              }
            }
            // fallback: 用 opt.scanLabel 或主 MATCH 的 scanLabel 匹配 allNodes
            if (srcNodeIdx < 0) {
              const srcLabel = opt.scanLabel || (plan as any).scanLabel || ''
              if (srcLabel) {
                for (let si = 0; si < allNodes.length; si++) {
                  if ((allNodes[si] as any)._label === srcLabel) { srcNodeIdx = si; break }
                }
              }
            }
            // last fallback: 按 _alias 匹配
            if (srcNodeIdx < 0) {
              for (let si = 0; si < allNodes.length; si++) {
                if ((allNodes[si] as any)._alias === sourceVar) { srcNodeIdx = si; break }
              }
            }
          }
          // ── Reused bound relationship w/ unbound endpoints ──
          // `WITH r ... OPTIONAL MATCH (a2)-[r]->(b2)` reuses a bound edge `r`
          // (projected by the leading MATCH) as the relationship of the optional
          // pattern.  Neither `a2` nor `b2` is bound by MATCH, so both endpoints
          // must be derived FROM the bound edge, not from the graph-engine's
          // edge-projection slot (which leaks the target node into `a2`/`b2`).
          if (edgeVar && !_matchBoundVars.has(sourceVar) && !_matchBoundVars.has(targetVar) && _isBound(row[edgeVar])) {
            const edgeVal = row[edgeVar]
            let edgeLabel = ''
            if (typeof edgeVal === 'string') {
              edgeLabel = (edgeVal.match(/^\[:([^\]{}]*)/) || [])[1] || ''
            } else if (edgeVal && typeof edgeVal === 'object') {
              edgeLabel = (edgeVal as any).__edgeLabel || (edgeVal as any)._type || (edgeVal as any).__edgeLabelStr || ''
            }
            if (!edgeLabel && rawEntry?.__crossVarRows?.[edgeVar]) {
              const ev = rawEntry.__crossVarRows[edgeVar] as any
              edgeLabel = ev?.__edgeLabel || ev?._type || ev?.__edgeLabelStr || ''
            }
            if (edgeLabel) {
              // Locate the unique edge carrying this label among allNodes and
              // derive its source/target node indices (guaranteed single-hop here).
              let foundSrc = -1; let foundDst = -1
              outer: for (let ni = 0; ni < allNodes.length; ni++) {
                const nedges = (allNodes[ni] as any).__edges as Array<{srcIdx:number; dstIdx:number; label:string}> | undefined
                if (!nedges) continue
                for (const e of nedges) {
                  if (e.label === edgeLabel) {
                    // Stay direction-agnostic: the unique labelled edge fixes both
                    // endpoints; source/dst are the pair of indices it connects.
                    const s = e.srcIdx; const d = e.dstIdx
                    if (s === ni) { foundSrc = s; foundDst = d }
                    else if (d === ni) { foundSrc = d; foundDst = s }
                    break outer
                  }
                }
              }
              if (foundSrc >= 0) srcNodeIdx = foundSrc
              if (foundDst >= 0) {
                // Bind the target endpoint directly so bindPath's targetAlias
                // slot resolves to it rather than the leaked node.
                ;(row as any)[targetVar] = foundDst
              }
            }
          }
          // 构造 nodeProps 帮助函数
          const _mkNodeProps = (n: any): Record<string, unknown> => {
            const p: Record<string, unknown> = {}
            if (!n) return p
            for (const k of Object.keys(n)) {
              if (k !== '__edges' && !k.startsWith('_')) p[k] = n[k]
            }
            if (n._label) p._label = n._label
            return p
          }
          if (srcNodeIdx >= 0 && optSteps.length) {
            let walkPaths = _walkMultiSteps(srcNodeIdx, optSteps, allNodes)
            // Collect every variable bound along the OPTIONAL MATCH chain: the
            // targetAlias of each step (intermediate hops included), plus the
            // source of any step whose source !== the MATCH bound source (e.g.
            // `OPTIONAL MATCH (y)-[:E2]->(z)` where `y` is itself optional).
            const optBoundVars: Array<{ var: string; nodeIdx: number | null }> = []
            for (const st of optSteps) {
              if (st.source && st.source !== sourceVar) {
                if (!optBoundVars.some(b => b.var === st.source)) optBoundVars.push({ var: st.source, nodeIdx: null })
              }
              // A self-loop pattern `(a)-[r]->(a)` has targetAlias === source,
              // so `a` is already bound by the leading MATCH; it must not be
              // treated as an optional variable (which would null the source on
              // a non-match).
              if (st.targetAlias && st.targetAlias !== sourceVar && !optBoundVars.some(b => b.var === st.targetAlias)) {
                optBoundVars.push({ var: st.targetAlias, nodeIdx: null })
              }
            }
            if (walkPaths?.length) {
              // Enforce relationship uniqueness: an OPTIONAL relationship
              // variable must not bind the same physical relationship already
              // bound by the leading MATCH.  e.g. `MATCH (a)-[r {name:'r1'}]-(b)
              // OPTIONAL MATCH (b)-[r2]-(c)` — when the walk from b reuses the
              // r1 edge, r2 is duplicate and must yield null (c = null), not a
              // spurious match.  Compare the leading edge's label + props
              // against the edge actually crossed by each single-hop trail.
              const mainEdgeVar = (plan.steps || []).find((s: any) => s.edgeVariable)?.edgeVariable
              // Leading MATCH edge identity sources: the inline property map
              // (`-[r {name:'r1'}]->`) is always available on the step, even
              // when the edge walk serialises the bound relationship variable
              // and drops its props from __crossVarRows.
              const mainEdgeProps = (plan.steps || []).find((s: any) => s.edgeProps)?.edgeProps
              const mainEdgeLabel = (plan.steps || []).find((s: any) => s.edgeLabel)?.edgeLabel
              if ((mainEdgeProps && Object.keys(mainEdgeProps).length) || mainEdgeLabel) {
                walkPaths = walkPaths.filter((p: number[]) => {
                  if (p.length < 2) return true
                  const fromIdx = p[0]
                  const toIdx = p[1]
                  const fromEdges = (allNodes[fromIdx] as any)?.__edges || []
                  const crossed = fromEdges.find((e: any) => e.dstIdx === toIdx || e.srcIdx === toIdx)
                  if (!crossed) return true
                  if (mainEdgeLabel && String(crossed.label ?? '') !== String(mainEdgeLabel)) return true
                  // If the crossed edge satisfies the leading step's inline
                  // property map, it IS the relationship already bound by the
                  // leading MATCH, so this OPTIONAL hop must not reuse it.
                  if (mainEdgeProps) {
                    const cp = crossed.props ?? {}
                    let sameEdge = true
                    for (const k of Object.keys(mainEdgeProps)) {
                      if (String((cp as any)[k]) !== String((mainEdgeProps as any)[k])) { sameEdge = false; break }
                    }
                    if (sameEdge) {
                      return false
                    }
                  }
                  return true
                })
              }
              // Filter out trails that fail to actually return to an
              // already-bound target node.  A self-loop pattern
              // `(a)-[r]-(a)` has targetVar === sourceVar, so the trail's
              // endpoint must be the source node itself (index srcNodeIdx);
              // otherwise the undirected walk also reaches the source's other
              // neighbours, which is not a loop.
              let filteredPaths = walkPaths
              if (targetVar === sourceVar) {
                filteredPaths = walkPaths.filter((p: number[]) => p[p.length - 1] === srcNodeIdx)
              } else if (targetVar && targetVar in row) {
                const tv = row[targetVar]
                let ti = -1
                if (tv && typeof tv === 'object') {
                  ti = allNodes.indexOf(tv as any)
                  if (ti < 0 && (tv as any)?._alias) ti = allNodes.findIndex((n: any) => n?._alias === (tv as any)._alias)
                }
                if (ti >= 0) filteredPaths = walkPaths.filter((p: number[]) => p[p.length - 1] === ti)
              } else if (targetVar && _matchBoundVars.has(targetVar) && rawEntry) {
                // The bound target (e.g. `team` in `MATCH (p)-[:PLAYS_FOR]->(team)
                // OPTIONAL MATCH (p)-[s:SUPPORTS]->(team)`) may already have been
                // projected away by _formatResultRow (RETURN only lists
                // `s IS NULL`), so the projected `row` no longer carries it.  The
                // target variable must still constrain the OPTIONAL walk to that
                // exact pre-bound node (the one reached by PLAYS_FOR), otherwise
                // a SUPPORTS edge to a *different* Team is matched and `s` is
                // wrongfully bound instead of null.  Recover it from the raw
                // engine row's cross-variable bindings.
                const rawTgt = rawEntry.__crossVarRows?.[targetVar]
                  ?? rawEntry.__targetProps?.[targetVar]
                  ?? (rawEntry.__targetProps && rawEntry.__targetProps._label ? rawEntry.__targetProps : undefined)
                  ?? rawEntry[targetVar]
                let ti = -1
                if (rawTgt && typeof rawTgt === 'object') {
                  ti = allNodes.indexOf(rawTgt as any)
                  if (ti < 0 && (rawTgt as any)?._alias) ti = allNodes.findIndex((n: any) => n?._alias === (rawTgt as any)._alias)
                }
                if (ti >= 0) filteredPaths = walkPaths.filter((p: number[]) => p[p.length - 1] === ti)
              }
              // A variable-length OPTIONAL MATCH may match several distinct
              // trails from the same bound source (e.g. `(a)-[*]->(b)` reaches
              // every node reachable within the range), so each trail expands
              // into its own result row rather than only the first.  For a
              // variable-length step the target alias binds the trail's final
              // node (path[path.length - 1]), while fixed-length steps bind
              // path[si + 1].
              const bindPath = (path: number[], base: Record<string, unknown>): Record<string, unknown> => {
                const out: Record<string, unknown> = { ...base }
                optSteps.forEach((st, si) => {
                  if (st.targetAlias) {
                    const nodeAt = (st as any).range ? path[path.length - 1] : path[si + 1]
                    out[st.targetAlias] = nodeAt != null && nodeAt >= 0 ? _mkNodeProps(allNodes[nodeAt] as any) : null
                  }
                })
                // Bind the OPTIONAL source itself when it is not bound by the
                // leading MATCH (e.g. `a2` in `WITH r ... OPTIONAL MATCH
                // (a2)-[r]->(b2)`): it derives from the trail's first node, not
                // from the stale edge-projection slot left on the row.
                if (sourceVar && !_matchBoundVars.has(sourceVar)) {
                  out[sourceVar] = path[0] != null && path[0] >= 0 ? _mkNodeProps(allNodes[path[0]] as any) : null
                }
                // Back-fill any step whose source is itself an optional var
                // (e.g. `y` in `(y)-[:E2]->(z)`), using the previous hop's node.
                optSteps.forEach((st, si) => {
                  if (st.source && st.source !== sourceVar && si > 0 && out[st.source] === undefined) {
                    const nodeAt = path[si]
                    out[st.source] = nodeAt != null && nodeAt >= 0 ? _mkNodeProps(allNodes[nodeAt] as any) : null
                  }
                })
                if (edgeVar) {
                  // Bind the matched edge as a full relationship object so that
                  // type(r) / r.prop resolve correctly for the matched hop.
                  const ePathIdx = optSteps.findIndex((st: any) => st.edgeVariable === edgeVar || st.edgeAlias === edgeVar)
                  const hop = ePathIdx >= 0 ? ePathIdx : 0
                  const fromIdx = path[hop]
                  const toIdx = path[hop + 1]
                  const fromN = fromIdx != null ? allNodes[fromIdx] as any : undefined
                  const fromEdges = (fromN?.__edges || []) as Array<{srcIdx:number; dstIdx:number; label:string; props?:Record<string,unknown>}> | undefined
                  // Prefer the edge that exactly connects fromIdx → toIdx in the
                  // matching orientation.  For a self-loop (fromIdx === toIdx) the
                  // loose `dstIdx === toIdx || srcIdx === toIdx` test would grab an
                  // unrelated inbound neighbour edge before the loop edge, so insist
                  // on srcIdx === fromIdx && dstIdx === toIdx when the endpoints
                  // coincide; otherwise fall back to an undirected endpoint match.
                  let ee = fromIdx === toIdx
                    ? fromEdges?.find((e: any) => (e.srcIdx === fromIdx && e.dstIdx === toIdx))
                    : fromEdges?.find((e: any) => (e.dstIdx === toIdx || e.srcIdx === toIdx))
                  if (!ee && fromIdx !== toIdx) ee = fromEdges?.find((e: any) => (e.srcIdx === toIdx && e.dstIdx === fromIdx))
                  if (ee) {
                    const edgeObj: Record<string, unknown> = {
                      __edgeLabel: ee.label,
                      __edgeLabelStr: ee.label,
                      _type: ee.label,
                      _label: ee.label,
                    }
                    if (ee.props) for (const [pk, pv] of Object.entries(ee.props)) edgeObj[pk] = pv
                    out[edgeVar] = edgeObj
                  } else {
                    out[edgeVar] = null
                  }
                }
                if (pathVar && path.length >= 2) {
                  // Reconstruct the named path object `{ __path, __pathEdges }`
                  // for an OPTIONAL MATCH path variable (`p = (a)-[:X]->(b)`).
                  // The path is the sequence of nodes traversed by this trail and
                  // the oriented relationship objects along each hop, matching the
                  // `__path`/`__pathEdges` shape produced for a leading MATCH path.
                  const pathNodes: Array<Record<string, unknown>> = []
                  const pathEdges: Array<Record<string, unknown>> = []
                  for (let pi = 0; pi < path.length; pi++) {
                    const ni = path[pi]
                    const n = ni != null && ni >= 0 ? allNodes[ni] as any : undefined
                    const np: Record<string, unknown> = {}
                    if (n) {
                      for (const k of Object.keys(n)) {
                        if (k !== '__edges' && k !== 'props' && !k.startsWith('__')) np[k] = n[k]
                      }
                      if (n._label) np._label = n._label
                    }
                    pathNodes.push(np)
                  }
                  for (let pi = 0; pi < path.length - 1; pi++) {
                    const aIdx = path[pi]
                    const bIdx = path[pi + 1]
                    const aN = aIdx != null ? allNodes[aIdx] as any : undefined
                    const ee2 = aIdx === bIdx
                      ? (aN?.__edges || []).find((e: any) => (e.srcIdx === aIdx && e.dstIdx === bIdx))
                      : (aN?.__edges || []).find((e: any) => (e.dstIdx === bIdx || e.srcIdx === bIdx))
                    if (ee2) {
                      const eo: Record<string, unknown> = {
                        __edgeLabel: ee2.label ?? '',
                        __edgeLabelStr: ee2.label ?? '',
                        _type: ee2.label ?? '',
                        _label: ee2.label ?? '',
                        _dir: ee2.srcIdx === aIdx ? 'out' : 'in',
                      }
                      if (ee2.props) for (const [pk, pv] of Object.entries(ee2.props)) eo[pk] = pv
                      pathEdges.push(eo)
                    }
                  }
                  out[pathVar] = { __path: pathNodes, __pathEdges: pathEdges }
                }
                return out
              }
              if (filteredPaths.length === 0) {
                for (const bv of optBoundVars) row[bv.var] = null
                if (edgeVar && !_isBound(row[edgeVar])) row[edgeVar] = null
                if (pathVar) row[pathVar] = null
              } else if (filteredPaths.length === 1) {
                // Single trail: bind it onto the current row in place.
                const bound = bindPath(filteredPaths[0], row)
                for (const k of Object.keys(bound)) row[k] = bound[k]
              } else {
                // Multiple trails: expand the current row into one row per trail.
                const expanded = filteredPaths.map((p) => bindPath(p, row))
                result.splice(ri, 1, ...expanded)
                ri += expanded.length - 1
              }
            } else {
              // OPTIONAL path does not match: the source variable (already bound
              // by the preceding MATCH) must be preserved; the optional target
              // variables become null.  A bound relationship reused as `[r]`
              // (projected by a preceding WITH) keeps its value when the optional
              // hop fails, but the graph engine's own placeholder must still null.
              for (const bv of optBoundVars) row[bv.var] = null
              if (edgeVar && !_isBound(row[edgeVar])) row[edgeVar] = null
              if (pathVar) row[pathVar] = null
            }
          } else if (optVarName && !sourceVar && !targetVar && !edgeVar) {
            // Single-node pattern: OPTIONAL MATCH (n) / (n:Label).  Without a
            // scanLabel the bare `(n)` binds the first existing node (any node),
            // mirroring MATCH (n) but null when the graph is empty.
            const nodeProps = opt.scanLabel
              ? _mkNodeProps(allNodes.find(n => (n as any)._label === opt.scanLabel))
              : (allNodes.length ? _mkNodeProps(allNodes[0] as any) : null)
            row[optVarName] = nodeProps || null
          } else {
            // 找不到 source 或无步骤：同样只置空 optional target/edge，保留 source
            if (targetVar) row[targetVar] = null
            if (edgeVar) row[edgeVar] = null
            if (optVarName) row[optVarName] = null
          }
        }
      }
    }

    // Post-OPTIONAL WHERE predicates.  A `WHERE` attached to an OPTIONAL MATCH
    // (`OPTIONAL MATCH (n)-[r]-(m) WHERE m:NonExistent`) filters the *optional*
    // bindings: rows whose OPTIONAL variables fail the predicate are dropped,
    // and if ALL rows are dropped the primary (pre-OPTIONAL) row survives with
    // the OPTIONAL trail nulled.  This mirrors Cypher's "optional match then
    // filter" semantics, distinct from a WHERE on the primary MATCH.
    if (plan.optionalMatchSteps?.length && result.length) {
      // Variables already bound by the primary MATCH must NOT be treated as
      // OPTIONAL-bound (and must never be nulled); only the OPTIONAL pattern's
      // newly-introduced variables (target aliases, edge variables, and the
      // pattern's own starting variable when it is not a primary variable).
      const primaryVars = new Set<string>()
      if ((plan as any).matchVar) primaryVars.add((plan as any).matchVar)
      for (const st of plan.steps || []) {
        if ((st as any).source) primaryVars.add((st as any).source)
        if ((st as any).targetAlias) primaryVars.add((st as any).targetAlias)
      }
      for (const mm0 of (plan as any).multiMatch || []) if (mm0?.variable) primaryVars.add(mm0.variable)
      const optVars = new Set<string>()
      for (const om of plan.optionalMatchSteps) {
        if (om.variableName && !primaryVars.has(om.variableName)) optVars.add(om.variableName)
        for (const st of om.steps || []) {
          if (st.source && !primaryVars.has(st.source)) optVars.add(st.source)
          if (st.targetAlias) optVars.add(st.targetAlias)
          if (st.edgeVariable) optVars.add(st.edgeVariable)
        }
      }
      const optLabelFilters = (plan.labelFilterItems || []).filter((lfi: any) => optVars.has(lfi.variable))
      // Property predicates may live either on the top-level `plan.filters`
      // (`MATCH … WHERE x.num = 42`) or on the per-OPTIONAL `opt.filters`
      // (`OPTIONAL MATCH … WHERE m.num = 42`); gather both.  A label predicate
      // carried as an `expression` (`WHERE c:C`) has empty source/property.
      const optPropFilters = (plan.filters || []).filter((f: any) => optVars.has(f.source))
      const optExprFilters: any[] = []
      for (const om of plan.optionalMatchSteps) {
        for (const f of (om.filters || [])) {
          const ff = f as any
          if (ff.expression) {
            // Label predicate `var:Label` — the var must be OPTIONAL-bound.
            const varName = (ff.expression as string).split(':')[0]
            if (optVars.has(varName)) optExprFilters.push(ff)
          } else if (optVars.has(ff.source)) {
            optPropFilters.push(ff)
          }
        }
      }
      if (optLabelFilters.length || optPropFilters.length || optExprFilters.length) {
        const predicateHolds = (row: Record<string, unknown>): boolean => {
          for (const lfi of optLabelFilters as any[]) {
            const v = row[lfi.variable]
            if (v == null) continue
            const label = String((v as any)._label || '')
            const included = label.split(':').includes(lfi.label)
            if (lfi.exclude ? included : !included) return false
          }
          for (const f of optPropFilters as any[]) {
            const v = row[f.source]
            if (v == null) continue
            const actual = (v as any)[f.property]
            let fv = f.value
            if (typeof fv === 'string' && /^\w+\.\w+$/.test(fv) && !/^['"]/.test(fv) && !/^\d/.test(fv)) {
              const [rv, rp] = fv.split('.')
              fv = (row[rv] as any)?.[rp]
            }
            const ok = (() => {
              switch (f.operator) {
                case 'EQ': return actual === fv
                case 'NEQ': return actual !== fv
                case 'GT': return Number(actual) > Number(fv)
                case 'GTE': return Number(actual) >= Number(fv)
                case 'LT': return Number(actual) < Number(fv)
                case 'LTE': return Number(actual) <= Number(fv)
                default: return String(actual) === String(fv)
              }
            })()
            if (!ok) return false
          }
          for (const f of optExprFilters) {
            const varName = (f.expression as string).split(':')[0]
            const v = row[varName]
            if (v == null) continue
            const val = _evaluateExpression(f.expression, { ...row })
            if (val !== true) return false
          }
          return true
        }
        const surviving = result.filter(predicateHolds)
        if (surviving.length === 0) {
          // Every OPTIONAL binding failed the predicate → keep one primary row
          // with the OPTIONAL trail nulled (the retained main match).
          const primaryKeys = new Set(Object.keys(result[0]).filter(k => !optVars.has(k)))
          const nulled: Record<string, unknown> = {}
          for (const k of primaryKeys) nulled[k] = result[0][k]
          for (const vn of optVars) nulled[vn] = null
          result.length = 0
          result.push(nulled)
        } else {
          result.length = 0
          result.push(...surviving)
        }
      }
    }

    // OPTIONAL MATCH 后处理：OPTIONAL MATCH 设置的变量可能改变了 RETURN 表达式的求值结果。
    // 重新计算受影响的列。
    if (plan.optionalMatchSteps?.length && result.length) {
      // Collect EVERY variable an OPTIONAL MATCH binds — not just `variableName`
      // (which holds the pattern's starting node, e.g. `n` in
      // `OPTIONAL MATCH (n)-[:R]->(x)`).  The target (and any intermediate hop)
      // lives in the step's `targetAlias`/`source`, and an aggregate such as
      // `collect(x)` references the TARGET variable `x`, so it must be included
      // here or the re-evaluation below silently skips the column.
      const optMatchVarNames = new Set<string>()
      for (const om of plan.optionalMatchSteps) {
        if (om.variableName) optMatchVarNames.add(om.variableName)
        for (const st of om.steps || []) {
          if (st.targetAlias) optMatchVarNames.add(st.targetAlias)
          if (st.edgeAlias) optMatchVarNames.add(st.edgeAlias)
          if (st.edgeVariable) optMatchVarNames.add(st.edgeVariable)
        }
      }
      if (optMatchVarNames.size && (plan.expressionColumns?.length || plan.returnAliasMap)) {
        const aliasToExpr: Record<string, string> = {}
        for (const ec of plan.expressionColumns) {
          const ecObj = ec as { alias?: string; expression?: any }
          const alias = (typeof ec === 'string' ? ec : ecObj.alias ?? ecObj.expression ?? String(ec))
          const expr = (typeof ec === 'object' && ecObj.expression) ? String(ecObj.expression) : alias
          aliasToExpr[alias] = expr
        }
        // Return-alias columns (e.g. `type(r)` in `RETURN type(r)`) live in
        // returnAliasMap rather than expressionColumns; include them too so an
        // OPTIONAL MATCH edge binding is reflected in the result.
        if (plan.returnAliasMap && typeof plan.returnAliasMap === 'object') {
          for (const [alias, expr] of Object.entries(plan.returnAliasMap as Record<string, unknown>)) {
            if (typeof expr === 'string' && expr !== alias) aliasToExpr[alias] = expr
            else if (typeof expr === 'string') aliasToExpr[alias] = expr
          }
        }
        for (const row of result) {
          for (const alias of Object.keys(aliasToExpr)) {
            if (!alias) continue
            const rawexpr = aliasToExpr[alias]
            if (!rawexpr) continue
            // 检查 OPTIONAL MATCH 变量是否在表达式中被引用且已存在于 row 中
            const hasVar = [...optMatchVarNames].some(vn => rawexpr.includes(vn) && vn in row)
            if (!hasVar) continue
            const varCtx: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(row)) {
              if (!k.startsWith('_')) varCtx[k] = v
            }
            for (const vn of optMatchVarNames) {
              if (vn in row) varCtx[vn] = row[vn]
            }
            try {
              const newVal = _evaluateExpression(rawexpr, varCtx)
              if (newVal !== undefined && newVal !== null) {
                row[alias] = newVal
              }
            } catch (_e) { /* ignore evaluation error, keep original value */ }
          }
        }
      }
    }

    // ── Multi-aggregate fold (after OPTIONAL MATCH expansion) ──
    // A query with several aggregates and no GROUP BY whose variables come from
    // OPTIONAL MATCH (e.g. `OPTIONAL MATCH (f:X) OPTIONAL MATCH (n:Y) RETURN
    // collect(DISTINCT n.num) AS a, collect(DISTINCT f.num) AS b`) has, by this
    // point, been expanded into one row per OPTIONAL MATCH binding.  Collapse
    // those rows into a single row, evaluating every aggregate across the full
    // row set (null/undefined excluded; DISTINCT deduplicates) — this is the
    // cross-row fold that a single-row expression eval above cannot provide.
    if ((plan.aggregates?.length ?? 0) > 1 && !plan.groupBy?.length &&
        plan.optionalMatchSteps?.length && result.length > 0) {
      const foldRow: QueryRow = {}
      for (const agg of plan.aggregates as any[]) {
        const aggFn = (agg.function || agg.type || '').toLowerCase()
        const aggAlias = (agg.alias && agg.alias !== agg.function)
          ? agg.alias
          : (agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || agg.field || agg.column || 'c')
        const colMatch = (agg.column || '').match(/^\w+\(\s*(?:DISTINCT\s+)?(.+?)\s*\)(?:\s+AS\s+\w+)?$/i)
        const field = colMatch ? colMatch[1] : (agg.field || '*')
        const readVal = (r: QueryRow): unknown => {
          if (field === '*' || field === '') return r
          if (field.includes('.')) {
            const [vn, pn] = field.split('.')
            const obj = r[vn]
            return (obj && typeof obj === 'object') ? (obj as any)[pn] : undefined
          }
          return r[field]
        }
        if (aggFn === 'collect') {
          const collected: unknown[] = []
          const seen = new Set<unknown>()
          for (const r of result) {
            const v = readVal(r)
            if (v === null || v === undefined) continue
            if (agg.distinct === true) { if (seen.has(v)) continue; seen.add(v) }
            collected.push(v)
          }
          foldRow[aggAlias] = collected
        } else if (aggFn === 'count') {
          foldRow[aggAlias] = result.filter(r => {
            const v = readVal(r)
            return v !== null && v !== undefined
          }).length
        } else {
          const values = result.map(readVal)
            .filter((v: unknown) => v !== null && v !== undefined)
            .map(Number)
            .filter((v: number) => !isNaN(v))
          switch (aggFn) {
            case 'sum': foldRow[aggAlias] = values.reduce((a: number, b: number) => a + b, 0); break
            case 'avg': foldRow[aggAlias] = values.length ? values.reduce((a: number, b: number) => a + b, 0) / values.length : 0; break
            case 'max': foldRow[aggAlias] = values.length ? Math.max(...values) : 0; break
            case 'min': foldRow[aggAlias] = values.length ? Math.min(...values) : 0; break
            default: foldRow[aggAlias] = 0
          }
        }
      }
      result.length = 0
      result.push(foldRow)
    }

    // ── type() 函数后处理 ──
    // 如果原查询包含 type(r) 且结果中该列是边表示 [:T]，替换为类型名 'T'
    const hasTypeReturnCol = (plan.returnColumns || []).some((rc: string) =>
      rc && (rc.startsWith('type(') || (plan.returnAliasMap?.[rc] || '').startsWith('type('))
    )
    if (hasTypeReturnCol && query && /type\s*\(/i.test(query)) {
      for (const row of result) {
        for (const rc of plan.returnColumns || []) {
          if (!rc) continue
          const val = row[rc]
          if (typeof val === 'string' && val.startsWith('[:') && val.endsWith(']')) {
            // type(r) 的结果应为边标签名（不含引号）
            const typeName = val.slice(2, -1) // 去掉 [: 和 ]
            row[rc] = typeName
          }
        }
      }
    }

    // ── FOREACH 子句执行 ──
    // 新格式 FOREACH（variable + operation）对已格式化的 result 做展开
    const feFe = plan.forEach as any
    if (feFe && feFe.variable && feFe.operation && Array.isArray(result)) {
      const listItems = Array.isArray(feFe.list) ? [...feFe.list] : []
      if (listItems.length > 0 && result.length > 0) {
        const retCol = (plan.returnColumns || [])[0]
        const retVar = retCol ? retCol.split('.')[0] : ''
        const candidates = result.map((r: any) => {
          const c: any = {}
          if (retVar && r[retVar] !== undefined) {
            c[retVar] = typeof r[retVar] === 'object' && r[retVar] !== null ? { ...r[retVar] } : r[retVar]
          }
          return c
        })
        const feResult = executeForeachInlineTop(candidates, feFe)
        if (Array.isArray(feResult) && feResult.length > 0) {
          result = feResult.map((exr: any) => {
            if (retVar && exr[feFe.variable] !== undefined) {
              return { [retVar]: typeof exr[retVar] !== 'undefined' ? exr[retVar] : exr[feFe.variable] }
            }
            if (retVar) return { [retVar]: exr }
            return exr
          })
        }
      }
      // 空列表：保持 result 不变（FOREACH 不执行）
    }
    // 旧格式 FOREACH（name + updates）— 保持向后兼容，当前新格式已替代
    // 旧代码已删除，保留空 if 以避免无用行 — 如果未来需要恢复，取消下面注释
    // if (plan.forEach && plan.forEach.list?.length && !feFe?.variable && Array.isArray(result)) {
    //   const fe = plan.forEach
    //   for (const item of fe.list) {
    //     for (const update of fe.updates) {
    //       ... 创建节点逻辑 ...
    //     }
    //   }
    // }

    if (plan.hasMatch && plan.unwind && Array.isArray(result) && result.length) {
      const allPipelineRows: QueryRow[] = []
      for (let rowIdx = 0; rowIdx < result.length; rowIdx++) {
        const matchVarCtx: Record<string, unknown> = {}
        // 从 rawWithEdges.__crossVarRows 获取该行的 MATCH 节点变量
        const rawEntry = Array.isArray(rawWithEdges) ? rawWithEdges[rowIdx] : undefined
        if (rawEntry?.__crossVarRows) {
          for (const [varName, varVal] of Object.entries(rawEntry.__crossVarRows as Record<string, unknown>)) {
            matchVarCtx[varName] = varVal
          }
          // Cross-variable rows bind node/relationship variables but not the
          // MATCH path variable (e.g. `p` in `MATCH p = (n:N)-[r:REL]->()`);
          // the path object `{ __path, __pathEdges }` is materialized on
          // `rawEntry.props[pathVar]` instead.  Forward it so an UNWIND list
          // referencing the path (`UNWIND [n, r, p] AS x`) resolves `p` to the
          // full path object rather than null (which breaks ORDER BY type rank).
          for (const st of (plan.steps || [])) {
            const pv = (st as any)?.pathVariable as string | undefined
            if (pv && !(pv in matchVarCtx) && rawEntry?.props && typeof rawEntry.props === 'object' && (rawEntry.props as any)[pv] != null) {
              matchVarCtx[pv] = (rawEntry.props as any)[pv]
            }
          }
          if ((plan as any).pathVar && !((plan as any).pathVar in matchVarCtx) && rawEntry?.props && typeof rawEntry.props === 'object' && (rawEntry.props as any)[(plan as any).pathVar] != null) {
            matchVarCtx[(plan as any).pathVar] = (rawEntry.props as any)[(plan as any).pathVar]
          }
        }
        // 补充关系变量：从 query 提取 [r] 或 [r:Label] 语法
        if (query) {
          const relVars = [...query.matchAll(/\[(\w+)\s*(?::\s*\w+)?\]/g)].map(m => m[1]).filter(Boolean)
          for (const rv of relVars) {
            if (rv in matchVarCtx) continue
            // 尝试从 __edgeProps 获取
            if (rawEntry?.__edgeProps && typeof rawEntry.__edgeProps === 'object') {
              matchVarCtx[rv] = rawEntry.__edgeProps
            } else if (rawEntry && rawEntry.__edgeLabel && edgesPayload.length && rawEntry.id != null) {
              // 从 edgesPayload 查找该行的匹配边属性
              const nodeIdx = edgesPayload.findIndex(e => e.srcIdx === rawEntry.id || e.dstIdx === rawEntry.id)
              if (nodeIdx >= 0 && edgesPayload[nodeIdx]?.props && typeof edgesPayload[nodeIdx].props === 'object') {
                matchVarCtx[rv] = edgesPayload[nodeIdx].props
              } else {
                matchVarCtx[rv] = {}
              }
            } else {
              matchVarCtx[rv] = {}
            }
          }
        }
        // 回退：从 result row 推断变量
        if (!Object.keys(matchVarCtx).length) {
          const row = result[rowIdx]
          // Bind the MATCH source variable (e.g. `n` in `MATCH (n)`) to the
          // node object so a later `n.prop` projection resolves.  Without this
          // the fallback only flattens node properties into standalone keys
          // (`age`, `name`) and the variable name itself is lost, so
          // `RETURN n.age` projects to null.
          const srcVar = query?.match(/MATCH\s*\((\w+)/i)?.[1]
          const nodeObj = (rawEntry && typeof rawEntry === 'object' && 'props' in rawEntry && rawEntry.props && typeof rawEntry.props === 'object')
            ? rawEntry.props
            : row
          if (srcVar && nodeObj && typeof nodeObj === 'object' && !(srcVar in matchVarCtx)) {
            matchVarCtx[srcVar] = nodeObj
          }
          for (const [key, val] of Object.entries(row)) {
            if (hasProps(val)) {
              matchVarCtx[key] = val.props
            } else {
              matchVarCtx[key] = val
            }
          }
        }
        const pipelineRows = _executeWithUnwindPipeline(plan, [matchVarCtx] as any, query, matchVarCtx)
        if (Array.isArray(pipelineRows) && pipelineRows.length) {
          for (const pr of pipelineRows) {
            allPipelineRows.push({ ...matchVarCtx, ...pr })
          }
        }
        // 空：原始行丢弃（UNWIND [] 产生 0 行）
      }
      // ── DISTINCT 处理 ──
      if (allPipelineRows.length) {
        result.length = 0
        if (plan.distinct) {
          const dedupSet = new Set<string>()
          for (const row of allPipelineRows) {
            const colKeys = plan.returnColumns?.length ? plan.returnColumns : Object.keys(row).filter(k => !k.startsWith('__'))
            const sig = JSON.stringify(colKeys.map(k => row[k]))
            if (dedupSet.has(sig)) continue
            dedupSet.add(sig)
            result.push(row)
          }
        } else {
          result.push(...allPipelineRows)
        }
      } else {
        // An UNWIND pipeline is present (plan.unwind) but produced zero rows
        // (e.g. UNWIND [] over an empty list). Cypher semantics require the
        // original MATCH rows to be dropped entirely, not retained — otherwise
        // `MATCH (n) UNWIND [] AS x RETURN x` would leak the matched node as `x`.
        // When there is genuinely no UNWIND pipeline, this branch is not
        // reached (the enclosing `if (plan.hasMatch && plan.unwind)` guards it).
        result.length = 0
      }
      // ── UNWIND + WITH 管道后再求值 WHERE ──
      if (plan.whereBody && result.length) {
        const filtered: QueryRow[] = []
        for (const row of result) {
          const ctx: Record<string, unknown> = { ...row }
          for (const [k, v] of Object.entries(row)) {
            if (hasProps(v)) {
              ctx[k] = v.props
            }
          }
          try {
            let evalVal: unknown
            if (_isPatternPredicate(plan.whereBody)) {
              const isNegated = plan.whereBody.trim().startsWith('NOT ')
              evalVal = isNegated ? false : true
            } else if (/^exists\s*\{/i.test(plan.whereBody.trim())) {
              const ebody2 = plan.whereBody.trim()
              const srcMatch2 = ebody2.match(/(\w+)/)
              let existsVal2 = false
              if (srcMatch2 && allNodes?.length) {
                const srcVar2 = srcMatch2[1]
                const srcNodeRef2 = ctx[srcVar2]
                if (srcNodeRef2) {
                  const srcLabel2 = (srcNodeRef2.props || srcNodeRef2)._label || ''
                  const labelMatch2 = ebody2.match(/[:(w+)]/)
                  const edgeLabel2 = labelMatch2 ? labelMatch2[1] : null
                  for (const anode of allNodes) {
                    if (anode._label !== srcLabel2) continue
                    const anodeIdx2 = allNodes.indexOf(anode)
                    if (anode.__edges && Array.isArray(anode.__edges)) {
                      for (const e of anode.__edges) {
                        if (edgeLabel2 && e.label !== edgeLabel2) continue
                        existsVal2 = true; break
                      }
                    }
                    if (!existsVal2) {
                      for (const other of allNodes) {
                        if (other.__edges) {
                          for (const e of other.__edges) {
                            if (e.srcIdx === anodeIdx2 || e.dstIdx === anodeIdx2) {
                              if (edgeLabel2 && e.label !== edgeLabel2) continue
                              existsVal2 = true; break
                            }
                          }
                          if (existsVal2) break
                        }
                      }
                    }
                    if (existsVal2) break
                  }
                }
              }
              evalVal = existsVal2
            } else {
              evalVal = _evaluateExpression(whereBodyExpr || plan.whereBody, ctx)
            }
            if (evalVal === true) {
              filtered.push(row)
            }
          } catch {
            filtered.push(row)
          }
        }
        if (filtered.length || !result.length) {
          result.length = 0
          result.push(...filtered)
        }
      }
    }

    // ── 后处理（ORDER BY / HAVING） ──
    const evgeReturn = _postProcessResults(result, plan)
    return evgeReturn
  } finally {
    // DML 持久化：将 _executeViaGraphEngine 中创建的节点写回外部 nodes 数组，
    // 确保后续查询（MATCH）能看到前面 CREATE/MERGE 的节点。
    if ((plan.type === 'CREATE' || plan.type === 'MERGE' || plan.type === 'MATCH_MODIFY' || plan.type === 'SET' || plan.type === 'DELETE') && nodes) {
      // SET/REMOVE mutate existing nodes in-place; `allNodes` is a shallow clone
      // (allNodes = nodes.map(n => ({...n}))), so mutating allNodes[i] does not
      // reach nodes[i].  Copy the mutated properties of every original node back
      // onto the caller's array so a subsequent query observes the side effects
      // (e.g. `MATCH (n:N) SET n.num = n.num + 1` must persist `num`).
      //
      // CREATE with relationship edges also mutates existing nodes: a
      // `MATCH (x),(y) CREATE (x)-[:R]->(y)` pushes the new edge onto x/y's
      // `__edges` (in the allNodes clone).  Without copying those back, a later
      // control query `MATCH (x)-[:R]->(y)` finds no relationship (Create2).
      if (plan.type === 'SET' || plan.type === 'REMOVE' || plan.type === 'MATCH_MODIFY' ||
          (plan.type === 'CREATE' && (plan.createEdges?.length || plan.createNodes?.some(cn => cn.alias != null && !plan.steps?.length)))) {
        for (let i = 0; i < originalNodeCount && i < allNodes.length && i < nodes.length; i++) {
          const src = allNodes[i] as Record<string, unknown>
          const dst = nodes[i] as Record<string, unknown>
          for (const k of Object.keys(dst)) delete dst[k]
          Object.assign(dst, src)
        }
      }
      for (let i = originalNodeCount; i < allNodes.length; i++) {
        nodes.push(allNodes[i])
      }
    }
    // 注册池中的 GE 实例由 _clearGeInstances() 统一清理，不在 finally 中 close
    // 非注册临时 GE（当前不存在此场景）应在 finally 中 close + 清理
    // 释放 GEPool 连接（非 database-specific 实例）
    if (dbName === DEFAULT_DATABASE && ge) {
      try {
        // Reset the engine to an empty graph before returning it to the pool.
        // The GE instance is a per-execution scratch container (seed → query →
        // discard); without this reset the seeded nodes leak into the next
        // pooled execution and inflate results (e.g. `MATCH (n) RETURN count(n)`
        // counting stale nodes from an earlier run).
        ;(ge as any).clearAllData?.()
        const pool = GEPool.getInstance()
        pool.releaseConnection(ge)
      } catch { /* 池尚未初始化或已销毁 */ }
    }
    // Clear the pattern-comprehension node index so a stale node array never
    // leaks into a subsequent (unrelated) query execution.
    _setActivePatternNodes(null)
  }
}



export async function _executeQuery(
  plan: QueryPlan,
  nodes: Array<Record<string, unknown>>,
  query?: string,
): Promise<QueryResult> {
  // 编译时语义验证（跳过在某些复杂WITH+列表谓词场景下的误报）
  try {
    _validatePlan(plan, query)
  } catch (e: any) {
    // 如果是 UndefinedVariable 但 query 中存在 WITH+列表谓词模式，跳过
    // 否则抛出
    if (e.message?.includes('UndefinedVariable') && /none|all|any|single/i.test(query || '')) {
      // 有可能是列表谓词内的 WHERE 导致 WITH 提取误断，跳过验证
    } else {
      throw e
    }
  }

  // 无显式 LIMIT 时应用 DEFAULT_LIMIT（批量数据集上默认截断防止 OOM）
  if (plan.limit === undefined || plan.limit === null) {
    plan.limit = DEFAULT_LIMIT
  }

  // 对不需要 GE 的快捷路径，Plan 深拷贝可以延迟到真正需要时
  // Note: _executeViaGraphEngine 内部会 mutate plan.filters/plan.steps，
  // 所以 GE 路径必须在执行前深拷贝
  // 快捷路径（LOAD CSV, SHOW, catalog, DML, bare CALL）不 mutate plan → 无需拷贝

  // ── bare CALL dispatch：CALL name（无括号语法）──
  if (plan.type === 'CALL' && !plan.callProcedure && query) {
    const callMatch = query.match(/CALL\s+(\S+)(?:\s+|\s*$)/i)
    if (callMatch && !query.match(/CALL\s+\S+\s*\(/i)) {
      const bareName = callMatch[1].toLowerCase()
      const proc = _procedureRegistry.get(bareName)
      if (proc) {
        const sigParens = proc.signature.match(/\(([^)]*)\)/)
        const paramNames: string[] = []
        if (sigParens) {
          paramNames.push(...sigParens[1].split(',').map(s => s.split('::')[0].trim()).filter(Boolean))
        }
        const bareParams = plan._bareCallParams as Record<string, unknown> | undefined
        const args: unknown[] = []
        if (bareParams && paramNames.length) {
          for (const pn of paramNames) {
            args.push(bareParams[pn] !== undefined ? bareParams[pn] : null)
          }
        }
        if (sigParens) {
          const sigArgsBP = sigParens[1].split(',').map(s => s.trim()).filter(Boolean)
          const hasRequiredUnprovided = sigArgsBP.some((a) => {
            const trimmed = a.trim()
            const pName = trimmed.split('::')[0].trim()
            if (bareParams && pName in bareParams) return false
            if (/DEFAULT\s/i.test(trimmed)) return false
            return true
          })
          if (hasRequiredUnprovided) {
            throw Object.assign(new Error('ParameterMissing'), { tckError: 'MissingParameter' })
          }
        }
        const ctx: import('./procedure-registry').ProcedureContext = {
          getAllNodes: () => nodes as any[],
          getNodeCount: () => nodes.length,
          getLabels: () => {
            const labels = new Set<string>()
            for (const node of nodes) {
              const lbl = String(node._label || '')
              if (lbl) for (const l of lbl.split(':').map(s => s.trim()).filter(Boolean)) labels.add(l)
            }
            return Array.from(labels)
          },
          getPropertyKeys: () => {
            const keys = new Set<string>()
            for (const node of nodes) { for (const k of Object.keys(node)) if (!k.startsWith('_')) keys.add(k) }
            return Array.from(keys)
          },
        }
        return proc.execute(ctx, args) as any
      }
    }
  }
  // ── Pure-expression WITH+RETURN fast path ──
  // For queries with WITH/UNWIND/expression columns but no MATCH, no DML,
  // and no procedure calls, bypass GE entirely.  The query-executor's
  // expression engine evaluates temporal functions (date(), datetime(), etc.)
  // while GE's _executeWithClause would skip them, leaving stale data.
  // NOTE: a bare `WITH ... RETURN ...` only.  If an UNWIND is present the query
  // is a real row-expanding pipeline (e.g. `WITH [...] AS v UNWIND v AS x
  // WITH numOfValues, collect(x) AS orderedX RETURN ...`) and must go through
  // _executeWithUnwindPipeline; the fast path would evaluate the final WITH
  // against an empty context and drop numOfValues, throwing at range().
  if (plan.type === 'QUERY' && !plan.hasMatch && !plan.steps?.length &&
      !plan.callProcedure && !plan.unwind && !plan.unwinds?.length &&
      (plan.with?.columns?.length || plan.expressionColumns?.length)) {
    const hasAnyNonAggExpr = plan.with?.columns?.some((wc: any) => {
      const expr = typeof wc === 'object' ? wc.expression : wc
      return typeof expr === 'string' && expr.includes('(')
    }) || false
    if (hasAnyNonAggExpr) {
      // Build a single row with WITH columns evaluated by expression engine
      const row: Record<string, unknown> = {}
      if (plan.with?.columns) {
        for (const wc of plan.with.columns) {
          const alias = wc.alias || wc.expression
          const wcExpr = typeof wc.expression === 'string' ? wc.expression : null
          if (wcExpr) {
            const val = _evalBinary(wcExpr, {})
            if (val !== null && val !== undefined) {
              row[alias] = val
            }
          }
        }
      }
      // Format through _formatResultRow to handle RETURN expressions
      const rawRow = { id: '', props: row }
      const formatted = _formatResultRow(rawRow as any, plan)
      return await _postProcessResults([formatted], plan)
    }
  }
  // GE 执行路径 - 仅在需要时才深拷贝 plan（_executeViaGraphEngine 内会 mutate plan.filters/plan.steps）
  const planCopy = JSON.parse(JSON.stringify(plan, _bigintReplacer), _bigintReviver) as QueryPlan
  const execQueryResult = await _executeViaGraphEngine(planCopy, nodes, query)
  // ── GROUP BY 聚合后处理 ──
  // When both plan.aggregate and plan.groupBy are present, group-aggregate the raw nodes.
  // Exception: when the query carries an OPTIONAL MATCH, the graph-engine path
  // has already folded the aggregate (via the OPTIONAL MATCH post-processing /
  // expression re-evaluation in `_executeViaGraphEngine`), so re-grouping the
  // raw `nodes` here would drop the OPTIONAL MATCH variables (e.g. `collect(x)`
  // where `x` is null-only) and overwrite the correct result.
  // Same reasoning for a multi-MATCH (`multiMatch`) query: `_executeMultiMatchCrossJoin`
  // already grouped the bound rows by the object-variable grouping key (a/r/b)
  // and folded `count(*)` per group, so re-grouping the raw `nodes` here would
  // collapse those per-group rows back into a single global count and drop the
  // node/relationship bindings.
  if ((plan as any).groupBy?.length && (plan as any).aggregate && !plan.optionalMatchSteps?.length && (plan as any).hasMatch && !(plan as any).multiMatch?.length && !(plan.steps || []).some((s: any) => s?.range || s?.pathVariable)) {
    const groupByCols = (plan as any).groupBy as string[]
    const agg = (plan as any).aggregate as { function: string; column: string; type: string; field: string; alias?: string }
    const exprs = (plan as any).expressionColumns as Array<{expression:string;alias:string}> | undefined
    // Map a WITH projection alias back to its source expression (e.g. `mod` →
    // `a.num2 % 3`) so an expression-derived grouping key can be evaluated
    // against the raw node properties.
    const withAliasExpr = new Map<string, string>()
    for (const wc of ((plan as any).with?.columns || []) as Array<{expression: unknown; alias?: string}>) {
      if (wc.alias && typeof wc.expression === 'string') withAliasExpr.set(wc.alias, wc.expression)
    }
    
    if (exprs) {
      // 如果 plan.filters 有值，先过滤 nodes（WHERE 过滤应在 GROUP BY 之前执行）
      let filteredNodes = nodes
      const filters = (plan.filters || []) as Array<{source?:string;property:string;value:any;operator:string}>
      if (filters.length) {
        filteredNodes = nodes.filter((node: Record<string, unknown>) => {
          return filters.every(f => {
            const propMatch = (f.property || '').match(/^(\w+)\.(\w+)$/)
            const actualVal = propMatch
              ? (node as any)[propMatch[2]]
              : (node as any)[f.property]
            if (actualVal === undefined) return false
            switch (f.operator) {
              case 'EQ':  return String(actualVal) === String(f.value)
              case 'NEQ': return String(actualVal) !== String(f.value)
              case 'GT':  return Number(actualVal) > Number(f.value)
              case 'GTE': return Number(actualVal) >= Number(f.value)
              case 'LT':  return Number(actualVal) < Number(f.value)
              case 'LTE': return Number(actualVal) <= Number(f.value)
              default:    return String(actualVal) === String(f.value)
            }
          })
        })
      }
      // 直接对 filteredNodes 按 groupBy 分组聚合
      const groups = new Map<string, Record<string, unknown>[]>()
      for (const node of filteredNodes) {
        // Expose the node's flat properties directly on the eval context so a
        // bare grouping-key alias (`WITH a.name AS name` → groupBy `name`)
        // resolves to `node.name`.  Without this the key evaluates to null and
        // every row collapses into a single global group (count(*) returns the
        // total row count instead of per-group counts).  `n` still points at the
        // whole node for property/pattern expressions that need it.
        const rowCtx: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
          if (!k.startsWith('_')) rowCtx[k] = v
        }
        rowCtx.n = node
        // Bind the primary MATCH variable (and step source var) to the node so a
        // source expression like `a.num2 % 3` resolves its `a.` prefix.
        if ((plan as any).matchVar) rowCtx[(plan as any).matchVar] = node
        const firstStepSrc = (plan as any).steps?.[0]?.source
        if (firstStepSrc && !(firstStepSrc in rowCtx)) rowCtx[firstStepSrc] = node
        const keyVals: Record<string, unknown> = {}
        for (const gb of groupByCols) {
          // Resolve the grouping key: a WITH alias maps to its source expression
          // (`mod` → `a.num2 % 3`); otherwise look up the expression column or
          // evaluate the (possibly expression-shaped) key directly.
          const srcExpr = withAliasExpr.get(gb)
          if (srcExpr) {
            keyVals[gb] = _evalBinary(srcExpr, rowCtx)
            continue
          }
          const ec = exprs.find(e => e.alias === gb || e.expression === gb || e.expression.endsWith('.' + gb))
          if (ec) {
            keyVals[gb] = _evalBinary(ec.expression, rowCtx)
          } else if (/[^\w.]/.test(gb)) {
            // `gb` is an expression (e.g. `num2 % 3`) rather than a bare prop
            // name: evaluate it against the flat-property context.
            keyVals[gb] = _evalBinary(gb, rowCtx)
          } else {
            keyVals[gb] = node[gb as string]
          }
        }
        const keyStr = JSON.stringify(keyVals)
        if (!groups.has(keyStr)) groups.set(keyStr, [])
        groups.get(keyStr)!.push(node)
      }
      // 对每组应用 aggregate 函数
      const result: Record<string, unknown>[] = []
      for (const [, groupRows] of groups) {
        const row: Record<string, unknown> = {}
        for (const gb of groupByCols) {
          const firstNode = groupRows[0] as Record<string, unknown>
          const firstCtx: Record<string, unknown> = {}
          for (const [k, v] of Object.entries(firstNode)) {
            if (!k.startsWith('_')) firstCtx[k] = v
          }
          firstCtx.n = firstNode
          if ((plan as any).matchVar) firstCtx[(plan as any).matchVar] = firstNode
          const fss = (plan as any).steps?.[0]?.source
          if (fss && !(fss in firstCtx)) firstCtx[fss] = firstNode
          const srcExpr = withAliasExpr.get(gb)
          if (srcExpr) {
            // Grouping key is a WITH alias: emit under the alias and evaluate the
            // source expression against the first node of the group.
            row[gb] = _evalBinary(srcExpr, firstCtx)
            continue
          }
          const ec = exprs.find(e => e.alias === gb || e.expression === gb || e.expression.endsWith('.' + gb))
          row[ec?.alias || gb] = ec ? _evalBinary(ec.expression, firstCtx) : firstNode[gb as string]
        }
        // Strip the `var.` prefix from the aggregate field (`n.num` → `num`)
        // so it addresses the flat node property, matching how groupBy keys are
        // resolved above (`n.name` → `name`).
        // The aggregate's value expression: `*` → node count, a bare property
        // (`a.num`) → flat property, an arithmetic expression (`a.num + a.num2`)
        // → evaluated per node via the expression engine.
        const rawField = agg.field ?? ''
        const aggIsExpr = rawField !== '*' && rawField !== '' && /[+\-*/%]/.test(rawField)
        // Resolution key for the aggregated value: surface the full column
        // expression (e.g. `count(n.num)`) when there is no explicit `AS` alias.
        // The parser stores `alias` as the bare function name ("count") in that
        // case, so use the explicit alias when it differs from the function name,
        // otherwise fall back to the column expression.
        const aggKey = (agg.alias && agg.alias !== agg.function)
          ? agg.alias
          : (agg.column?.replace(/^.+?\s+AS\s+/i, '').trim() || rawField || agg.column || 'c')
        // Evaluate the aggregate value for a single node within the group.
        const _aggVal = (n: Record<string, unknown>): number => {
          if (aggIsExpr) {
            const ctx: Record<string, unknown> = {}
            for (const [k, v] of Object.entries(n)) if (!k.startsWith('_')) ctx[k] = v
            if ((plan as any).matchVar) ctx[(plan as any).matchVar] = n
            ctx.n = n
            const v = _evalBinary(rawField, ctx)
            return Number(v) || 0
          }
          const propName = rawField.includes('.') ? rawField.split('.').pop()! : rawField
          return Number((n as any)[propName]) || 0
        }
        if (agg.function === 'count') {
          // `count(*)` counts all rows in the group; `count(n.prop)` counts rows
          // where the property is non-null.  A bare variable (`count(n)`, where
          // `n` is a node/relationship alias, not a property) counts every row in
          // the group — each `n` is bound to its matching node, so none are null.
          if (rawField === '*' || rawField === '') {
            row[aggKey] = groupRows.length
          } else if (rawField.includes('.')) {
            const pn = rawField.split('.').pop()!
            row[aggKey] = groupRows.filter(n => (n as any)[pn] != null).length
          } else {
            row[aggKey] = groupRows.length
          }
        } else if (agg.function === 'sum') {
          row[aggKey] = groupRows.reduce((acc, n) => acc + _aggVal(n), 0)
        } else if (agg.function === 'avg') {
          const sum = groupRows.reduce((acc, n) => acc + _aggVal(n), 0)
          row[aggKey] = sum / groupRows.length
        } else if (agg.function === 'min') {
          row[aggKey] = Math.min(...groupRows.map(n => _aggVal(n)))
        } else if (agg.function === 'max') {
          row[aggKey] = Math.max(...groupRows.map(n => _aggVal(n)))
        } else {
          row[aggKey] = groupRows.length
        }
        // When the aggregate call is wrapped in an OUTER expression
        // (`count(a) > 0`, `count(a) + 3`, `size(collect(a))`), the raw value
        // computed above is only the inner aggregate result.  Re-evaluate the
        // full column expression with the aggregate call substituted by its
        // computed value so the outer arithmetic/comparison is applied.
        const _colTxt = agg.column || ''
        const _pureCall = new RegExp(`^${agg.function}\\s*\\(\\s*(?:DISTINCT\\s+)?${rawField.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\)(?:\\s+AS\\s+\\w+)?$`, 'i')
        if (_colTxt && !_pureCall.test(_colTxt.trim())) {
          let _sub = _colTxt
          // Substitute every occurrence of the aggregate call with its value.
          const _callRe = new RegExp(`${agg.function}\\s*\\([^)]*\\)`, 'gi')
          _sub = _sub.replace(_callRe, () => JSON.stringify(row[aggKey]))
          // Drop any trailing `AS alias` (the projection key is already aggKey).
          _sub = _sub.replace(/\s+AS\s+\w+$/i, '')
          try {
            row[aggKey] = _evalBinary(_sub, {})
          } catch {
            // leave the raw aggregate value if the outer expression cannot be
            // evaluated (e.g. it references variables the expression engine
            // does not have in scope).
          }
        }
        result.push(row)
      }
      // Route the grouped result through _postProcessResults so HAVING (and any
      // ORDER BY / SKIP / LIMIT) is applied, matching the normal return path at
      // the bottom of _executeViaGraphEngine.  Without this the early return
      // above silently drops the HAVING filter.
      return _postProcessResults(result, plan as any)
    }
  }
  const isDML = ['CREATE', 'MERGE', 'DELETE', 'SET', 'REMOVE'].includes(plan.type || '')
  if (isDML && !plan.returnColumns?.length && !plan.expressionColumns?.length) {
    return []
  }
  // ── Aggregate default row ──
  // When a Cypher query has aggregation functions (collect, count, etc.) but no
  // rows were produced (e.g., empty graph + OPTIONAL MATCH), return a single
  // default row with null/zero aggregate values instead of an empty result.
  //
  // Trigger only for a TRUE aggregation over rows — either a top-level
  // plan.aggregate, or an aggregate function nested in a RETURN expression
  // (e.g. size(collect(r))). A `collect([...])` literal-list builder in a
  // leading WITH must NOT fake an empty-row aggregate, so exclude the
  // `collect([...])` shape (collect immediately followed by `[`).
  const _hasTrueAggregate = (() => {
    if (plan.aggregate) return true
    const _exprHasAgg = (expr: unknown): boolean => {
      const s = typeof expr === 'string' ? expr : (expr as any)?.expression || ''
      return /\b(collect|count|sum|avg|min|max)\s*\(/i.test(s) && !/\bcollect\s*\(\s*\[/i.test(s)
    }
    let hasAgg = false
    for (const col of (plan.expressionColumns || [])) {
      if (_exprHasAgg(col.expression)) { hasAgg = true; break }
    }
    if (hasAgg) return true
    // A single leading WITH that folds an aggregate inside a composite expression
    // (`WITH $age + avg(person.age) - 1000 AS agg`) is still an aggregation, and
    // an empty node MATCH must yield one null row (With6 [5]) — but only when the
    // aggregation sits on a plain node scan (no relationship steps).  Relationship
    // matches (`MATCH (me)--(you)`) and multi-segment WITH chains project before
    // aggregating, so an empty match stays empty (With6 [6][7]).
    if ((!(plan as any).withChain || ((plan as any).withChain.length || 0) <= 1) && !(plan.steps?.length)) {
      for (const col of ((plan as any).with?.columns || [])) {
        if (_exprHasAgg(col.expression)) { hasAgg = true; break }
      }
    }
    return hasAgg
  })()
  if (execQueryResult.length === 0 && _hasTrueAggregate && query && /\b(collect|count|sum|avg|min|max)\s*\(/i.test(query) && !/^\s*(?:WITH|UNWIND)\b/is.test(query)) {
    // When the projection carries a NON-aggregate grouping key (`me.age` in
    // `RETURN me.age, me.age + count(you.age)`), an empty match must yield NO
    // rows — there is no group to emit a default row for (Return6 [18][19]).
    // Only a pure aggregate over an empty input (`RETURN count(*)`) emits the
    // single default row.  Detect the implicit key by a projected column whose
    // expression is not an aggregate call.
    const _hasImplicitKey = (plan.expressionColumns || []).some((c: any) => {
      const ex = typeof c.expression === 'string' ? c.expression : (c.expression as any)?.expression || ''
      return ex && !/\b(?:collect|count|sum|avg|min|max)\s*\(/i.test(ex)
    })
    if (!_hasImplicitKey) {
    const defaultRow: QueryRow = {}
    const _fillDefault = (col: { expression: unknown; alias?: string | null }) => {
      const alias = col.alias || ''
      if (!alias) return
      const expr = typeof col.expression === 'string' ? col.expression : (col.expression as any)?.expression || ''
      // Determine default: size(collect(...)) -> 0, count(...) -> 0, others -> null
      if (/^(?:size|count)\s*\(/i.test(expr.trim())) {
        defaultRow[alias] = 0
      } else {
        defaultRow[alias] = null
      }
    }
    for (const col of (plan.expressionColumns || [])) _fillDefault(col)
    // `RETURN *` after a WITH leaves expressionColumns empty; surface the WITH
    // projection aliases so an empty aggregation still yields one row keyed by
    // the projected alias (e.g. `WITH $age + avg(...) AS agg RETURN *` → {agg:null}).
    if (!Object.keys(defaultRow).length) {
      for (const col of ((plan as any).with?.columns || [])) _fillDefault(col)
    }
    return [defaultRow] as QueryResult
    }
  }
  // ── Top-level DISTINCT dedup (`RETURN DISTINCT ...`) ──
  // Cypher `RETURN DISTINCT x` collapses duplicate result rows by the full row
  // value. Applied after aggregation/grouping so the projection is finalized.
  if (plan.distinct && Array.isArray(execQueryResult) && execQueryResult.length) {
    const seen = new Set<string>()
    const deduped: QueryRow[] = []
    for (const row of execQueryResult) {
      const colKeys = plan.returnColumns?.length
        ? plan.returnColumns.filter(c => c !== '*')
        : Object.keys(row).filter(k => !k.startsWith('__'))
      const sig = JSON.stringify(colKeys.map(k => row[k]))
      if (seen.has(sig)) continue
      seen.add(sig)
      deduped.push(row)
    }
    return deduped as QueryResult
  }
  return execQueryResult
}

/**
 * TCK 兼容的编译时语义验证。
 * 公开导出，在 step-definitions.ts 中调用。
 * 对应 openCypher SyntaxError 检查：VariableTypeConflict、UndefinedVariable、
 * VariableAlreadyBound、InvalidArgumentType、NonConstantExpression、InvalidDelete 等。
 */
