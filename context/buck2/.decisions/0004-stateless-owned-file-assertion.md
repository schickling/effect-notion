# 0004 Stateless Owned-File Assertion

Status: accepted

Implementation: `packages/@overeng/buck2-tools/src/owned-files.ts`.

## Context

Typed Buck-owned file sets cannot by themselves detect a supported file absent
from the declared graph. Giving a Buck action the whole repository would create
a coarse invalidation boundary, while evaluating patterns in Genie would
duplicate Buck's package and glob semantics.

## Evidence and Argument

The preceding source-ownership prototype showed that typed Buck file sets can
admit a matching file without rewriting generated BUCK bytes. An adversarial
design pass then exposed the completeness paradox: a normal Buck action cannot
detect a supported file absent from the graph unless the action receives a
repository-wide input. That input would invalidate the census broadly and
would still couple correctness evidence to the graph under test.

Evaluating the patterns in Genie avoids the broad Buck input but implements a
second matcher whose package and glob semantics can disagree with Buck. A
stateless external join avoids both defects: Git supplies the candidate path
universe, one batched Buck ownership query supplies actual membership, and the
command owns only deterministic cardinality classification. The decision is a
design conclusion; native-Buck replacement remains possible without changing
the report contract.

## Options

| Option                                                 | Tradeoff                                                                                                     | Outcome  |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------ | -------- |
| Stateless Git-universe and batched Buck-ownership join | Adds one repository-wide metadata gate without making it an action input                                     | Accepted |
| Repository-wide Buck action                            | Buck-native scheduling, but necessarily creates the coarse invalidation boundary and undeclared-file paradox | Rejected |
| Genie filesystem matcher                               | Simple workflow integration, but duplicates Buck matching semantics                                          | Rejected |

## Decision

Use one stateless command that enumerates Git tracked and nonignored untracked
candidate paths, submits them to one batched Buck ownership query, and performs
only a deterministic zero/one/many join. Buck is the sole file-set matcher.

The command emits sorted `buck-owned-files/v1` JSON and exits pass or fail. It
has no daemon, database, cache, committed report, custom matcher, graph
compiler, BXL framework, or repository-wide Buck action. The supported-file
policy is projected from the semantic package model rather than duplicated in
the checker.

## Consequences

- Undeclared and multiply owned supported files fail closed.
- Ordinary Buck actions retain fine-grained inputs and cache identities.
- Genie freshness, semantic completeness, and Buck execution remain distinct
  checks with distinct authorities.
- The command can be replaced by a future native Buck equivalent without
  changing the semantic model or report contract.
