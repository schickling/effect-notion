# `@overeng/buck2-tools`

Repository-owned TypeScript helpers for Buck dependency materialization,
TypeScript execution, and workspace editor views.

## Editor publisher

`src/editor-view.ts` atomically publishes and checks one dependency view.
`scripts/editor-view-authority.ts` derives the root source-generator consumer and
every package consumer from the canonical workspace registry, proves that Buck
owns each tracked manifest, builds every `:editor_view_inputs` manifest, and
invokes the publisher in deterministic order. Published snapshots byte-own the
finite provider-declared closure; no link points back into disposable
`buck-out`.

`buck2:editor:bootstrap` publishes only the dependency views named by the
committed generated root manifest so `genie:check` can run before trusting the
generated graph. After generation and composition, repository tasks
`buck2:editor:authority`, `buck2:editor:publish`, and `buck2:editor:check`
operate on the complete current registry. The exact-token
`buck2:editor:recover-lock` task recovers only the named consumer's shared
publication lock. These tasks require a real composed megarepo workspace and
are not global check dependencies.
