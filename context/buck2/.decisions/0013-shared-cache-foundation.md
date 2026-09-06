# 0013 Shared Cache Foundation: bazel-remote Cache-Only on dev3

Status: accepted

## Context

The adoption's primary goal — reuse across worktrees and machines — had no
carrier: every gate ran `--local-only --no-remote-cache`, and Buck's local
action results do not survive a daemon restart (measured: ~42 s full re-run,
0% hits after `buck2 kill`). Buck2 speaks the Bazel Remote Execution API over
gRPC only; there is no HTTP or object-store cache path.

## Evidence and Argument

A three-track investigation (live experiment, ecosystem research, Nix
deployment assessment; retained in
[.experiments/2026-08-25-cache-backend-selection.md](../.experiments/2026-08-25-cache-backend-selection.md))
compared bazel-remote and NativeLink. Both passed the decisive protocol test
with the pinned Buck2: 100% cache hits after wiped local state and from a
second project copy. The tie broke on operations: bazel-remote substitutes
from cache.nixos.org and is one Apache-2.0 binary with a mandatory LRU cap,
Prometheus metrics, and zstd at rest; NativeLink required an 880-derivation
from-source build with no upstream binary cache, an empty `nixosModules` flake
output, an FSL license, an optional eviction cap, and config-schema churn.
Cache state is disposable, so a later backend swap costs three address lines
and one cold day — deferring remote execution costs nothing now.

## Options

| Option                               | Tradeoff                                                                      | Outcome  |
| ------------------------------------ | ----------------------------------------------------------------------------- | -------- |
| bazel-remote, cache-only             | Smallest service and maintenance surface; no RE path in this backend          | Accepted |
| NativeLink, cache-only now, RE later | One backend could grow RE workers; heavy deploy and churn for no present need | Rejected |
| Hosted cache (BuildBuddy)            | Zero ops; off-fleet data and external dependency                              | Rejected |

## Decision

One bazel-remote instance on dev3 (dotfiles#2009): storage on the bulk pool
with a hard `--max_size` cap, bound to the Tailscale interface only, open
read+write inside the tailnet (single-operator trust, BUCK-A05), Prometheus
scraped. Client contract: `[buck2_re_client]` engine/action-cache/CAS addresses
at one endpoint in a buckconfig file (CLI `-c` overrides do not reach the RE
client), per-repo `instance_name`, `tls = false` inside the tailnet,
`[buck2] digest_algorithms = SHA256` and `default_allow_cache_upload = true`,
executor `remote_cache_enabled = True` with `allow_cache_uploads = True`, and
batched transfers below Buck2's 4 MiB tonic limit (facebook/buck2#583; see
Amendment 1).
The action cache is deliberately shared across repositories: action keys are
content-addressed, so cross-repo hits are correct by construction and valuable
under megarepo-shared sources; `instance_name` is attribution, not isolation.
An unreachable cache is a hard build failure in the pinned Buck2, so the
consumer contract includes a one-line disable toggle and the service is
alerted on.

This decision partially supersedes
[0008](./0008-untrusted-oci-and-offline-nix-authority.md): the digest-pinned
untrusted-transport core stands; the durability machinery (dual registry
reads, restore-tested failure-domain archive, RPO policy) is parked as
premature for the fleet's scale and moves behind product-distribution scope in
the roadmap.

## Consequences

- Daemon-restart amnesia, cross-worktree reuse, and cross-machine reuse are all
  served by one service.
- Remote execution remains a separate future decision; NativeLink is the
  designated candidate then.
- Cache outage posture and reuse criteria live in
  [04-reuse](../04-reuse/requirements.md).

## Amendment 1

The original text required the server to advertise a gRPC batch size below
Buck2's 4 MiB tonic limit. bazel-remote hardcodes an unlimited
`MaxBatchTotalSizeBytes` in its Capabilities response and exposes no flag to
change it, so no bazel-remote deployment can satisfy that wording. The 4 MiB
ceiling is enforceable only on the client side; REUSE-R05 carries the
corrected clause, and the dotfiles build-cache trait records the same fact as
a trait tradeoff. (Found while authoring the fleet trait VRS for
dotfiles#2048, 2026-08-26.)

## Amendment 2

The VRS client template intentionally redacts the endpoint. The tracked
`devenv.nix` owns the public fleet-default operational endpoint, while generated
`.buckconfig.local` is untracked and overrideable. A service move updates the
fleet trait and that tracked default together.

## Amendment 3

This service and the Nix binary cache are evictable reuse planes. A capped,
LRU-governed action cache and a garbage-collected binary cache make builds
fast; neither is a durability claim, and losing either loses no product. Durable
product authority is tracked Git content in the product's own repository
([0031](./0031-git-product-authority-and-release-tripwires.md)). The parked
distribution-durability machinery stays parked: nothing in this cache plane
takes it over.
