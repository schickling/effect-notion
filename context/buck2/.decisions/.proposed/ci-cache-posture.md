# CI cache posture: isolate public and private trust domains

Status: proposed

## Context

Public repositories run pull-request CI on Namespace runners. A public pull
request can execute untrusted code and must not receive cache write authority or
access to private-repository artifacts. Private repositories stay on
self-hosted tailnet runners inside the single-operator BUCK-A05 trust boundary.
The current fleet cache is tailnet-only, read-write, and shared across
repositories; `instance_name` is attribution rather than full isolation.

Force-cold public CI does not meet the reuse and wall-clock budgets. The measured
failure is retained in
[the experiment](../../04-reuse/.experiments/2026-09-12-ci-cache-posture.md).

## Evidence and Argument

Buck2 independently controls remote-cache reads and uploads. A public pull
request can set `remote_cache_enabled = True` and `allow_cache_uploads = False`,
but the server must enforce the write denial. bazel-remote v2.6.2 can require
authentication for writes while allowing unauthenticated reads. It cannot fully
isolate tenants in one process: optional instance mangling applies to action
cache entries, while CAS and ByteStream ignore the instance name.

Tailscale solves transport, not trust. Giving untrusted code a tailnet tag does
not make that code trusted, and the current cache endpoint has no reader/writer
role split. Namespace's managed Bazel cache is a plausible REAPI alternative,
but Namespace does not document Buck2 support or a branch-based writer policy;
no interoperability result exists.

## Options

| Option                                                        | Tradeoff                                                                                                                  | Outcome                 |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------- |
| Put every Namespace job on the tailnet                        | Reuses the existing cache, but grants public PR code tailnet reachability and current read-write cache access             | Rejected                |
| Expose the existing shared cache publicly with authentication | Small service delta, but public readers could address private CAS blobs and PRs cannot safely receive a static credential | Rejected                |
| Use Namespace Cache Volumes for `buck-out`                    | Branch-protected writes and fast local storage, but no REAPI or reliable cross-machine action reuse                       | Rejected                |
| Use Namespace's managed Bazel cache                           | Short-lived credentials and low latency, but Buck2 compatibility and PR write denial are unverified paid features         | Deferred bakeoff        |
| Add a separate public-repository bazel-remote tier            | Known Buck2 protocol; unauthenticated reads plus authenticated writes; separate storage preserves confidentiality         | Recommended             |
| Keep public PRs force-cold                                    | Safe and available now, but retains the measured ENOSPC and latency failure                                               | Temporary fallback only |

## Decision

Use two cache trust domains:

1. Public repositories use a dedicated public-repository bazel-remote process,
   TLS, and a separate data directory. The server permits unauthenticated reads
   and requires authentication for writes. Public pull requests omit credentials
   and set `allow_cache_uploads = False`. Protected `main` jobs receive the write
   credential and set `allow_cache_uploads = True`.
2. Private repositories keep the tailnet-only cache. Private pull-request and
   main jobs read and write because their authors and runners remain inside
   BUCK-A05.
3. Each repository retains its own `instance_name` for attribution and optional
   action-cache mangling. No policy treats it as CAS isolation.
4. Every lane retains the explicit local-only escape hatch. The pinned Buck2 can
   fail during initial remote-client setup, so automatic universal fail-open is
   not assumed.
5. Namespace's managed Bazel cache can replace the public tier only after a
   branch-only spike proves Buck2 AC/CAS/TLS compatibility, unchanged-head hits,
   main-only writes, and outage behavior.

## Consequences

- Untrusted public pull requests benefit from results written by protected main
  without receiving a credential or publication authority.
- Public cache contents are intentionally readable by digest and must contain
  public-repository artifacts only.
- The service fleet gains one process, listener, bounded storage directory,
  credential, health check, and cache metric identity.
- Acceptance requires constitutional refinement of BUCK-R06 and REUSE-R01,
  followed by alignment of REUSE-A01, REUSE-R06, the root and reuse specs, the
  roadmap, and materialization DQ1 with the accepted two-tier topology.
- CI remains force-cold until the public tier exists and a Namespace lane proves
  the exact client contract.

## Dotfiles lead brief

Target: add a public-repository Buck2 cache tier; do not alter the private cache.

- Run a second bazel-remote process with its own bounded data directory.
- Expose gRPC through TLS 1.2 or newer on a stable public endpoint.
- Enable Basic or mTLS authentication and `allow_unauthenticated_reads`.
- Keep all private-repository cache data on the tailnet-only process.
- Retain per-repository instance names; treat action-cache mangling as optional
  attribution isolation, never CAS isolation.
- Create one write credential for protected public-repository main lanes.
- Declare that credential through the existing SecretSpec/1Password inventory;
  do not place its value or locator in effect-utils.
- Add health, capacity, eviction, read, write, and auth-failure metrics/alerts.
- Verify unauthenticated read succeeds, unauthenticated write fails, authenticated
  write succeeds, and neither endpoint can read the other's seeded CAS blob.
- Return the public endpoint, CA contract, credential environment name, and
  rollback command to the effect-utils owner for the dispatch-only CI proof.
