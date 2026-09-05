import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('../bin/genie.tsx', import.meta.url))
/* Absolute checkout root of this worktree — v4 CLI error rendering embeds
 * stack-frame paths under it; snapshots must not gate on the machine. */
const repoRoot = fileURLToPath(new URL('../../../..', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the genie owner during
 * Effect 4 repair with an alignment-register entry.
 * The local-source version suffix, log timestamps, dependency install prefixes,
 * and absolute checkout paths (v4 `CliError` output embeds stack-frame file
 * paths) are normalized, so version-string content, log timing, how
 * dependencies were materialized, and machine-specific paths are not gated by
 * this baseline.
 */

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync(bunBin, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeCliOutput({
      input: result.stdout,
      ansi: true,
      time: true,
      modulePaths: true,
      repoRoot,
    }),
    stderr: normalizeCliOutput({
      input: result.stderr,
      ansi: true,
      time: true,
      modulePaths: true,
      repoRoot,
    }),
  }
}

describe('genie CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['version', ['--version']],
    ['missing option value', ['--cwd']],
    ['invalid phase', ['--phase', 'nope', '--dry-run']],
    ['invalid phase with json output (stdout guard)', ['--phase', 'nope', '--output', 'json']],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
