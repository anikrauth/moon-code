---
name: structured-investigation
description: Structured methodology for bug fixes and behavior changes to existing code. Load BEFORE editing files whenever the task is "X is wrong / X should behave differently" rather than a new feature. Enforces requirement restatement, data-flow tracing to the source, precedent reuse, sibling-site sweeps, and sentinel-fallout audits.
---

# Structured Investigation

Discipline for bug-fix and behavior-change tasks. The core failure mode this
prevents: patching where the symptom appears instead of where the data is
created. Scope: applies when changing existing behavior. Does NOT apply to
greenfield features — build those normally.

On load, seed set_progress with these phases as the checklist (collapse 4–6
into one step for small changes): Restate → Trace → Precedent → Fix all sites →
Audit fallout → Verify.

## 1. Restate before you read code

Rewrite the requirement in your own words: current behavior, desired behavior,
and the concrete case that exposes the difference. List edge cases the request
leaves ambiguous (empty values, ties, nulls, boundary rows, multi-membership).
If an ambiguity changes the design — especially in calculation, aggregation, or
money logic — stop and call ask_user with concrete options before editing.
Cosmetic ambiguities: pick a sensible default and state it.

## 2. Trace the data flow before editing

Walk the full path of the wrong value:
- Where is it RENDERED (UI, report, API response)?
- Where is it PRODUCED (query, row construction, computation)?
- Every transform layer in between (merge, group, format).

Name the layer where the value first becomes wrong. That is the fix site.
The root cause lives where data is CREATED, not where the symptom shows.
Fixing at the display/merge layer masks the bug and breaks the next consumer.

## 3. Find precedent before inventing rules

Before writing a new condition that answers a semantic question ("is this
active?", "does this count as assigned?", "is this billable?"), grep for an
existing predicate, branch, enum check, or helper that already answers it
elsewhere. Reuse it verbatim — same fields, same operators, same null
handling. Borrowed semantics stay consistent with the rest of the app; freshly
invented semantics are where new bugs come from. Only define a new rule if the
search genuinely comes up empty, and say so.

## 4. Fix every site of the pattern

The same logic almost always exists in sibling code: other reports, parallel
services, near-duplicate queries. Grep for distinctive fragments of the code
you are changing (field names, join shapes, the old predicate) and list all
hits. Fix all of them or explicitly tell the user which ones you are leaving
and why. Two outputs computing the same thing differently is a worse state
than the original bug.

## 5. Audit sentinel fallout

If the fix introduces a placeholder or sentinel value ("Unassigned", "Unknown",
empty-group rows, 0-as-missing), trace every downstream consumer of that value:
group-bys, merges, totals, sorts, filters, exports. Confirm the sentinel either
aggregates correctly or is explicitly excluded. Placeholders that leak into
merged output are the classic second-order bug of a first-order fix.

## 6. Confirm data availability

Verify each field the fix reads is actually present in the query/select/DTO at
that layer — read the select list, don't assume. If a cast (`as any`,
non-null `!`, dict.get with default) is hiding a missing field, widen the query
or type properly. Never ship a fix that type-checks only because a cast
silenced the gap.

## 7. Verify

- Run the typechecker/linter for the touched packages.
- Mental table test: 3+ concrete input rows (normal case, edge case from
  step 1, sentinel case from step 5) traced by hand through the new code to
  expected output.
- Run existing tests covering the touched files; add a regression test if the
  project has a test suite and the bug was logic (not cosmetic).

## Red flags — stop if you catch yourself doing any of these

- Editing the file where the symptom appears without having traced where the
  value is produced.
- Writing a brand-new `if` condition for a concept the codebase already tests
  somewhere else.
- Fixing one report/service when grep shows the same logic in siblings.
- Introducing a placeholder value without checking who consumes it downstream.
- Adding `as any` (or equivalent) to make the fix compile.
- Declaring done without a typecheck and a concrete-scenario walkthrough.
- Silently choosing an interpretation of an ambiguous calculation requirement
  instead of asking.
