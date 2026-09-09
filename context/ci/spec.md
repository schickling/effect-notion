# Spec: repository CI

This document specifies the repository-local GitHub Actions control plane for effect-utils.

## Status

Active.

## Scope

**Defines:** admitted events, lane cadence, check-run and check-suite outcomes, required-check derivation, measurement cost policy, and generated-file authority.

**Does not define:** cross-repository policy, organization rulesets, runner-fleet operations, or the implementation contract of individual build and test tools.

Requirements are in [requirements.md](./requirements.md), domain terms are in [ontology.md](./ontology.md), and the event/cadence choice is recorded in [.decisions/0001-event-admission-and-performance-dispatch.md](./.decisions/0001-event-admission-and-performance-dispatch.md).

## Event admission

The generated CI workflow admits:

| Event               | Admitted shape                      | Meaningful outcome                                                                    |
| ------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `pull_request`      | `opened`, `reopened`, `synchronize` | Validate the PR head revision and produce every required check.                       |
| `push`              | `main`                              | Validate the merged trunk revision and run eligible main-only work.                   |
| `schedule`          | `17 3 * * *`                        | Produce deterministic measurement artifacts and the aggregate trend report.           |
| `workflow_dispatch` | explicit operator request           | Run the requested CI/measurement work, including `devenv-perf` and baseline backfill. |

`pull_request:labeled` is not admitted. Applying a label does not change the revision under test and no label selects a CI lane. The workflow therefore does not need job guards or a runner sentinel to neutralize label events.

Some control-event workflows admit actions where the requested side effect is validly unnecessary. Those workflows keep the job alive and gate only the conditional step, so GitHub produces a successful check suite rather than an absent required check. The auto-review workflow is the current example: its review-request step is conditional, while the job itself always concludes.

## Lane semantics

A **lane** is one workflow job (or a job matrix) with one declared cadence and outcome.

- Product and source-policy lanes run for admitted PR revisions.
- Main-only lanes run only after changes reach `main` or through an authorized dispatch.
- `nix-closure-sizes` and `source-shape` also run on the scheduled measurement event because they produce deterministic trend artifacts.
- `devenv-perf` is dispatch-only. It has no pull-request label coupling and does not run on the schedule.
- `ci/measurements-report` aggregates the measurement artifacts produced by the current push, schedule, or dispatch and remains advisory.

The schedule is retained for deterministic trends, not as a generic nightly rerun of product CI. Product jobs carry the schedule guard because a cron with no changed revision has no product-validation outcome.

## Checks and ruleset

GitHub creates a check run for each materialized job and groups runs from one workflow execution in a check suite. Branch protection names required check-run contexts, not source-level job keys.

`genie/ci.ts` is the typed inventory for workflow job keys and required contexts:

- `CORE_CI_JOB_NAMES` and `EXTRA_CI_JOB_NAMES` are non-advisory pull-request jobs;
- `MAIN_ONLY_CI_JOB_NAMES` contains jobs that do not materialize on pull requests;
- `OPT_IN_CI_JOB_NAMES` contains `devenv-perf`, whose dispatch-only cadence prevents it from being required;
- `advisoryCIJobNames` contains report/notification jobs whose conclusions do not gate merge;
- `REQUIRED_CI_JOB_NAMES` contains the default-ref policy job plus every core and extra PR job, and excludes opt-in, main-only, and advisory jobs;
- `ciJobCheckContexts` expands matrix job keys to the exact runner-qualified context strings emitted by GitHub.

The main-only exclusion is deliberate and fixes the absent-check failure mode: requiring `test-integration-notion`, `test-live-deploy-ci-tools`, or `deploy-storybooks` on a pull request would leave branch protection waiting for check runs that the workflow never creates.

`.github/repo-settings.json.genie.ts` derives the repository ruleset directly from `requiredCIJobs`. Tests compare the generated workflow's eligible check contexts with the generated ruleset, including matrix expansion and the exclusions above.

## Gates and no-op actions

A gate decides whether evidence permits progress. It may be expressed by a failing step/job or by a required check in the ruleset.

A condition that selects whether an action is needed belongs on the step when the surrounding event remains semantically valid. A condition that describes whether an entire lane has an outcome belongs on the job. Event filters are preferred when an event has no meaningful lane outcome at all.

This ordering avoids two failure modes:

1. job-level skipping of a valid no-op action can omit a check needed by the suite; and
2. admitting an irrelevant event and launching a sentinel consumes a runner without producing evidence.

## Measurement cost and cadence

Measurement semantics are specified in [measurements.md](./measurements.md); the reusable comparison boundary is specified in [measurement-engine.md](./measurement-engine.md).

`devenv-perf` retains its probes, runner profile, observation IDs, and artifact contract, but an operator must request it with `workflow_dispatch`. Its wall-clock evidence is advisory and cannot justify automatic pull-request or nightly cost. Targeted Buck2 admission evidence remains recorded with the relevant admission experiment rather than inferred from this whole-repository lane.

The scheduled deterministic lanes remain because their artifacts have stable identities and their trend report is the event's explicit output.

## Generated authority

The editable authorities are:

| Concern                              | Authority                                                                      | Generated output                     |
| ------------------------------------ | ------------------------------------------------------------------------------ | ------------------------------------ |
| workflow events, jobs, and job gates | `.github/workflows/ci.yml.genie.ts` plus shared `genie/ci-workflow.ts` helpers | `.github/workflows/ci.yml`           |
| job inventory and required contexts  | `genie/ci.ts`                                                                  | consumed by workflow/ruleset sources |
| repository required checks           | `.github/repo-settings.json.genie.ts`                                          | `.github/repo-settings.json`         |
| repository labels                    | `.github/labels.json.genie.ts` and shared label catalogs                       | `.github/labels.json`                |

Generated YAML and JSON are checked-in review artifacts, never independent authoring surfaces.

## Traceability

| Requirement area          | Source/evidence                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------------------- |
| event admission           | `.github/workflows/ci.yml.genie.ts`; focused workflow helper tests                                 |
| required checks           | `genie/ci.ts`; `.github/repo-settings.json.genie.ts`; generated-contract test                      |
| dispatch-only performance | `.github/workflows/ci.yml.genie.ts`; `.decisions/0001-event-admission-and-performance-dispatch.md` |
| measurement semantics     | `measurements.md`; `measurement-engine.md`; `.experiments/0001-bencher-evaluation.md`              |
| generated authority       | `AGENTS.md`; `.gitattributes`; the source/output pairs above                                       |
