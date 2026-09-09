# Repository CI Ontology

The domain language for the effect-utils repository-local CI control plane.

## Language

**Event**:
A GitHub occurrence admitted by a workflow trigger, including a named event and, where applicable, an activity type. An event is admitted only when the workflow has a meaningful outcome for it. A label mutation and a PR-head update are different events even when they refer to the same pull request.

**Lane**:
One workflow job or job matrix that produces a coherent validation, publication, or measurement outcome. A lane has a cadence, cost, check-run identity, and conclusion policy. _Avoid_: using lane for an individual shell step.

**Check run**:
GitHub's result for one materialized job context. Branch protection requires check-run context names. A skipped or unmaterialized lane cannot be assumed to create the required check run.

**Check suite**:
The GitHub grouping of check runs produced for one workflow execution and revision. A valid conditional no-op should leave its suite successful by gating the optional step, not by suppressing the job that anchors the suite outcome.

**Required check**:
A check-run context named by the repository ruleset that must conclude successfully before merge. It must exist on every pull request. Main-only, scheduled, dispatch-only, and advisory contexts are not required checks.

**Gate**:
A decision boundary that admits or rejects progress from evidence. A step or job can fail as a gate; the ruleset promotes selected stable check contexts into merge gates. A conditional side effect is not automatically a gate.

**Probe**:
A bounded measurement procedure that emits an observation or evidence artifact. A probe may run inside a lane or be targeted to one admission. Probe identity and protocol must be stable enough for comparison; its containing lane's cadence is a separate concern.

**Cadence**:
The event schedule on which a lane pays its cost and produces its outcome: every pull request, trunk push, scheduled run, or explicit dispatch. Cadence is a semantic design choice, not merely workflow syntax, because it determines attribution, availability as a required check, and recurring cost.

## Relations

```text
event
  admits workflow execution
    groups check runs into check suite
      materializes lane(s)
        execute steps and probes
        conclude check runs
          selected contexts become required checks through the ruleset

lane cadence
  determines when outcome exists
  determines recurring cost
  constrains required-check eligibility
```

## Usage rules

- Say an event is **admitted** when it is present in the workflow trigger, not merely when a job condition happens to accept it.
- Say a lane is **dispatch-only** when `workflow_dispatch` is its only cadence, even if the containing workflow admits other events for other lanes.
- Say a check is **required** only when its exact emitted context is present in the generated repository ruleset.
- Say a measurement is **advisory** when its result informs review but cannot reject merge; do not use _required_ to describe artifact production unless the job context is actually in the ruleset.
- Keep **probe** distinct from **lane**: targeted evidence need not create a standing per-PR lane.
