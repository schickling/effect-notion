# Decision: admit semantic events and dispatch performance explicitly

## Status

Accepted.

## Context

The CI workflow admitted `pull_request:labeled` only so a `ci:perf` label could start the paired `devenv-perf` lane. Every other job then needed a guard because applying a label did not change the revision under test. The event created workflow and check-suite noise, coupled a repository label to execution, and made event admission describe implementation mechanics rather than outcomes.

`devenv-perf` previously ran on every pull request and later on a nightly schedule plus label opt-in. Three consecutive runs took 35.0, 35.7, and 35.0 minutes against a 37.4-minute whole-run wall clock. With historical comparison advisory, it did not make a merge decision. The nightly execution was likewise not needed for the deterministic measurement trend report.

At the same time, branch protection can only require checks that materialize on every pull request. The current job inventory correctly excludes dispatch-only, main-only, and advisory jobs. Separate control workflows also need to handle valid no-op actions without suppressing their check-suite conclusion.

## Options

| Option                                                                  | Outcome                                                                                                           | Decision  |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------- |
| Keep `pull_request:labeled` and guard unrelated jobs                    | Preserves label opt-in but admits a revision-neutral event and spreads negative guards across the workflow.       | Rejected. |
| Keep nightly performance only                                           | Retains automatic trend samples but pays recurring 35-minute work without a current consumer or merge decision.   | Rejected. |
| Dispatch performance explicitly; retain semantic scheduled measurements | Removes label coupling and recurring perf cost while preserving operator access and deterministic trend evidence. | Accepted. |
| Delete performance machinery                                            | Lowest maintenance cost, but removes an existing bounded probe that operators still need.                         | Rejected. |

## Decision

1. Admit only workflow events with a meaningful outcome. The CI pull-request trigger includes `opened`, `reopened`, and `synchronize`; it does not include `labeled`.
2. Run `devenv-perf` only for `workflow_dispatch`. Remove the `ci:perf` label from the repository catalog and remove all workflow/source coupling to that label.
3. Retain the nightly schedule for `nix-closure-sizes`, `source-shape`, and `ci/measurements-report`, whose deterministic trend artifacts are the schedule's explicit outcome. Do not run product validation or `devenv-perf` on that schedule.
4. Derive required checks from jobs that materialize on every pull request. Dispatch-only, main-only, and advisory jobs remain excluded.
5. For an admitted event where a side effect is validly unnecessary, put the condition on the step rather than the job so the check suite still concludes successfully. Do not add a sentinel job for irrelevant events.
6. Keep per-admission Buck2 performance evidence as a targeted probe in the admission's experiment record rather than inferring it from the whole-repository `devenv-perf` lane.

## Consequences

- Label changes no longer launch CI or change its workload.
- Pull-request event admission directly expresses revision validation, and the obsolete event guards disappear.
- Operators can still request the full paired performance workflow explicitly, including measurement baseline backfill.
- The deterministic nightly trend series remains continuous; the wall-clock lane no longer accrues automatic samples.
- `devenv-perf` cannot be a required check because it does not materialize on every pull request.
- Main-only checks stay out of branch protection, avoiding required contexts that no PR run creates.
- The existing performance probe definitions, runner choice, observation IDs, and artifact schema remain unchanged.
