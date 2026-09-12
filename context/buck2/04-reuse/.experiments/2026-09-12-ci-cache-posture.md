# CI cache posture across public and private repositories

Date: 2026-09-12
Host class: Namespace Linux runners and self-hosted tailnet runners

## Question

How can public-repository CI on Namespace runners and private-repository CI on
self-hosted tailnet runners reuse Buck2 actions without letting untrusted public
pull-request code write trusted action results or read private-repository cache
content?

## Method

- Inspected the current cache projection, executor policy, CI generator, and
  [force-cold failure record](https://github.com/overengineeringstudio/effect-utils/issues/1212).
- Inspected the failed main-branch Namespace proof in
  [run 34645917504](https://github.com/overengineeringstudio/effect-utils/actions/runs/34645917504/job/103416553187).
- Compared primary documentation for
  [Namespace Cache Volumes](https://namespace.so/docs/solutions/github-actions/caching),
  [Namespace's Bazel cache](https://namespace.so/docs/bazel/cache),
  [Namespace's Tailscale integration](https://namespace.so/docs/integrations/tailscale),
  [Buck2 remote execution configuration](https://buck2.build/docs/users/remote_execution/),
  [Buck2 executor cache controls](https://buck2.build/docs/api/build/CommandExecutorConfig/),
  [bazel-remote v2.6.2](https://github.com/buchgr/bazel-remote/blob/v2.6.2/README.md),
  and the [Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action).
- Required a real Namespace lane before claiming reachability or cache hits.
  A candidate blocked on an absent credential, integration, service listener,
  or paid feature was recorded as infeasible rather than simulated.

## Result

### Threat model

A public pull request can execute attacker-controlled actions. A writer can
submit an arbitrary action result under a known action digest; SHA256 prevents
accidental collisions, not an authorized client from deliberately writing a
known key. Client-side `allow_cache_uploads = False` is defense in depth, not an
authorization boundary. The server must reject writes from public pull requests.

Read access is also a boundary. bazel-remote ignores `instance_name` for CAS and
ByteStream data. Its optional instance mangling isolates only action-cache keys.
A public reader must therefore never share a bazel-remote data directory with
private repositories, even if action-cache instance names differ.

BUCK-A05 applies only after runner admission. Joining a Namespace runner to the
tailnet would grant attacker-controlled pull-request code every capability of
its Tailscale tag. A public pull-request runner cannot become trusted merely by
joining the network; the tag would need read-only access to a read-only service
that contains public data only.

### Candidate evidence

| Candidate                               | Real-lane result                                                                                                                                                                                                                                                                                                                                                                                                             | Secret and trust surface                                                                                                                                                                                                                      | Disposition                                                                                                                                 |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Ephemeral Tailscale                     | Infeasible in this branch. No named Namespace `tailscale.spec` was declared, and the repository has neither the Tailscale federated client inputs nor an OAuth/auth-key secret needed by `tailscale/github-action`. Creating the trust credential or integration was outside the experiment authority.                                                                                                                       | Namespace's native integration stores a client ID and tags, then uses a short-lived OIDC token; the generic action alternatively needs federated client ID + audience or an OAuth/auth-key secret. The resulting tag controls tailnet access. | Do not attach public PR jobs to the current read-write cache. Retain as a trusted-main transport option after a narrowly scoped tag exists. |
| Current authenticated cache coordinates | The existing Namespace proof reached its generated composition but failed before invoking Buck because `DEVENV_BIN` was unset ([job 103416553187](https://github.com/overengineeringstudio/effect-utils/actions/runs/34645917504/job/103416553187), 6 min 4 s). It did not establish cache reachability or a hit. The tracked endpoint is tailnet-only and has `tls = false`, so it is not an authenticated public endpoint. | A repository secret named `BUCK2_REMOTE_CACHE_BASIC_AUTH` exists, but Basic authentication without TLS must not cross the public internet.                                                                                                    | Infeasible without a separate TLS public listener and public-only cache storage.                                                            |
| Namespace managed Bazel cache           | Not exercised. Namespace documents a public REAPI-compatible Bazel cache with short-lived credentials, but Buck2 is not a documented integration, the feature is a paid add-on, and no enabled Buck2-compatible profile was available to this branch.                                                                                                                                                                        | Short-lived credentials generated by Namespace; exact Buck2 TLS/header mapping and PR write restriction remain unverified.                                                                                                                    | Promising later bakeoff candidate, not evidence for the present decision.                                                                   |
| Namespace Cache Volume                  | Not an REAPI endpoint. Namespace mounts a forked filesystem cache, may return a stale generation or miss, and can protect persisted updates by branch.                                                                                                                                                                                                                                                                       | No job secret; every job sharing the cache identity can read the mounted bytes.                                                                                                                                                               | Useful for downloads or local state only. It cannot satisfy cross-machine Buck2 action-cache reuse.                                         |
| Dedicated public bazel-remote           | Infeasible to exercise because no public listener or public-only data directory exists and this experiment cannot change the service. bazel-remote directly supports TLS, Basic or mTLS authentication, and `allow_unauthenticated_reads`; unauthenticated gRPC reads are enumerated while writes still require authentication.                                                                                              | Public PRs receive no credential. Trusted main receives one write credential. Separate storage prevents public CAS reads from crossing into private artifacts.                                                                                | Recommended service shape.                                                                                                                  |

The force-cold baseline remains the measured failure: 279 local actions, zero
cache hits, about 35 seconds of staging for a 927 MB package tree, roughly 1 GB
retained plus one minute added per package per lane, and eventual 30–35 minute
stall or ENOSPC. The earlier tailnet canary remains the positive control: a
fresh same-platform context had zero local actions and completed in 1.8 seconds.
No Namespace candidate produced an unchanged-head hit in this experiment, so no
new speedup claim is made.

The pinned Buck2 does not have a universal fail-open contract. An established
client can degrade an action-cache RPC error to a miss, and normal upload errors
are non-fatal, but initial client/capabilities setup can fail the build. No
verified fallback exists for a CAS download failure after an action-cache hit.
The existing one-line `BUCK2_NO_REMOTE_CACHE=1` escape hatch therefore remains
required.

### Trust and write-back matrix

| Lane         | Read                                                 | Write              | Reason                                                                                                                                |
| ------------ | ---------------------------------------------------- | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Public PR    | Yes, from the dedicated public-repository cache only | No                 | Untrusted code receives no write credential; the server rejects writes. Public-only storage prevents disclosure of private CAS blobs. |
| Public main  | Yes, from the dedicated public-repository cache      | Yes, authenticated | Protected main is the sole cache warmer for public PRs. TLS protects the write credential in transit.                                 |
| Private PR   | Yes, from the tailnet cache                          | Yes                | Repository authors and self-hosted runners are inside the single-operator BUCK-A05 trust boundary.                                    |
| Private main | Yes, from the tailnet cache                          | Yes                | Same trusted writer domain; main replenishes evicted results but needs no separate policy.                                            |

Per-repository `instance_name` remains useful for attribution. It is not an
isolation control. The public and private tiers require separate bazel-remote
processes and data directories because one process cannot namespace CAS.

## Conclusion

Keep public CI cold until a dedicated public-repository cache tier exists.
Configure that tier so public pull requests can read without credentials and
cannot write, while protected main can write through TLS with one credential.
Keep private CI on the separate tailnet cache. The Namespace and Tailscale
candidates remain unproven; neither candidate can replace the trust boundary
without a real-lane hit and outage test.

## VRS Impact

This experiment supplies the resolution signal for OQ2 and supports the
proposed cache-posture decision. Acceptance requires a later constitutional
refinement: BUCK-R06 and REUSE-R01 currently require every admitted action to
write the shared cache, while public pull requests must be read-only. Acceptance
must also align REUSE-A01, REUSE-R06, the root and reuse specs, the roadmap, and
materialization DQ1 with the chosen two-tier topology. No requirement was
changed by this experiment.
