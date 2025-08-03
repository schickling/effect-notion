# effect-notion

[Effect](https://effect.website) schemas and tools for working with the Notion API.

## Status

**This repository is currently a placeholder.** I hope to find time to actually implement this soon. 

If you're interested in helping with this project, please ping `@schickling` in the [Effect Discord](https://discord.gg/effect-ts).

## Packages

### [@schickling/notion-effect-schema](./packages/@schickling/notion-effect-schema)

Effect schemas for Notion API primitives like CheckboxElement, TextElement, SelectElement, etc.

```ts
import { 
  TitleElement, 
  CheckboxElement, 
  SelectElement,
  StringFromTitleElement,
  BooleanFromCheckboxElement,
  StringFromSelectElement
} from '@schickling/notion-effect-schema'
import { Schema } from 'effect'

// Define a task database schema
const TaskPageSchema = Schema.Struct({
  id: Schema.String,
  properties: Schema.Struct({
    Name: TitleElement,
    Completed: CheckboxElement,
    Priority: SelectElement,
  })
})

// Transform to a clean data structure
const CleanTaskSchema = Schema.transform(TaskPageSchema, 
  Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    completed: Schema.Boolean,
    priority: Schema.NullOr(Schema.String),
  }), {
  decode: (page) => ({
    id: page.id,
    name: Schema.decodeUnknownSync(StringFromTitleElement)(page.properties.Name),
    completed: Schema.decodeUnknownSync(BooleanFromCheckboxElement)(page.properties.Completed),
    priority: Schema.decodeUnknownSync(StringFromSelectElement)(page.properties.Priority),
  }),
  encode: () => { throw new Error('Not implemented') }
})

// Usage with Notion API response
const notionApiResponse = await fetch('/api/notion/database')
const tasks = Schema.decodeUnknownSync(Schema.Array(CleanTaskSchema))(notionApiResponse)
```

### [@schickling/notion-effect-client](./packages/@schickling/notion-effect-client)

Effect-native wrapper for the Notion API client with proper error handling and observability.

```ts
import { NotionClient } from '@schickling/notion-effect-client'
import { Effect } from 'effect'

const program = Effect.gen(function* () {
  const client = yield* NotionClient
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

## Development

```bash
pnpm install
pnpm build
pnpm test
```