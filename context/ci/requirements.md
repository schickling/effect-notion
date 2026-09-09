# Requirements: repository CI

## Scope

- The CI control plane must remain repository-local: workflow events, check conclusions, required-check policy, execution cost and cadence, and generated workflow authority.
- This VRS must not define cross-repository workflow or branch-protection policy.

## Event admission

- Every admitted workflow event must have a meaningful outcome: validate a changed revision, publish a trunk result, produce a scheduled measurement, or execute an explicit operator request.
- Pull-request activity types that do not change the revision under test must not be admitted merely to start a runner.
- A valid event whose action is conditionally unnecessary must still finish its check suite successfully; the action must be gated at step level rather than skipping the job.
- CI must not create sentinel jobs whose only purpose is to make an irrelevant event appear successful.

## Pull-request checks

- Every merge-blocking required check must produce a check run on every admitted pull request.
- Every non-advisory job that runs on every pull request must be represented in the generated required-check ruleset.
- A scheduled, dispatch-only, opt-in, or main-only lane must not be a required pull-request check.
- Matrix jobs must use the exact check-context names GitHub emits for every supported runner profile.
- Main-only jobs must remain excluded from required pull-request checks even though they are present in the generated workflow.

## Performance and measurements

- `devenv-perf` must run only when an operator explicitly invokes `workflow_dispatch`.
- Pull-request labels must not admit performance work or otherwise change the CI workload.
- The repository must not catalog a `ci:perf` capability label.
- Deterministic scheduled measurement lanes may retain their cadence when the scheduled run produces durable trend evidence.
- Measurement jobs and reports must preserve stable observation identity and distinguish advisory evidence from merge-blocking conclusions.

## Cost and cadence

- Each lane's cadence must match the outcome it produces and the cost of producing it.
- Expensive diagnostic or trend probes must not be placed on the pull-request critical path without an explicit merge decision they can affect.
- Scheduled events must not rerun product validation that has no schedule-specific outcome.

## Generated authority

- TypeScript `.genie.ts` files must be the authoring source for generated workflow, label, and repository-ruleset outputs.
- Checked-in generated outputs must remain byte-derived from their Genie sources and must not be hand-edited.
- Workflow job names and required status-check contexts must share one typed source of truth.
