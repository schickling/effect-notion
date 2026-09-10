import { existsSync, realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const bun = realpathSync(process.execPath)
const runner = fileURLToPath(new URL('./package-command-runner.ts', import.meta.url))

describe('package command input immutability', () => {
  it.each([
    { name: 'package tree', readRoot: false },
    { name: 'declared read root', readRoot: true },
  ])('rejects a successful command that mutates its $name', async ({ readRoot }) => {
    const root = await mkdtemp(join(realpathSync(tmpdir()), 'package-command-input-mutation-'))
    const packageTree = join(root, 'package-tree')
    const dependency = join(root, 'dependency')
    const verdict = join(root, 'verdict')
    try {
      await Promise.all([mkdir(packageTree), mkdir(dependency)])
      await writeFile(
        join(packageTree, 'mutate.ts'),
        `import { writeFileSync } from 'node:fs'
writeFileSync(process.argv[2]!, 'mutated')
`,
      )
      const mutationTarget = join(readRoot === true ? dependency : packageTree, 'mutation')
      const command = [
        bun,
        runner,
        'check',
        bun,
        packageTree,
        'mutate.ts',
        verdict,
        '--arg',
        mutationTarget,
        ...(readRoot === true ? ['--read-root', dependency] : []),
      ]
      const child = Bun.spawn(command, {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'pipe',
      })
      const [exitCode, stderr] = await Promise.all([
        child.exited,
        new Response(child.stderr).text(),
      ])

      expect(exitCode).toBe(1)
      expect(stderr).toContain('declared inputs changed while mutate.ts was running')
      expect(existsSync(verdict)).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
