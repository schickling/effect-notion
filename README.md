# @overeng Effect Utils

A collection of production-ready [Effect](https://effect.website) utilities and integrations.

## Packages

### Notion Integration

Full-featured Effect-native Notion API client with type-safe schema generation.

#### [@overeng/notion-effect-client](./packages/@overeng/notion-effect-client)

Effect-native HTTP client for the Notion API with typed queries

- **Schema-aware queries** - Pass Effect schemas to get fully typed results with automatic decoding
- **Markdown conversion** - Convert pages/blocks to Markdown with customizable transformers
- **Streaming API** - Auto-pagination via Effect Streams for all list operations

#### [@overeng/notion-effect-schema](./packages/@overeng/notion-effect-schema)

Comprehensive Effect schemas for all Notion API types

- **Complete coverage** - Schemas for all 27 block types and 21+ property types
- **Property transforms** - `asString`, `asNumber`, `asOption` variants for ergonomic access
- **Write support** - Dedicated write schemas for creating/updating pages

#### [@overeng/notion-effect-cli](./packages/@overeng/notion-effect-cli)

CLI tool to generate type-safe schemas from your Notion databases

- **Schema generation** - Generate typed schemas from live Notion databases
- **Drift detection** - Track schema changes with `diff` command for CI/CD
- **API wrapper generation** - Generate typed CRUD operations with `--include-api`

### AI Integration

| Package                                                                   | Description                       |
| ------------------------------------------------------------------------- | --------------------------------- |
| [@overeng/effect-ai-claude-cli](./packages/@overeng/effect-ai-claude-cli) | Claude CLI provider for Effect AI |

Use your **Claude Code subscription** instead of paying for API calls. Implements Effect AI's LanguageModel interface by delegating to the `claude` CLI.

- **Subscription-based** - Use your existing Claude Code subscription (much cheaper than API)
- **No API keys** - CLI handles authentication via your subscription
- **Full LanguageModel support** - Works with `@effect/ai` Chat, generateText, etc.

### Schema Forms

Headless form library for Effect Schemas with accessible React Aria implementation.

| Package                                                                         | Description                                                                                                          |
| ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| [@overeng/effect-schema-form](./packages/@overeng/effect-schema-form)           | Headless form component with schema introspection                                                                    |
| [@overeng/effect-schema-form-aria](./packages/@overeng/effect-schema-form-aria) | Styled React Aria components with Tailwind CSS ([Storybook](https://overeng-effect-utils-schema-form-ar.vercel.app)) |

- **Schema introspection** - Automatically generate form fields from Effect Schema structure
- **Headless architecture** - Bring your own components or use pre-built React Aria implementation
- **Tagged struct support** - Automatic handling of discriminated unions with labeled groups
- **Flexible rendering** - Provider pattern, render props, or hooks API for full control
- **Accessible by default** - React Aria Components with WCAG compliance

### React Integration

React hooks and utilities for building Effect-powered applications.

| Package                                                         | Description                                                                                                                |
| --------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| [@overeng/effect-react](./packages/@overeng/effect-react)       | React integration for Effect runtime with hooks and context providers                                                      |
| [@overeng/react-inspector](./packages/@overeng/react-inspector) | DevTools-style inspectors with Effect Schema support ([Storybook](https://overeng-effect-utils-react-inspecto.vercel.app)) |

- **EffectProvider** - Initialize Effect runtime from a Layer and provide to React tree
- **Hooks API** - `useEffectRunner`, `useEffectCallback`, `useEffectOnMount` for running effects in components
- **Automatic error handling** - Built-in error boundaries with custom error components
- **DevTools inspectors** - Browser-style object/table inspectors with Effect Schema awareness
- **Type-safe runtime access** - Direct access to Effect runtime for advanced use cases

### Playwright Integration

| Package                                                     | Description                                             |
| ----------------------------------------------------------- | ------------------------------------------------------- |
| [@overeng/utils/node/playwright](./packages/@overeng/utils) | Effect-native Playwright wrappers with OTEL integration |

- **Service tags** - `PwPage`, `PwBrowserContext` for dependency injection
- **Structured errors** - All operations wrapped with `PwOpError` for consistent error handling
- **OTEL spans** - Automatic tracing with cross-process trace propagation
- **Test helpers** - `withTestCtx` for automatic layer provision in Playwright tests

### Utilities

| Package                                     | Description                                          |
| ------------------------------------------- | ---------------------------------------------------- |
| [@overeng/utils](./packages/@overeng/utils) | Distributed locks, log bridging, and debug utilities |

Key features:

- SharedWorker→Tab log bridging via BroadcastChannel (`@overeng/utils/browser`)
- Scope/finalizer debugging and active handles monitoring
- File system-backed distributed locks with TTL expiration
- Workspace-aware command helpers with optional logging/retention

### Developer Tools

| Package                                               | Description                            |
| ----------------------------------------------------- | -------------------------------------- |
| [@overeng/genie](./packages/@overeng/genie)           | TypeScript-based config file generator |
| [@overeng/oxc-config](./packages/@overeng/oxc-config) | Shared oxlint and oxfmt configuration  |

**Genie** generates `package.json`, `tsconfig.json`, and GitHub workflow files from TypeScript sources (`.genie.ts` files). Features include:

- **Type-safe config** - Define configs as TypeScript with full autocomplete
- **Consistent formatting** - Auto-formats via oxfmt
- **Read-only protection** - Generated files are read-only by default
- **CI integration** - `--check` mode verifies files are up to date

### Rebuild and reload binaries

```bash
devenv tasks run nix:build:genie
devenv tasks run nix:build
devenv tasks run nix:check
```

After `pnpm-lock.yaml` changes:

```bash
refresh Nix FOD hashes for genie
refresh all stale Nix FOD hashes with your repo workflow
```

## Quick Start

### Enter the dev shell

This repo uses `devenv` to provide a consistent toolchain. Run commands inside the shell:

```bash
devenv shell
```

### Publish Dependency Views

```bash
devenv tasks run buck2:editor:publish
```

### Check All TypeScript Projects

```bash
devenv tasks run buck2:check
```

Publish Buck-produced declarations to package `dist` directories for source-side
consumers such as type-aware lint:

```bash
devenv tasks run buck2:typescript:materialize-dist
```

### Run Tests

```bash
# All tests
devenv tasks run test:run

# Single package (e.g., utils, genie)
devenv tasks run test:utils
devenv tasks run test:genie

# Integration tests (requires NOTION_API_TOKEN for Notion packages)
NOTION_API_TOKEN=secret_xxx devenv tasks run test:integration

# Watch mode
devenv tasks run test:watch
```

### Type Checking

Buck is the only repository-wide TypeScript check authority:

```bash
devenv tasks run buck2:check
```

### Linting

```bash
# Check formatting + lint
devenv tasks run lint:check

# Auto-fix formatting + lint issues
devenv tasks run lint:fix
```

## Package Structure

Each package follows modern ESM conventions:

- Source files in `src/` (TypeScript with `.ts` extension)
- Entry point at `src/mod.ts`
- Compiled output in `dist/` (gitignored)
- Development exports point to source files
- Published exports point to compiled JavaScript

## Contributing

This monorepo uses:

- **bun workspaces** for package management
- **TypeScript project references** for incremental builds
- **oxlint + oxfmt** for linting and formatting
- **Vitest** for testing
- **Effect** for core functionality

See individual package READMEs for package-specific documentation.
