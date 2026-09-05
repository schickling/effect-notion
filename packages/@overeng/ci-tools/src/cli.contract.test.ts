import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from '@overeng/utils-dev/cli-contract'

const cliPath = fileURLToPath(new URL('../bin/ci-tools.ts', import.meta.url))

/** Reads one Buck-declared immutable tool path; nothing resolves through an ambient PATH. */
const requireTool = (name: string): string => {
  const tool = process.env[name]
  if (tool === undefined || tool === '')
    throw new Error(`declared test tool is unavailable: ${name}`)
  return tool
}

const bunBin = requireTool('BUN_BIN')

/**
 * CLI contract capture: `status` and `signal` are cross-major invariants; stdout/stderr help,
 * usage, and error prose are captured for review but may be re-baselined by the ci-tools owner
 * during Effect 4 repair with an alignment-register entry.
 * ANSI control bytes are normalized, so colour/styling changes are not gated by this baseline.
 */

const runCli = (...args: ReadonlyArray<string>) => {
  const result = spawnSync(bunBin, [cliPath, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })

  return {
    status: result.status,
    signal: result.signal,
    stdout: normalizeCliOutput({ input: result.stdout, ansi: true }),
    stderr: normalizeCliOutput({ input: result.stderr, ansi: true }),
  }
}

describe('ci-tools CLI contract baselines (status/signal invariant, prose owner-rebaselinable)', () => {
  it.each([
    ['root help', ['--help']],
    ['workflow-report help', ['workflow-report', '--help']],
    ['version', ['--version']],
    ['missing required bundle id', ['workflow-report', 'collect-bundle']],
    [
      'invalid deploy mode',
      ['deploy', 'netlify', '--target', 'web', '--artifact-dir', '/tmp', '--mode', 'nope'],
    ],
  ] as const)('%s', (_name, args) => {
    expect(runCli(...args)).toMatchSnapshot()
  })
})
