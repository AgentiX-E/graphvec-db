# Pattern Compile-time Validation Plan

Created: 2026-08-29 15:50

## Goal
Fix the 18 remaining Pattern1 compile-error scenarios (all require a semantic
error to be thrown at compile time but currently no error is raised).

## Targets
- [10] x 14: `UndefinedVariable` — pattern predicate introduces an unbound
  variable, e.g. `MATCH (n) WHERE (a)-[r]->(n) RETURN n` (a unbound) or
  `(n)-[]->(a)` (a unbound).
- [11]: self pattern `(n)` → `InvalidArgumentType` (a pattern must have a
  relationship; a bare node `(n)` is not a valid pattern).
- [22]: pattern in RETURN projection → `UnexpectedSyntax`.
- [23]: pattern in WITH projection → `UnexpectedSyntax`.
- [24]: pattern in SET RHS → `UnexpectedSyntax`.

## Steps
- [ ] Locate `_validateUndefinedVariables` and understand how it walks the plan.
- [ ] Make it inspect WHERE pattern predicates and flag unbound variables
      introduced by the pattern (endpoints + relationship var).
- [ ] Add `InvalidArgumentType` for self/relationship-less pattern `(n)`.
- [ ] Add `UnexpectedSyntax` for pattern used in RETURN/WITH/SET (illegal context).
- [ ] Run Pattern1 (expect 39/39 or near), quick regression, full TCK.
- [ ] Add unit tests (coverage >= 95% for the new validation branches).
- [ ] Commit as Lambertyan (English).

## Progress
Step: locating validators.
