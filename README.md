# effect-notion

Effect schemas and tools for working with the Notion API.

## Packages

### [@schickling/notion-effect-schema](./packages/@schickling/notion-effect-schema)

Effect schemas for Notion API primitives like CheckboxElement, TextElement, SelectElement, etc.

```ts
import { CheckboxElement } from '@schickling/notion-effect-schema'
import { Schema } from 'effect'

const checkbox = Schema.decodeUnknownSync(CheckboxElement)({
  type: 'checkbox',
  checkbox: true
})
```

### [@schickling/notion-effect-client](./packages/@schickling/notion-effect-client)

Effect-native wrapper for the Notion API client with proper error handling and observability.

```ts
import { NotionClientService } from '@schickling/notion-effect-client'
import { Effect } from 'effect'

const program = Effect.gen(function* () {
  const client = yield* NotionClientService
  const database = yield* client.getDatabase('your-database-id')
  const pages = yield* client.queryDatabase('your-database-id')
  return { database, pages }
})
```

### [@schickling/notion-effect-schema-gen](./packages/@schickling/notion-effect-schema-gen)

CLI tool to introspect Notion database schemas and generate corresponding Effect schemas.

```bash
# Generate Effect schema from Notion database
notion-effect-schema-gen <database-id> > generated-schema.ts

# Example output:
# export const MyDatabaseSchema = Schema.Struct({
#   title: TextElement,
#   completed: CheckboxElement,
#   priority: SelectElement,
# })
```

## Status

**This repository is currently a placeholder.** I hope to find time to actually implement this soon. 

If you're interested in helping with this project, please ping `@schickling` in the [Effect Discord](https://discord.gg/effect-ts).

## Development

```bash
pnpm install
pnpm build
pnpm test
```