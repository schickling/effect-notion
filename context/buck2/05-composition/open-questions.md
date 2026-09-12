# Composition Open Questions

## Open 2026-09-12: should cross-repository reuse use cells or artifacts?

Composed cells exist for vision criterion 6 (a consumer builds producer
targets from the shared cache with source-granular invalidation). The cost is
the decision-0020 workspace shape and mr's mount pipeline (up to ~13–14k LOC
by attribution), paid today by effect-utils alone: no repository authors an
`effect_utils//` label and Phase 6 has not started. The only Buck2-native
alternative, git external cells, is rejected
([decision 0030](../.decisions/0030-external-cells-are-not-a-composition-mechanism.md)).
The artifact-composition spikes are recorded in
[2026-09-13-artifact-composition-spikes](./.experiments/2026-09-13-artifact-composition-spikes.md).
They establish the mechanism and its remaining gaps without choosing between
artifact-granular reuse and composed cells. Blocked on: Johannes' decision on
criterion 6 and the durable package-product publication contract.

## Open 2026-09-12: root-owned capability cell

The hub loads the per-host capability projection from inside its own cell
(`buck2/toolchains/BUCK:1`, `configured.bzl:5,59`:
`//.buck2/capabilities/…`), so mr must write the projection into every mount
and no fetched or read-only hub can carry it
([2026-09-12-hub-as-external-cell](./.experiments/2026-09-12-hub-as-external-cell.md)).
Moving it to a root-provided `capabilities//` cell (declared by the root
generator, referenced by cross-cell labels) is the right ownership boundary in
every option on the table and is a precondition for rules-only external-cell
distribution of the hub. Blocked on: deciding the cell's contract (visibility,
generation identity checks) and the mr change that declares it.

## Resolved 2026-08-30: consumers share the hub's toolchain pins

The platform hub is the sole authority for Bun, pnpm, tsgo, and subsequent
toolchain instances. Member manifests declare typed toolchain requirements but
cannot select an instance or repeat Nix package, executable, or pin identity.
Composition resolves each requirement to the hub and fails before publication
on unknown or duplicate kinds, a non-hub authority declaration, or an attempted
member-owned override. A different consumer pin now requires an explicit
architecture change backed by a demonstrated incompatibility; it is not an
implicit per-member escape hatch.
