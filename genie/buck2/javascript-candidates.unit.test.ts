import { describe, expect, it } from 'vitest'

import ciTools from '../../packages/@overeng/ci-tools/BUCK.genie.ts'
import genie from '../../packages/@overeng/genie/BUCK.genie.ts'
import megarepo from '../../packages/@overeng/megarepo/BUCK.genie.ts'
import notionCli from '../../packages/@overeng/notion-cli/BUCK.genie.ts'
import notionMd from '../../packages/@overeng/notion-md/BUCK.genie.ts'
import npmRelease from '../../packages/@overeng/npm-release/BUCK.genie.ts'
import oxcConfig from '../../packages/@overeng/oxc-config/BUCK.genie.ts'
import tuiStories from '../../packages/@overeng/tui-stories/BUCK.genie.ts'
import { withJavaScriptCandidates } from './javascript-candidates.ts'

describe('JavaScript product projection', () => {
  it('renders typed Node CLI and loadable-module products', () => {
    const output = withJavaScriptCandidates({
      declarations: '',
      products: [
        {
          entrypoint: 'bin/tool.ts',
          externalCapabilities: ['native-capability'],
          kind: 'cli',
          output: 'tool.js',
          productName: 'tool',
          smokeArgs: ['--help'],
          targetName: 'tool-candidate',
        },
        {
          entrypoint: 'src/mod.ts',
          kind: 'module',
          output: 'plugin.js',
          productName: 'plugin',
          targetName: 'plugin-candidate',
        },
      ],
      projection: {
        data: {},
        stringify: () => 'BASE',
      },
    }).stringify({ cwd: '', location: '' })

    expect(output).toContain('package_bin_artifact(')
    expect(output).toContain('name = \"tool-candidate-module\"')
    expect(output).toContain('target = \"node\"')
    expect(output).toContain('node_package_bin(')
    expect(output).toContain('cli_product(')
    expect(output).toContain('module_product(')
    expect(output).toContain('package_bin_check(')
    expect(output).toContain('external_capabilities = [\"native-capability\"]')
  })

  it('declares every CLI and plugin candidate with an executable smoke boundary', () => {
    const context = { cwd: '', location: '' }
    const candidates = [
      [ciTools, 'ci-tools-candidate'],
      [genie, 'genie-candidate'],
      [megarepo, 'megarepo-candidate'],
      [notionCli, 'notion-cli-candidate'],
      [notionCli, 'notion-db-candidate'],
      [notionMd, 'notion-md-candidate'],
      [npmRelease, 'npm-release-candidate'],
      [oxcConfig, 'oxc-config-candidate'],
      [tuiStories, 'tui-stories-candidate'],
    ] as const

    for (const [projection, target] of candidates) {
      const output = projection.stringify(context)
      expect(output).toContain(`name = \"${target}\"`)
      expect(output).toContain(`name = \"${target}-smoke\"`)
    }

    const genieOutput = genie.stringify(context)
    expect(genieOutput).toContain('target = "bun"')
    expect(genieOutput).toContain('bun_cli_product(')
    expect(genieOutput).toContain('name = "genie-candidate-launch"')
    expect(genieOutput).toContain('args = ["--dry-run"]')
  })
})
