# Buck2 Repository Build Ontology

## Language

**Semantic Operation** is a bounded deterministic repository-local unit such as
a check, test suite, compilation, or package build.

**Configured Operation** is a Semantic Operation paired with its declared input
closure, target platform, execution platform, toolchain, and policy.

**Execution Platform** is where an action runs. **Target Platform** is what its
result is for. Both are named labels; label identity, not content, enters the
configuration hash.

**Admission** is the evidence-backed grant by which a Configured Operation and
platform tuple makes Buck its sole producer. **Authority Transfer** is the
change that consumes an admission and deletes the superseded producer.

**Workspace** is the unit of work: a synthesized composition root at the
store worktree path containing every repository as a member mount. Every
build runs from one; a workspace is disposable and is never itself a git
repository.

**Owned Member** is a Workspace's single writable member — the
branch-attached git worktree of the repo the workspace exists to develop, on
a branch the workspace owns. It is the default working directory.

**Member Mount** is any other member: a read-only `cp -a` copy of its locked
revision, advanced atomically by RENAME_EXCHANGE.

**Member Cell** is a megarepo member mounted at its canonical path
(`repos/<name>`) under its canonical cell name inside a Workspace. Every
repository, including the Owned Member, is a Member Cell.

**Materialization** is a Buck action that produces a dependency surface
(a package's `node_modules` tree) from manifests, the lockfile, and patches
only. The pnpm store supplies bytes; manifests supply identity.

**Editor Surface** is the stable, atomically-flipped view of materializations
that editors and test runners resolve through. It is Buck-produced state, never
hand-installed.

**Shared Cache** is the fleet REAPI action cache and CAS (bazel-remote on
dev3). **Cache Namespace** is the key space determined by composition shape,
cell names, platform labels, and isolation dir; discipline keeps it singular.

**Candidate Namespace** is an explicitly named cache namespace and isolation dir
in which staged prerequisite work is built and measured before an authority
flip. Its keys never overlap production keys, and a measurement taken in it is
reported as a candidate measurement.

**Development Loop** is the watch loop that turns a source edit into a rebuilt
affected closure plus atomic republication of the editor snapshots whose view
fingerprint changed. It is a caller of Buck, never a producer or an authority.

**BuildProduct** is normalized Buck-produced payload bytes plus a portable
descriptor of entrypoints, target-platform/runtime constraints, and semantic
provenance. It contains no live-system state.

**Nix Import** is independent validation of a BuildProduct followed by creation
of a Nix store result without rebuilding repository sources.

**Native Evidence** is Buck's event log, build report, invocation identity, and
supported derived queries.

**Deletion Ledger** is the roadmap record binding each admission to the
producers, tasks, and install steps it deletes.

## Structure

```text
authored intent -> Semantic Operation -> Configured Operation
Composition Root + Member Cells -> configured Buck graph
Materialization -> action inputs + Editor Surface
action + Shared Cache -> result + Native Evidence
Development Loop -> affected closure + refreshed Editor Surface
result -> BuildProduct -> Nix Import
Admission -> Authority Transfer -> Deletion Ledger entry
```

## Flagged Ambiguities

- Qualify platform as target or execution platform.
- Use operation for semantic intent and action for a Buck execution node.
- Use import only for the independent Nix boundary, not publication or
  activation.
- "Materialization" here means the dependency-surface action;
  `context/dependency-materialization` uses the same word for the transitional
  pnpm/Nix contract that this system progressively supersedes. Buck's internal
  artifact materializer (`buck-out` writing) is a third meaning; qualify it as
  "output materialization" when it matters.
- Name the exact admitted operation and tuple instead of saying supported.
- Distinguish Buck result, telemetry export result, evidence completeness,
  import result, and consumer live state.
