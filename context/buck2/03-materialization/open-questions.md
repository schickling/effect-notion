# Materialization Open Questions

## DQ1: How should CI obtain fetch artifacts without a warm buck-out?

- Blocks: the final authority flip and its cache-only CI lane.
- Resolution signal: an ephemeral-tailnet namespace runner restores the complete
  candidate graph from the cache, uploads a deliberate miss, and exercises the
  documented outage path without weakening correctness.
- Blocker: the ephemeral-tailnet namespace-runner connectivity/fallback probe
  has not run. Local cache round trips (163/163 and 416/416 hits) prove action
  portability and cache transport, not CI runner reachability.
- Fallback: if the runner probe fails, use a GH-artifact fetch/extract-subtree
  cache keyed by the integrity-sidecar digest with a single fail-closed
  publisher.

## DQ3: Can store and SCC actions use true remote execution?

- Blocks: enabling `remote_enabled` for normalized-store actions.
- Resolution signal: a cache-cold run on a real remote executor proves exact
  tool-closure availability, platform selection, all SCC namespace/link
  validity, sandbox containment, path independence, and byte-identical outputs.
- Blocker: no true remote-execution backend is available. Cache-only restore
  executes locally and is not remote-execution evidence.

## DQ4: What numeric cold-capacity envelope gates the final flip?

- Blocks: accepting the current final authority flip.
- Resolution signal: the full candidate namespace E2E records cold wall time,
  peak `buck-out`/output/scratch disk, staging/action p95, and marginal
  time/disk/action-count slope, and an explicit numeric envelope is accepted
  before the flip.
- Blocker: the full candidate namespace E2E has not run. Raising a timeout or
  runner disk without changing and measuring the marginal curve does not
  satisfy this question.
