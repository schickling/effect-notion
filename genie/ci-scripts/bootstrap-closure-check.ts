#!/usr/bin/env bun
/**
 * Bootstrap-safe import-closure gate (issue #884) — SCOPED TO BOOTSTRAP-PHASE GENERATORS,
 * ZERO-TOLERANCE (decision 0004).
 *
 * A `bootstrap`-phase `.genie.ts` (and every helper it transitively imports at RUNTIME) must be
 * importable from a fresh checkout BEFORE package-manager install state exists, so it must not
 * reach a runtime-only package (e.g. through a wide barrel that `export *`s a module importing
 * `effect`). `design-time` generators are exempt by declaration: they run after install
 * (post-install `genie:run`) and may use the runtime graph.
 *
 * This entry discovers every source-tree `.genie.ts` (skipping dependency/build directories),
 * keeps only those whose static `// @genie-bootstrap` pragma marks them bootstrap-phase, runs the shared
 * {@link checkBootstrapClosure} walker over that set, and FAILS on ANY violation. There is no
 * baseline and no allowlist: the residual weaver generators are `design-time` by declaration, so
 * they are structurally out of scope rather than an accepted exception.
 *
 * This gate is fast local feedback (R30); the empirical authority is `bootstrap:cold-proof` (R32),
 * which actually runs the bootstrap-phase generators in a no-`node_modules` checkout before install.
 *
 * Usage:
 *   bun genie/ci-scripts/bootstrap-closure-check.ts                 # check this repo
 *   bun genie/ci-scripts/bootstrap-closure-check.ts --root "$PWD"   # check another repo
 */

import path from 'node:path'

import { bootstrapClosureCheckMain } from '../../packages/@overeng/genie/src/runtime/node/bootstrap-closure-check-cli.ts'

await bootstrapClosureCheckMain({
  argv: process.argv.slice(2),
  defaultRepoRoot: path.resolve(import.meta.dir, '../..'),
})
