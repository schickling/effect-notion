# Decision 0031: Static operation authority follows bounded inputs

## Status

Accepted on 2026-09-11.

## Problem

The former CI static lanes mixed deterministic repository checks with package-manager installation,
change-relative history, Nix realization, and live integration. Treating each aggregate job as one
portable Buck action would either hide undeclared inputs or duplicate those external producers inside
Buck.

## Decision

Buck owns deterministic formatting, type-aware linting, repository policy, and the Vite/Rollup bundle
contract. Each action consumes generated package views or explicit repository source sets and publishes
one target-addressed result. Source tasks and CI call those targets; they do not retain alternate
implementations.

The remaining aggregate boundaries are classified rather than disguised:

- `lint:check` and the CI `lint` job remain `buck-pending:editor` while their lockfile member still runs
  `pnpm install --frozen-lockfile`. The editor-authority cutover owns removing that root installation
  producer.
- `default-ref-policy` remains an outside-Buck trust gate. It checks the checkout before composition,
  because applying non-default first-party refs before rejecting them would execute the inputs the gate
  exists to reject.
- The CI `weaver` job remains outside Buck because it deliberately combines a merge-base-relative API
  diff, a live OTLP subprocess integration, and Nix-realized Weaver availability semantics. These are
  not bounded repository-static actions.
- `source-shape` remains a CI measurement producer: its run-stamped comparison artifact is evidence,
  not a reproducible build product.
- Generation freshness remains the stage-zero exception in Decision 0030. Default-ref policy is the
  corresponding pre-composition trust-gate exception.

## Consequences

- `bundle:smoke` is a Buck Vitest lane over the normalized `@overeng/pty-effect` package view. Vite and
  Rollup resolve only from that declared dependency closure.
- A package may publish multiple independently named Buck test lanes. Targets, task names, collection
  artifacts, and cross-lane source ownership remain unique; package identity is not incorrectly treated
  as the lane identity.
- Weaver policy remains visible in the operation-disposition artifact instead of producing false
  hermeticity claims.
- Moving a remaining aggregate to `buck-owned` requires first splitting or eliminating its external
  members.

## Rejected alternatives

- **Reimplement Weaver validation in TypeScript:** duplicates an upstream semantic validator and would
  provide weaker evidence.
- **Run default-ref policy through composed Buck:** rejects invalid first-party refs only after
  `mr:apply` has materialized and executed setup from them, reversing the trust boundary.
- **Let Buck invoke `nix build` or inspect the live Git merge base:** creates undeclared, mutable inputs
  inside an action.
- **Call the whole lint job Buck-owned now:** its lockfile check still realizes and mutates the root pnpm
  dependency topology.
