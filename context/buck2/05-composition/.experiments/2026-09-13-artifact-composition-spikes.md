# Artifact Composition Falsification Spikes

Date: 2026-09-12–13 — Host: dev3 — Linux x86_64 — Buck2 pin 2026-09-01. The effect-utils source branch was composed into an isolated megarepo root. Buck builds used `--local-only --no-remote-cache` so remote credentials and cache hits could not affect the result.

## Question

Can artifact-granular reuse replace source-composed cells without losing lockfile closure, host-owned capabilities, deterministic package products, or a usable TypeScript consumer? These spikes test mechanics only. They do not choose between artifacts and composed cells.

## Method

1. Extend the pnpm-lock Buck translator with HTTPS tarball resolutions. Build a fixture from the public `is-number` tarball, then change one hash nibble and repeat the build.
2. Move the generated host capability projection from the effect-utils member to a root-owned `capabilities//` cell. Change all three toolchain references to cross-cell labels. Compose a clean root and load/build the real toolchain graph.
3. Add an `npm_package_product` around `@overeng/utils:dist`. Build its tarball and descriptor twice, inspect the archive, and send the descriptor through the Buck product publisher in dry-run mode.
4. In the requested dotfiles worktree, replace one Jellyfin source link with the tarball URL, remove its TypeScript source-path shim, and attempt a lock-only install before typechecking.

## Result

### URL tarball lock closure

- The unchanged fixture built `is_number` from `https://registry.npmjs.org/is-number/-/is-number-7.0.0.tgz`.
- A second target with a one-nibble SHA-512 drift failed before extraction. Buck reported expected `6b75…`, actual `7b75…`, and 3,730 downloaded bytes.
- The translator rejects non-HTTPS tarball URLs. The lockfile integrity remains the closure authority.

### Root-owned capability cell

- The root reserves and declares `capabilities = .buck2/capabilities`.
- The projection is installed once at the root and guarded against a conflicting root entry or member-owned projection.
- The three former member-relative references now load `@capabilities//:defs.bzl` and resolve tools below `capabilities//generations/...`.
- The real `effect_utils//buck2/toolchains:` target graph loaded after composition. The installed `mr` binary predates this branch, so the isolated verification root was patched to the generated shape after `mr apply`; unit and integration tests cover the generator itself. This is a bootstrap limitation, not evidence that the old binary can produce the new layout.

### Package product and publisher

- `effect_utils//packages/@overeng/utils:dist-package` produced a deterministic `overeng-utils.tgz` and an `effect-utils/npm-package-product/v1` descriptor.
- The fresh local build took 2 minutes 26.5 seconds. The archive is 375,775 bytes with SHA-256 `5225cbd0303b73163e6315223c91a02282d5e1471e062f2c621be54e1f874505` and SRI SHA-512 `sha512-gUaoJXIYsbXPvrusqxXy3RUI+yq4JkyEXS+xGiL9YKiBe4tsa+PYVZvXf1COiHIcC1/Ff0k2V89DzoMVlszGuQ==`.
- The package manifest points its public export paths at emitted `dist/src/**` files. The packer refuses missing declared files and symlinks.
- A publisher dry-run accepts the package product as `overeng-utils` and plans `effect_utils//packages/@overeng/utils:dist-package` plus its descriptor subtarget. Durable publication was not proved: GitBucket upload lacked an available SSH agent key, and the temporary dev3 content-addressed URL is evictable.

### Dotfiles consumer

The artifact consumer was falsified before typechecking:

- A global URL override fails with `ERR_PNPM_EXOTIC_SUBDEP` because dotfiles enables `blockExoticSubdeps` and `@overeng/utils` is also a transitive dependency.
- A one-consumer URL plus removal of the global source override fails with `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`: the other consumers still declare `@overeng/utils@workspace:^` and require the root source override.
- The second candidate would have changed 16 lines and deleted 21 lines across the Jellyfin package, root lock policy, and generated/source TypeScript configs. The deletion includes the direct source link, the source-path shim, and closure entries that the workspace dependency had pulled into the generated manifest.
- The branch was restored to clean state. No failing dotfiles commit or PR was retained.

The current root override is all-or-nothing. A mixed source/artifact workspace needs a package-manager-level identity or override contract before one consumer can migrate independently. The package artifact also retains workspace-protocol dependencies on `@overeng/effect-distributed-lock` and `@overeng/otel-contract`, so a durable registry-like publication path must define how those runtime dependencies are published or rewritten.

## Cost ledger

| Slice | Added | Deleted | Measurement |
| --- | ---: | ---: | --- |
| URL closure fixture and translator/tests | 122 | 4 | `git diff --numstat` against `origin/main` |
| Root capability-cell generator/runtime/tests and three labels | 36 | 14 | same |
| Package target, packer, TypeScript staging fix, and tests | 430 | 2 | same |
| Dotfiles one-consumer candidate, not retained | 16 | 21 | measured before restore |

The branch was created at 23:05:59 Europe/Berlin. The first complete package artifact proof followed at about 01:01, approximately 1 hour 55 minutes from a fresh branch. The artifact's uncached Buck action took 2 minutes 26.5 seconds. The failed consumer installs each refused the model in under 10 seconds.

## Conclusion

The spikes prove URL lock closure, early digest refusal, a root-owned capability cell, and deterministic package-product construction. They do not prove a deployable artifact-composition replacement. The decisive negative result is the consumer boundary: dotfiles cannot mix one URL artifact with its remaining source/workspace consumers under its current pnpm policy and override model. Durable publication and closure publication are also unresolved.

No composition decision follows from these mechanics. Keep the choice open until a package publication/identity contract permits a real consumer to install and typecheck without source aliases.

## VRS Impact

This experiment supplies evidence for the open 05-composition question. It removes the proposed artifact-composition decision from the decision path and leaves vision criterion 6 unchanged. The existing source-composed-cell requirements and decisions remain authoritative until Johannes chooses a different criterion or a later experiment closes the publication and mixed-consumer gaps.
