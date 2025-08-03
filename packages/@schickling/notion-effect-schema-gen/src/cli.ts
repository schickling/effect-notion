#!/usr/bin/env node

import { Effect } from 'effect'
import { generateSchemaFromNotionDb } from './mod.js'

const cli = Effect.gen(function* () {
  const args = process.argv.slice(2)
  
  if (args.length === 0) {
    yield* Effect.logError('Usage: notion-effect-schema-gen <database-id>')
    yield* Effect.fail(new Error('Missing database ID'))
  }
  
  const databaseId = args[0]!
  const schema = yield* generateSchemaFromNotionDb(databaseId)
  
  yield* Effect.log(schema)
})

// TODO: Use proper Effect runtime setup
cli.pipe(
  Effect.runPromise
).catch(console.error)