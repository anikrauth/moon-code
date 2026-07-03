---
name: define-goal
description: Help the user define a concrete, measurable goal before starting work.
---
# Define Goal

Shape the user's intent into an objective an agent can pursue honestly. Prefer measurable outcomes, explicit evidence, and bounded scope over activity descriptions.

## Workflow

1. Confirm that goal definition is actually needed.
   - Use this skill when the user asks to create or set a goal, or wants help turning an intention into a clear objective.
   - If the user only asks for ordinary implementation work, do the work directly instead of forcing goal creation.

2. Restate the likely goal in concrete terms.
   A usable goal names:
   - the specific outcome that will be true
   - the main artifact, system, repo, environment, or user-facing behavior involved
   - how completion will be verified
   - what is in scope
   - what is out of scope when ambiguity would matter
   - the stop condition for asking the user instead of grinding

3. Make it quantitative when the domain supports it.
   Prefer numbers that represent real success:
   - pass/fail validators: exact tests, checks, CI jobs, evals, commands, or acceptance criteria
   - quality thresholds: latency, error rate, cost, accuracy, recall, precision, coverage, flake rate, bundle size, memory, uptime
   - artifact constraints: file paths, affected modules, allowed commands, output formats, target environments, deadlines, or maximum blast radius
   - evidence counts: number of reproduced failures, successful reruns, reviewed examples, migrated records, addressed comments, or verified cases

4. Repair weak goals before setting them.
   - Rewrite vague goals into measurable objectives when local context makes the rewrite safe.
   - Ask one concise clarification question when the missing detail changes the intended outcome or validation.
   - Reject pure activity goals such as "make progress," "keep investigating," or "work on X" unless sharpened into a verifiable outcome.

## Goal Quality Bar

Before committing to a goal, the objective should answer:

- What concrete thing will be true when this is done?
- What evidence will prove it?
- What quantitative or binary threshold defines success?
- What scope boundaries matter?
- What should cause the agent to stop and ask?

Good:

> Reduce checkout API p95 latency below 250 ms for the documented slow path by making the smallest safe server-side change, then verify with `npm run test:checkout` and the existing local latency benchmark showing p95 under 250 ms across 3 consecutive runs.

Weak:

> Make checkout faster.

## Quantification Heuristics

- For bugs, define success as reproduction first, fix second, and a failing-then-passing validator when possible.
- For tests, name the exact command and required pass condition.
- For performance, name the metric, target threshold, measurement method, and number of runs.
- For quality work, define an observable acceptance bar such as reviewed examples, lint/typecheck/test pass, or user-approved artifact.
- For research, define the decision the research must enable, the sources or systems in scope, and the evidence standard.
- For operations, define healthy state, monitoring window, failure threshold, and rollback or escalation trigger.

## Clarifying Questions

Ask only when a reasonable rewrite would risk pursuing the wrong outcome. Keep the question short and oriented around the missing validator or scope boundary.

Useful question shapes:

- "What metric should define success here: latency, cost, accuracy, or user-visible behavior?"
- "Which environment should I verify against: local, staging, or production?"
- "What is the minimum evidence you want before I mark this goal complete?"

If the user cannot provide a metric, propose the most honest binary validator available and ask for confirmation.
