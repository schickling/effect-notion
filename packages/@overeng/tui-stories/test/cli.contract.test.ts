import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('../bin/tui-stories.tsx', import.meta.url))

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

/* Absolute root of this package as materialized (checkout package directory or Buck package
 * view) — v4 CLI error rendering can embed paths under it; snapshots must not gate on the
 * machine or on how the package tree was materialized. */
const packageRoot = fileURLToPath(new URL('..', import.meta.url))

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the tui-stories owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 * Dependency install prefixes are normalized, so the dependency materialization layout is not
 * gated by this baseline.
 * The local-source version suffix and log timestamps are normalized, so version-string content and
 * log timing are not gated by this baseline.
 */

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
      repoRoot: packageRoot,
    }),
    stderr: normalizeCliOutput({
      input: result.stderr,
      ansi: true,
      time: true,
      modulePaths: true,
      repoRoot: packageRoot,
    }),
  }
}

describe('tui-stories CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['list help', ['list', '--help']],
    ['version', ['--version']],
    ['missing path', ['list']],
    [
      'invalid width',
      ['render', 'Story', '--path', 'packages/@overeng/tui-stories', '--width', 'nope'],
    ],
    [
      'invalid width with json output (stdout guard)',
      [
        'render',
        'Story',
        '--path',
        'packages/@overeng/tui-stories',
        '--width',
        'nope',
        '--output',
        'json',
      ],
    ],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
