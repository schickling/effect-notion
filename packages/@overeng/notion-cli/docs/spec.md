# Notion CLI Spec

This document specifies the `@overeng/notion-cli` package. It builds on [requirements.md](./requirements.md).

## Status

Active.

## Scope

This spec defines:

- the public `notion` command hierarchy,
- how package-owned command trees are composed,
- how the packaged binary routes Node-backed database leaves,
- the removed legacy surfaces that must stay absent,
- package-level verification expectations.

This spec does not define:

- datasource-sync replica internals, which live in [../notion-datasource-sync/docs/vrs/spec.md](../../notion-datasource-sync/docs/vrs/spec.md),
- markdown page sync internals, which are owned by `@overeng/notion-md`,
- Notion API wire schemas, which are owned by `@overeng/notion-effect-client` and `@overeng/notion-effect-schema`.

## Command Surface

Trace: R01-R06, R11-R13, R17-R18.

```text
notion
├── edit <page>               # top-level alias → md edit (marquee verb, R18)
├── md ...                    # @overeng/notion-md command tree
│   ├── cat / put / edit      # editor surface: cat/put pipes + engine-backed edit (R17)
│   └── sync / status / plan  # file-based surface
├── schema
│   ├── generate
│   ├── introspect
│   ├── generate-config
│   └── diff
└── db
    ├── info                  # Bun root execution
    ├── sync                  # Node-backed datasource-sync runtime
    ├── export                # Node-backed datasource-sync runtime
    ├── status                # Node-backed datasource-sync runtime
    ├── pull / push / init    # advanced Node-backed leaves
    ├── conflicts ...
    ├── forget / restore
    └── doctor
```

Retired surfaces are absent from the root command tree and packaged wrapper:

| Retired surface             | Replacement                                     |
| --------------------------- | ----------------------------------------------- |
| `notion sqlite ...`         | `notion db ...`                                 |
| `notion-datasource-sync`    | packaged `notion db ...`                        |
| `notion db dump ...`        | `notion db export ...`                          |
| `notion db replica ...`     | public SQLite surfaces plus `notion db ...`     |
| raw Notion dump checkpoints | datasource-sync replica status and metadata     |
| `notion db migrate ...`     | internal store migrations, not a public command |
| `notion db repair ...`      | guarded sync/status/doctor workflows            |

## Root Command Composition

Trace: R02, R05-R07, R10, R14.

`src/cli.ts` constructs one Effect CLI root command. It imports package-owned command trees lazily when running the CLI:

| Namespace | Source package/module            | Runtime at root import time     |
| --------- | -------------------------------- | ------------------------------- |
| `md`      | `@overeng/notion-md/cli-program` | import-safe command descriptor  |
| `schema`  | `src/commands/schema/mod.ts`     | Bun-compatible implementation   |
| `db`      | `src/commands/db/mod.ts`         | Bun-compatible descriptor shell |

Root `--version` is handled before command construction so version output stays available even if a subcommand dependency is unavailable. Help subcommand rewriting happens before Effect CLI execution so `notion help db` and equivalent forms share the same tree.

## Database Namespace

Trace: R04, R07-R13.

`src/commands/db/mod.ts` owns the `db` namespace shape. It contains `info` directly and appends import-safe datasource-sync subcommands from `@overeng/notion-datasource-sync/cli/effect-command`.

```text
db command construction
├── infoCommand
│   ├── NotionDatabases.retrieve
│   ├── NotionDataSources.retrieve when API data-source properties are present
│   └── TUI renderer: InfoOutput
└── makeDatasourceDbSubcommands(runtimeUnavailableHandler)
    ├── same option/leaf descriptors as Node runtime
    └── handler prints fail-closed runtime guidance in source/Bun execution
```

The descriptor factory is shared with the datasource-sync Node runtime. That makes help/completion drift visible as a code change rather than a docs-only mismatch.

## Packaged Runtime Dispatch

Trace: R07-R10, R15.

The packaged `notion` wrapper composes two reviewed Buck JavaScript products
imported from `nix/buck2-products/manifest.json`: the `notion-cli` product
supplies the root binary, and the `notion-db-runtime` product supplies the
Node-backed datasource-sync entrypoint together with its native `@opentui/core`
bindings.

```text
packaged notion
├── default path: $out/bin/notion -> Bun root binary
└── wrapper intercept:
    if argv[1] == "db" and argv[2] in Node-backed leaves
      shift "db"
      exec node packages/@overeng/notion-datasource-sync/src/cli/main.ts argv[2..]
    else
      exec Bun root binary unchanged
```

The wrapper must route these `db` leaves to Node: `init`, `pull`, `push`, `sync`, `export`, `status`, `conflicts`, `forget`, `restore`, and `doctor`. It must not route `db info`, because that command is owned by the Bun root CLI.

The Nix package smoke test runs `notion db sync --help` through the wrapper. A missing datasource-sync runtime module, stale workspace filter, or wrong dispatch case fails the package build.

## Schema Namespace

Trace: R06.

`src/commands/schema/mod.ts` owns schema-oriented Notion database workflows:

| Command           | Implementation responsibility                                     |
| ----------------- | ----------------------------------------------------------------- |
| `generate`        | introspect a database and write Effect schema/API code            |
| `introspect`      | render database/data-source property metadata                     |
| `generate-config` | generate schemas for configured database sets                     |
| `diff`            | compare live Notion schema with an existing generated schema file |

Schema commands resolve the Notion token from `--token` or `NOTION_API_TOKEN`, use typed Notion client services, and render through package TUI components.

## Export Contract

Trace: R11-R13.

`notion db export` is a datasource-sync command exposed by the Notion CLI. Its public shape is:

```bash
notion db export [workspace-root] \
  --output <path> \
  [--sqlite <path>] \
  [--from-notion <database-url-or-data-source-id>] \
  [--format ndjson|json] \
  [--require-clean]
```

The command exports from the public replica surfaces (`rows`, `schema`, `schema_properties`, `sync_status`, `changes`, `conflicts`). `--from-notion` may establish or refresh the local replica by observe/pull/project work only. Export must not call push, drain outbox, execute planner intents, or mutate Notion.

## Verification Matrix

Trace: R14-R16.

| Check                                          | Required proof                                                                 |
| ---------------------------------------------- | ------------------------------------------------------------------------------ |
| `devenv tasks run test:notion-cli`             | root command composition, help/completion drift, schema/db package tests       |
| `devenv tasks run test:notion-datasource-sync` | datasource-backed `db` leaves and export behavior                              |
| `devenv tasks run genie:check`                 | generated package metadata is current                                          |
| `devenv tasks run ts:check`                    | TypeScript surface is valid                                                    |
| `devenv tasks run lint:check`                  | formatting, lint, lockfile, and generated-source coverage are valid            |
| `devenv tasks run check:quick`                 | aggregate quick gate for branch readiness                                      |
| `nix build .#notion-cli --no-link`             | packaged wrapper includes all runtime files and routes Node-backed `db` leaves |

## Design Questions

No open design questions are tracked for the current command surface.
