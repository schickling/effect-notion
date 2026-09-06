# 0031 Git Product Authority With Numeric Release Tripwires

Status: accepted

## Context

Strict products need one durable authority a consumer can read offline. Two
boundaries are viable in the same repository: tracked Git content, or immutable
per-product Releases attached to that repository. Which one is correct is a
question of measured scale, not of taste, and the wrong answer in either
direction is expensive: a premature publication boundary buys a credentialed
writer, a retention policy, and a revocation policy for nothing, while an
overgrown Git payload taxes every clone and refresh forever.

The reuse planes are not candidates. A Buck remote CAS is capped and LRU-evicted
by construction, and a Nix binary cache is a garbage-collected mirror; both make
a build fast and neither makes a product durable.

## Evidence and Argument

Byte units are exact: MB is 10^6 bytes and MiB is 2^20 bytes. Measurement
definitions and the acceptance baselines are recorded in
[2026-09-06-product-boundary-benchmarks.md](../.experiments/2026-09-06-product-boundary-benchmarks.md);
this decision states the thresholds and the shape of each measurement, not its
procedure.

At current measured scale Git wins on absolute numbers, not on a ratio. Two
distinct quantities are measured and neither substitutes for the other: the
current-head product payload is 41,408,475 B, while the cumulative distinct
product-module bytes reachable from the default branch across history are
45,060,041 B. A checkout materializes the first; a full clone carries the
second. Both sit far below their thresholds, and the largest single artifact,
11,532,809 B, is well inside what Git handles without special storage.

The flake source closure, 69,176,504 B, is a different kind of fact: it is the
cost ceiling a consumer realizes to obtain products from source, not a
discriminator of payload health. It is a tripwire because an unbounded
consumer-side realization cost eventually makes source consumption the wrong
boundary, regardless of how healthy the committed payload is.

Every consumer reads products through the repository's own flake source, so the
bytes are already on disk after the checkout that the consumer performs anyway.

Growth is monotone, so the exception must carry its own expiry. A numeric
tripwire is checkable from the repository alone and cannot be argued away, while
a date or a judgment call defers the same decision under worse information.

Marginal clone cost and pack growth on refresh are the wrong triggers: both are
consequences of committing anything at all, they move with unrelated source
churn, and neither distinguishes a healthy product payload from an unhealthy
one. The discriminators are the absolute payload, artifact, and consumer-shape
facts, bounded by the consumer-realized closure ceiling.

A forward-only cutover is the only affordable transition. Rewriting history to
move products out of old commits invalidates every existing pin and every
recorded digest; back-publishing old generations manufactures artifacts nobody
requested and needs the retention policy the exception exists to avoid.

## Options

| Dimension          | Accepted option                                          | Rejected alternative and reason                                                        |
| ------------------ | -------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Durable authority  | Tracked Git content in the product's own repository      | Release assets now — publication credential and policy cost for no measured benefit    |
| Reuse planes       | Buck CAS and Cachix are evictable reuse only             | Treating a cache or binary cache as durability — both are eviction-governed            |
| Exception validity | Numeric tripwires checkable from the repository          | A review date or judgment call — defers the same decision with worse data              |
| Growth signals     | Absolute payload, artifact, closure, and consumer shape  | Clone marginal cost or refresh pack growth — track unrelated source churn              |
| Landing zone       | Same-repository, per-product immutable Releases, dormant | A separate distribution repository or registry authority — new trust root and topology |
| Cutover shape      | Forward-only from the cutover commit                     | History rewrite or back-publication — breaks existing pins, invents artifacts          |

## Decision

Durable product authority is tracked Git content in the product's own
repository. A product generation is committed bytes plus its independently
tracked descriptor and module digests, and a consumer imports it from
repository source with no network access and no Buck invocation. The Buck
remote CAS and Cachix are evictable reuse planes; neither carries a durability
claim, and losing either loses no product.

This exception holds only while the repository stays inside all five measured
tripwires (MB = 10^6 bytes, MiB = 2^20 bytes; baselines are the acceptance
measurements). Any one of them firing retires Git-carried product authority:

1. current-head product payload above 100 MB (baseline 41,408,475 B);
2. any single artifact above 50 MiB (baseline 11,532,809 B);
3. flake source closure — the consumer-realized cost ceiling — above 100 MB
   (baseline 69,176,504 B);
4. cumulative distinct product-module bytes reachable from the default branch
   above 250 MB (baseline 45,060,041 B);
5. any consumer that does not consume products from flake source (baseline
   none).

Tripwires 1 and 4 are distinct quantities: the first is what one checkout
materializes, the fourth is what history carries. Neither is a substitute for
the other.

Marginal clone cost and pack growth on refresh are explicitly not tripwires.

The forward landing zone is preselected and dormant: same-repository,
per-product immutable Releases. It becomes authority only when a tripwire
fires, and the move is forward-only. From the cutover commit forward, new
product generations land in Releases; commits before it keep path-loader
semantics, remain importable exactly as authored, and are never back-published.
History is not rewritten and no retroactive Release is created.

The secure K-of-K publication relay is dormant and holds no live publication
capability while Git carries authority. Its dormancy is a precondition of the
future cutover, verified once before the boundary moves, not a recurring check
while the boundary stands.

Retention, revocation, and the wider distribution-durability machinery stay out
of scope; they are parked with
[0013](./0013-shared-cache-foundation.md)'s partial supersession of
[0008](./0008-untrusted-oci-and-offline-nix-authority.md).

## Consequences

- A consumer needs a checkout and nothing else; there is no publication step,
  no release credential, and no retention policy to operate.
- The exception carries its own expiry: the tripwires are repository facts, so
  the boundary move is triggered by measurement rather than by argument.
- Old pins keep working across the future cutover, because path-loader
  semantics stay attached to the commits that were authored with them.
- Cache and binary-cache loss is an operations event, never a product loss.
- Relay dormancy is a cutover precondition, not a standing obligation: it is
  verified once, immediately before the boundary moves, and imposes no
  recurring check while Git carries authority.
