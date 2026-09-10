# Contributing

## Development setup

The package is part of the `effect-utils` workspace. From the repo
root:

```sh
devenv shell         # drops into the pinned Node + pnpm + tooling
pnpm install         # installs the full workspace
```

The devenv provides Node 20, pnpm 12, TypeScript, oxlint, oxfmt, and
the other tools the workspace expects. If you don't use devenv, match
those versions manually — lockfile and scripts assume them.

All common tasks run under `packages/@overeng/notion-react/`:

| Task                          | Command                                                    |
| ----------------------------- | ---------------------------------------------------------- |
| Unit tests (watch)            | `pnpm vitest`                                              |
| Unit tests (one-off)          | `CI=1 pnpm vitest run`                                     |
| Mock-client integration tests | `pnpm --filter @overeng/notion-react test:integration`     |
| Live E2E (real Notion)        | `pnpm --filter @overeng/notion-react test:integration:e2e` |
| Storybook dev server          | `pnpm --filter @overeng/notion-react storybook`            |
| Storybook static build        | `pnpm --filter @overeng/notion-react storybook:build`      |
| Type-check                    | `tsc --build --watch tsconfig.check.json` (from repo root) |
| Lint                          | `oxlint`                                                   |
| Format check / fix            | `oxfmt --check` / `oxfmt`                                  |

Live E2E requires `NOTION_API_TOKEN` and `NOTION_TEST_PARENT_PAGE_ID` —
see [Testing](./testing.md#pointing-at-a-different-notion-workspace).

## Edit / test loop

Run `tsc --build --watch tsconfig.check.json` in one pane and
`pnpm vitest` in another. Use Storybook when changing web-renderer
visuals. For renderer changes, the mock-client integration tests
(`pnpm --filter @overeng/notion-react test:integration`) are the
cheapest way to verify op sequences without paying for Notion API
latency.

The [Testing](./testing.md) decision table lists which layer to run
for a given change surface. Escalate layers only when the cheaper one
can't falsify your change.

## VRS is the source of design truth

System-level design lives in
[`./vrs/`](./vrs/) as three documents:

- `vision.md` — what problem the package solves and why.
- `requirements.md` — testable constraints (R01, R02, …).
- `spec.md` — how the reconciler, diff, and cache satisfy those
  requirements.

Before changing observable behaviour, update the spec to match.
Changing the vision or requirements requires a discussion — open an
issue or raise it in review rather than editing them solo. The docs
under `docs/` are the reader-facing projection of VRS; keep them in
sync.

## Storybook

The stories under `src/web/*.stories.tsx` are the canonical visual
reference for every block. If you add or change a block's web
rendering, update (or add) the matching story. The stories also
render inside CI's Storybook build, so a broken story fails the
build.

`src/web/demo/` holds supporting demo fixtures (content snippets,
themed wrappers). It is not an API surface — feel free to refactor
it freely alongside story changes.

## File layout at a glance

```
src/
  components/  Notion-host JSX components (Page, Heading1, …)
  renderer/    react-reconciler host-config, diff, sync driver
  cache/       NotionCache interface + FsCache / InMemoryCache
  web/         DOM mirror components + CSS (preview only)
  test/        Integration harness + e2e suites
```

See [Internals → Architecture](./internals/architecture.md) for what
lives where and why.

## TSDoc expectations

- Public exports get a TSDoc block. Private helpers get a short
  comment only when the "why" is non-obvious.
- `@param`/`@returns` tags are discouraged — document parameters
  inline with the type, and document the return value in the
  function's prose summary.
- Keep TSDoc summaries to one or two sentences. Put detail in
  `docs/` and link from TSDoc if it's worth cross-referencing.

## Commit / PR conventions

- Conventional commits: `feat(notion-react): …`, `fix(notion-react):
…`, `docs(notion-react): …`, etc. The scope is always the package
  name.
- Reference GitHub issues in the body (`Fixes #123` or
  `Tracks #123`).
- Open a draft PR early for larger changes; reviewers prefer to see
  the shape before the polish.
- Green checks: type-check, oxlint, oxfmt, unit tests. Mock-client
  and e2e run in CI automatically for relevant paths.

## See also

- [Testing](./testing.md) — layered test strategy.
- [Internals → Architecture](./internals/architecture.md) — module
  boundaries and data flow.
- [Internals → Reconciler internals](./internals/reconciler-internals.md)
  — host-config and diff details.
