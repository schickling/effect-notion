import { expect } from 'vitest'

import { Vitest } from '@overeng/utils-dev/node-vitest'

import { rewriteHelpSubcommand } from './cli-help-rewrite.ts'

Vitest.describe('rewriteHelpSubcommand', () => {
  Vitest.it('rewrites `help subcmd` → `subcmd --help`', () => {
    expect(rewriteHelpSubcommand(['help', 'commit'])).toEqual(['commit', '--help'])
  })

  Vitest.it('rewrites `help` (no subcmd) → `--help`', () => {
    expect(rewriteHelpSubcommand(['help'])).toEqual(['--help'])
  })

  Vitest.it('passes through `subcmd --flag` unchanged', () => {
    const args = ['subcmd', '--flag']
    expect(rewriteHelpSubcommand(args)).toEqual(args)
  })

  Vitest.it('passes through empty input unchanged', () => {
    expect(rewriteHelpSubcommand([])).toEqual([])
  })

  Vitest.it('preserves nested args: `help sub1 sub2` → `sub1 sub2 --help`', () => {
    expect(rewriteHelpSubcommand(['help', 'sub1', 'sub2'])).toEqual(['sub1', 'sub2', '--help'])
  })

  Vitest.it('does not rewrite when `help` is not the first arg', () => {
    expect(rewriteHelpSubcommand(['--flag', 'help', 'subcmd'])).toEqual([
      '--flag',
      'help',
      'subcmd',
    ])
  })

  Vitest.it('passes through a leading `--` separator unchanged', () => {
    expect(rewriteHelpSubcommand(['--', 'help', 'subcmd'])).toEqual(['--', 'help', 'subcmd'])
  })
})
