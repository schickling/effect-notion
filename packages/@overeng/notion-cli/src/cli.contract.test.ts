import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('./cli.ts', import.meta.url))

// Walk up to the checkout root — segment-counting from import.meta.url is
// unreliable because bun resolves the module through megarepo symlinks.
const repoRoot = (() => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    if (existsSync(join(dir, '.git')) === true) return dir
    const parent = dirname(dir)
    if (parent === dir) throw new Error('repo root not found')
    dir = parent
  }
})()

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the notion-cli owner
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

describe('notion-cli CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['db help', ['db', '--help']],
    ['version', ['--version']],
    ['missing required database id', ['db', 'info']],
    ['invalid integer', ['md', 'status', '--concurrency', 'nope', 'page.nmd']],
    [
      'invalid integer with json output (stdout guard)',
      ['md', 'status', '--concurrency', 'nope', '--json', 'page.nmd'],
    ],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
