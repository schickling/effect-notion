import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, it } from 'vitest'

/**
 * Vite loads config files through Node, which refuses TypeScript stripping for
 * packages under `node_modules`. A workspace-linked consumer never crosses that
 * boundary, so the failure only shows up in an installed topology — which is
 * why this entry is checked JavaScript rather than TypeScript. See #1167.
 */
it('loads the StyleX Vite entry from a node_modules-installed consumer', () => {
  const consumerRoot = mkdtempSync(join(tmpdir(), 'overeng-stylex-vite-consumer-'))
  const packageRoot = fileURLToPath(new URL('../../..', import.meta.url))
  const installedPackage = join(consumerRoot, 'node_modules', '@overeng', 'utils')
  const configPath = join(consumerRoot, 'vite.config.mjs')
  const loaderPath = join(consumerRoot, 'load-config.mjs')

  try {
    mkdirSync(installedPackage, { recursive: true })
    cpSync(join(packageRoot, 'package.json'), join(installedPackage, 'package.json'))
    cpSync(
      join(packageRoot, 'src', 'node', 'stylex'),
      join(installedPackage, 'src', 'node', 'stylex'),
      {
        recursive: true,
      },
    )
    for (const dependency of ['@stylexjs/unplugin', 'unplugin']) {
      const target = join(consumerRoot, 'node_modules', dependency)
      mkdirSync(join(target, '..'), { recursive: true })
      symlinkSync(join(packageRoot, 'node_modules', dependency), target, 'dir')
    }
    writeFileSync(
      configPath,
      [
        "import { createStylexVitePlugins } from '@overeng/utils/node/stylex'",
        '',
        'export default { plugins: [createStylexVitePlugins({ entries: [] })] }',
        '',
      ].join('\n'),
    )
    writeFileSync(
      loaderPath,
      [
        `import { loadConfigFromFile } from ${JSON.stringify(import.meta.resolve('vite'))}`,
        '',
        `const loaded = await loadConfigFromFile(`,
        `  { command: 'build', mode: 'test', isSsrBuild: false, isPreview: false },`,
        `  ${JSON.stringify(configPath)},`,
        `  ${JSON.stringify(consumerRoot)},`,
        `  'silent',`,
        `  false,`,
        `  'bundle',`,
        `)`,
        `if (loaded === null || loaded.config.plugins?.[0]?.length !== 3) {`,
        `  throw new Error('Vite config did not load the StyleX plugins')`,
        `}`,
        '',
      ].join('\n'),
    )

    const result = spawnSync(process.execPath, [loaderPath], {
      cwd: consumerRoot,
      encoding: 'utf8',
    })

    expect({
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
    }).toEqual({ status: 0, signal: null, stdout: '', stderr: '' })
  } finally {
    rmSync(consumerRoot, { recursive: true, force: true })
  }
})
