# Semantic Graph Open Questions

## OQ1: When does the TypeScript binding realize field-qualified dependency handles?

- Blocks: implementation authority for
  [decision 0005](../.decisions/0005-operation-dependency-roots.md).
- Known gap: `catalog.compose` carries emitted dependency maps and workspace
  metadata, but does not expose the decision's immutable, field-qualified,
  branded handles through `GenieOutput.meta` for operations to consume.
- Resolution signal: the package composition emits those handles from canonical
  dependency declarations; package-local `BUCK.genie.ts` operations consume only
  the handles; normalization proves field identity, rename locality, stable value
  identity, sorting, deduplication, and rejection of unsupported peer roots.
