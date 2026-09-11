import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('../bin/tui-stories.tsx', import.meta.url))

// Walk up to the checkout root — segment-counting from import.meta.url is
// unreliable here because bun resolves the module through megarepo symlinks.
const repoRoot = (() => {
  let dir = dirname(cliPath)
  for (;;) {
    if (existsSync(join(dir, '.git')) === true) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repo root not found')
    dir = parent
  }
})()

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the tui-stories owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 * The local-source version suffix and log timestamps are normalized, so version-string content and
 * log timing are not gated by this baseline.
 */
const normalizeOutput = (input: string): string =>
  normalizeCliOutput({
    input,
    ansi: true,
    time: true,
    repoRoot,
    effectCliInternals: true,
  })

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync('bun', [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeOutput(result.stdout),
    stderr: normalizeOutput(result.stderr),
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
