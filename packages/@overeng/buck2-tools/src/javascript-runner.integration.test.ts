import { execFileSync } from 'node:child_process'
import { realpathSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const shell = realpathSync(
  execFileSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).trim(),
)
const bun = realpathSync(execFileSync(shell, ['-c', 'command -v bun'], { encoding: 'utf8' }).trim())

const runner = fileURLToPath(new URL('./javascript-runner.ts', import.meta.url))

describe('JavaScript runner', () => {
  it('creates a declared nested writable directory before launching the command', async () => {
    const root = await mkdtemp(
      join(realpathSync(tmpdir()), 'javascript-runner-writable-directory-'),
    )
    const packageTree = join(root, 'package-tree')
    const scratch = join(root, 'scratch')
    try {
      await mkdir(packageTree)
      await writeFile(
        join(packageTree, 'assert-writable.ts'),
        `import { statSync } from 'node:fs'
const path = process.env.CACHE_PATH
if (path === undefined || statSync(path).isDirectory() === false) process.exit(73)
`,
      )

      const child = Bun.spawn(
        [
          bun,
          runner,
          'exec',
          bun,
          packageTree,
          'assert-writable.ts',
          '--writable-directory',
          'CACHE_PATH',
          'cache/vitest',
        ],
        {
          env: { ...process.env, BUCK_SCRATCH_PATH: scratch },
          stdin: 'ignore',
          stdout: 'inherit',
          stderr: 'inherit',
        },
      )
      expect(await child.exited).toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
