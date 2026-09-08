# Weaver / upstream-semconv version-bump runbook

Operational companion to [spec.md](./spec.md) (SC-DQ4, SC-A01). Timeless procedure for
bumping the two pinned inputs of the semantic-conventions generator and the compatibility
constraints between them. Enforced by the `weaver:version-smoke` CI task (below).

## The three coupled pins

The emitted registry + bindings depend on three version inputs that MUST move together:

| Pin                                | Source of truth                                                         | Value today |
| ---------------------------------- | ----------------------------------------------------------------------- | ----------- |
| Weaver binary                      | `nix/weaver-flake/flake.nix` → `version`                                | `0.26.1`    |
| Upstream OTel semconv (dependency) | `nix/weaver-flake/flake.nix` → `semconvVersion`                         | `1.44.0`    |
| Weaver pin (fingerprint input)     | `genie/weaver-registry/registry.ts` → `PINNED_WEAVER_VERSION`           | `0.26.1`    |
| Upstream pin (fingerprint input)   | `genie/weaver-registry/registry.ts` → `PINNED_UPSTREAM_SEMCONV_VERSION` | `v1.44.0`   |

Two SSOTs, one contract: the **flake** actually builds/materializes Weaver + the semconv
FOD (used by `weaver:check`); the **registry.ts** `PINNED_*` constants feed the GEN-R07
provenance fingerprint (so a bump re-hashes generated outputs and forces regen). They are
otherwise independent files, so a bump that touches one and forgets the other is the primary
drift risk — that is exactly what `weaver:version-smoke` guards.

> **`v` asymmetry (easy to get wrong):** the flake stores the bare number (`1.44.0`); the
> registry pin stores the git-tag form with a leading `v` (`v1.44.0`). The smoke asserts
> `PINNED_UPSTREAM_SEMCONV_VERSION == "v" + semconvVersion`. The Weaver pin has no `v`
> (`0.26.1` on both sides).

## Compatibility matrix

| Weaver | Upstream semconv | Status               | Notes                                                                                           |
| ------ | ---------------- | -------------------- | ----------------------------------------------------------------------------------------------- |
| 0.26.1 | v1.44.0          | **Current pin**      | Not yet gate-verified: `weaver:*` + `genie:run` blocked by dotfiles#2602 (see PR notes).        |
| 0.24.2 | v1.37.0          | **Known-good (RoR)** | Last gate-verified pair. Clean under `--future`. Every enum member carries `stability`.         |
| 0.23.0 | v1.37.0          | Works (historical)   | `nixpkgs#weaver`; used during derisking. 0.23 does **not** require per-enum-member `stability`. |
| 0.25.x | any              | Constraint           | 0.25 dropped legacy v1 `name` + `registry_path` dependencies (restored in 0.26.0, #1696).       |
| 0.24.2 | ≤ v1.36.x        | **Fails**            | ≤v1.36 use their own unstructured `deprecated:` string form → `--future` rejects them.          |
| ≥0.24  | any              | Constraint           | Each enum member requires a `stability` field (0.23 did not) — the emitter already emits this.  |

### Constraints (why the cells above hold)

- **Weaver v1 `groups:` is the stable contract.** The emitter targets the `groups:` YAML
  vocabulary; treat it as the load-bearing surface across Weaver bumps. Structured shapes the
  emitter relies on: `deprecated: { reason, renamed_to | note }` (string form removed),
  `requirement_level: { conditionally_required: <text> }`, enum members as
  `{ id, value, brief, stability }`, `type: template[...]`. See spec.md "Weaver-vocabulary
  fidelity" and [.decisions/0001](./.decisions/0001-ts-first-weaver-additive.md).
- **`--future` cleanliness needs semconv ≥ v1.37.0.** The gate runs `weaver registry check
--future`; older upstream models trip on their own legacy `deprecated:` strings.
- **`stability` on every enum member is mandatory in ≥0.24.2.** A member missing it fails the
  check under 0.24.2 (0.23 tolerated it).
- **String attributes need `examples`** under `--future` (emitter enforces at author time).

Before choosing a target Weaver tag, skim its release notes for `groups:`-schema changes; if
the stable `groups:` contract shifts, expect emitter work beyond a version bump.

## Procedure

### A. Bump the pinned Weaver version

Steps 1–5 are documented inline in `nix/weaver-flake/flake.nix` ("Bumping the version") — do
not duplicate them here; the canonical sequence is:

1. Pick the target tag (`gh release list --repo open-telemetry/weaver`).
2. Set `version` in `flake.nix`.
3. Refresh `src.hash` via `nix run nixpkgs#nurl -- https://github.com/open-telemetry/weaver v<version>`.
4. Refresh `pnpmDeps.hash` (fakeHash → `nix build .#weaver` → copy the `got:` hash, or the
   evergreen FOD workflow).
5. Cargo deps ride `cargoLock.lockFile` (no `cargoHash`) — unless upstream `Cargo.lock` grows
   git deps (`grep 'source = "git' Cargo.lock`), then switch to `cargoHash`/`outputHashes`.
6. **Update `PINNED_WEAVER_VERSION` in `genie/weaver-registry/registry.ts` to the same
   number** (no `v`). This is the step the flake comment does not mention and the smoke
   enforces.

### B. Bump the pinned upstream semconv version

1. Pick the target semconv tag (≥ v1.37.0 for `--future` cleanliness).
2. Set `semconvVersion` in `flake.nix` (bare number, no `v`).
3. Refresh `semconvSrc.hash` via
   `nix run nixpkgs#nurl -- https://github.com/open-telemetry/semantic-conventions v<ver>`.
4. **Update `PINNED_UPSTREAM_SEMCONV_VERSION` in `registry.ts` to `v<ver>`** (WITH the leading
   `v`). The `registry_path` git-URL in `registry.ts` interpolates this constant, so the
   emitted manifest dependency tag moves with it automatically.

### C. Verify loop (after any bump)

Run in order; each must pass before committing:

1. `devenv tasks run weaver:version-smoke --no-tui` — pins consistent + resolvable (fast; the
   first gate to run, catches a forgotten `PINNED_*` edit or a stale hash immediately).
2. `devenv tasks run genie:run` — regenerate the registry + bindings (the fingerprint changes
   because the pinned versions are fingerprint inputs, so outputs churn by design).
3. `devenv tasks run weaver:check --no-tui` — the authoritative gate validates the freshly
   emitted registry against the new pinned Weaver + semconv model.
4. `devenv tasks run genie:check` — asserts generated files are up to date (locally + in CI).

## `weaver:version-smoke` (the drift gate)

Task file: `nix/devenv-modules/tasks/shared/weaver-version-smoke.nix`. What it asserts:

- **Lane A (string consistency, no nix, hermetic, instant) — BLOCKS on mismatch.** Parses
  `version` + `semconvVersion` from `flake.nix` and `PINNED_WEAVER_VERSION` +
  `PINNED_UPSTREAM_SEMCONV_VERSION` from `registry.ts`, and asserts Weaver pins are identical
  and the semconv registry pin equals `"v" + semconvVersion`.
- **Lane B (resolvability) — BLOCKS on build failure or version mismatch.** Builds
  `nix/weaver-flake#semconv-model` and `#weaver` (cached), then asserts the built binary's
  `weaver --version` equals the pin. `nix` genuinely absent from PATH degrades to a warning
  (exit 0); everything else a bump could break blocks.

**Intentional divergence from `weaver:check` / GEN-R09 block-vs-degrade.** `weaver:check`
gates registry _content_, so it degrades on a weaver-flake build failure (a broken toolchain
must not wedge unrelated work). This smoke gates version _integrity_, so a build failure IS
the drift signal: e.g. a bumped `version` with a stale `src.hash` surfaces only as an FOD
hash-mismatch — which `weaver:check` would silently degrade past, so the smoke must block on
it. Only a truly absent `nix` degrades.

Hermeticity: Lane A is pure grep (no network, no nix). Lane B assumes a warm nix cache; on a
cold cache the FOD fetches run inside the nix sandbox (network-allowed for fixed-output
derivations), so a normal CI runner resolves them.

### Wiring (for the orchestrator)

The task is standalone and NOT yet wired. To activate it, in `devenv.nix`:

1. Add to the `taskModules` set (near the other `shared/` imports):
   `weaver-version-smoke = import ./nix/devenv-modules/tasks/shared/weaver-version-smoke.nix;`
2. Instantiate it: `(taskModules.weaver-version-smoke { })`
3. Gate `check:all` on it, mirroring the existing `weaver:check` wiring:
   `{ tasks."check:all".after = [ "weaver:version-smoke" ]; }`
   (List options merge across modules, so this appends without redefining `check:all`.)

Run it in CI on the same job as `check:all`. It is fast when the cache is warm, so it is safe
to keep in the default gate lane.
