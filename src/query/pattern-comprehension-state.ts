/**
 * pattern-comprehension-state.ts — active node array for pattern comprehensions
 *
 * A pattern comprehension such as `[p = (n)-->() | p]` must traverse outgoing
 * relationships.  The expression engine only receives row-scoped node objects
 * that carry `_label`/`_alias` but NOT their `__edges`, so it cannot enumerate
 * relationships directly from the row.
 *
 * This module is deliberately dependency-free (it imports nothing) so that the
 * expression engine — a self-contained pure-function module — can read the
 * full node array (with `__edges`) built by the executor without introducing a
 * circular import.
 */

let _activePatternNodes: Array<Record<string, unknown>> | null = null

/**
 * Set the node array (with `__edges`) for the current query execution.
 * The executor installs this right after building `allNodes` and clears it in
 * its `finally` block.
 */
export function _setActivePatternNodes(nodes: Array<Record<string, unknown>> | null): void {
  _activePatternNodes = nodes
}

/**
 * Read the node array (with `__edges`) for the current query execution, or
 * `null` when no execution is in flight (e.g. plain expression evaluation in
 * unit tests).
 */
export function _getActivePatternNodes(): Array<Record<string, unknown>> | null {
  return _activePatternNodes
}
