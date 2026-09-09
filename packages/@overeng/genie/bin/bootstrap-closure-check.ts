#!/usr/bin/env bun

import { bootstrapClosureCheckMain } from '../src/runtime/node/bootstrap-closure-check-cli.ts'

await bootstrapClosureCheckMain({
  argv: process.argv.slice(2),
  defaultRepoRoot: process.cwd(),
})
