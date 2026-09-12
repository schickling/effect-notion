# Buck2 Repository Build Open Questions

Subsystem questions live in their subsystem (`03-materialization`,
`05-composition`). These are cross-cutting.

## OQ1: Does the local check entry point stay a devenv verb over a Buck aggregate, or does Buck become the verb?

- Blocks: every consumer's local-check shape and the residual-gate list; the
  dissolution condition of `nix/devenv-modules/tasks/shared/check.nix` and the
  per-repo `check:*` fan-in.
- Two candidate shapes: (A) `devenv tasks run check:quick` runs one Buck
  aggregate target plus enumerated residual gates (dotfiles decisions 0020 and
  0027); (B) `buck2 test //...` is the gate and the devenv `check:*` tasks are
  deleted, with residual non-Buck gates rehosted.
- Resolution signal: a bakeoff experiment on the same admitted surface
  recording, for both shapes, warm no-op, fresh context with warm cache, and
  one-file-edit wall-clock (in-shell and pre-commit); build-machinery lines
  added versus deleted; a capability matrix (residual gates, task graph
  features, agent and skill ergonomics); and observability — which shape gives
  the check loop first-class OTel coverage (devenv trace versus Buck event log
  export). Johannes accepts deleting devenv tasks if Buck proves superior
  (q5, 2026-09-12).
- Blocker: the experiment has not been run.

## OQ2: How do public-repo CI runners share the cache with the private fleet?

- Blocks: BUCK-R06/R07 measurability in PR CI; consumer digest comparison
  (Phase 6); DQ1 in `03-materialization`.
- Constraint (q6, 2026-09-12): public repositories (effect-utils, livestore)
  run CI on Namespace runners to take load off dev3; private repositories stay
  on self-hosted tailnet runners. The shared generator currently pins
  `BUCK2_NO_REMOTE_CACHE=1` on every PR lane in every repo.
- Candidates to evaluate: ephemeral tailscale on a Namespace runner with a
  read-only action cache; a separate public cache endpoint with authenticated
  read and no PR write-back; a Namespace-native cache volume; distinct cache
  namespaces per trust tier with `main`-only write-back.
- Resolution signal: a spike per candidate recording reachability, hit rate on
  an unchanged head, wall-clock, secret surface, and the trust boundary
  (BUCK-A05 says trust follows the tailnet; a public runner is outside it).
- Signal status (2026-09-12): met by
  [the cache-posture experiment](./04-reuse/.experiments/2026-09-12-ci-cache-posture.md).
- Proposed resolution: isolate public and private cache storage; public pull
  requests read but never write, protected public `main` reads and writes, both
  private lanes read and write. See
  [the proposed decision](./.decisions/.proposed/ci-cache-posture.md).
- Acceptance blocker: the proposal needs a refinement of BUCK-R06 and REUSE-R01
  plus a deployed public-only cache tier; until then public CI stays force-cold.

## OQ3: What must an external livestore contributor install?

- Blocks: livestore admission (q7, 2026-09-12: livestore is gated on this
  answer).
- The composition shape says an external consumer builds from the same
  synthesized single-member root and inhabits its own cache namespace; it does
  not say whether a contributor needs Buck, Nix, both, or neither for the
  common contribution loop.
- Resolution signal: a written contributor loop for livestore under each
  answer, with the tool set and cold-start time measured on a machine outside
  the fleet.
- Blocker: not started; livestore-lead owns it once the ledger exists.
