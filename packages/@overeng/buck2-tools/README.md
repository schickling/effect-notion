# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and the scoped editor view.

## Scoped editor publisher

`src/editor-view.ts` publishes and checks a scoped package editor dependency
view. It consumes the built Buck `:editor_inputs` and `:node_modules`
artifacts and creates an immutable byte-owned snapshot with a stable first hop.
Legacy self-contained views are copied with Nix
`cp --dereference --reflink=auto`. Normalized views pass every provider-owned
artifact as a repeatable `--backing-root`: each distinct artifact is copied
exactly once, and its links are relocated to relative paths inside the owned
snapshot. This finite representation preserves package-manager SCCs without
retaining aliases to backing artifacts. Links may target only the selected view
or a declared backing root; every other escape fails closed. Omitting the
option preserves the legacy tree-confined policy. GNU
`mv --exchange --no-copy` atomically adopts the stable first hop and retains
any exchanged root-install directory. Per-view retention records let multiple
package views share `.editor-view` without inspecting or collecting one
another's snapshots. Because each snapshot owns its bytes, `verify` validates
the published two-hop view after every backing Buck artifact is deleted.
The view identity defaults to the package directory name and is overridable
with `--view-name`.
Repository tasks `buck2:tui-core:publish-editor`,
`buck2:tui-core:check-editor`, and the exact-token
`buck2:tui-core:recover-editor-lock` are scoped and are not wired into global
checks.
