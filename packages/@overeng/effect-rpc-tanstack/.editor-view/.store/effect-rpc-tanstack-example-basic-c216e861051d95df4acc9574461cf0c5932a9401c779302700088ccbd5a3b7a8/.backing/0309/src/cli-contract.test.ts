import { describe, expect, it } from 'vitest'

import { normalizeCliOutput } from './cli-contract.ts'

describe('normalizeCliOutput', () => {
  describe('ansi', () => {
    it('strips CSI colour sequences when enabled', () => {
      const input = '\u001b[31merror\u001b[0m: bad \u001b[1;32mthing\u001b[22m'
      expect(normalizeCliOutput({ input, ansi: true })).toBe('error: bad thing')
    })

    it('strips OSC sequences terminated by BEL when enabled', () => {
      const input = 'title\u001b]2;wintitle\u0007rest'
      expect(normalizeCliOutput({ input, ansi: true })).toBe('titlerest')
    })

    it('preserves ANSI sequences when disabled', () => {
      const input = '\u001b[31merror\u001b[0m'
      expect(normalizeCliOutput({ input })).toBe(input)
    })
  })

  describe('time', () => {
    it('masks log timestamps at line starts when enabled', () => {
      const input = '[12:34:56.789] first\nplain\n[01:02:03.004] second'
      expect(normalizeCliOutput({ input, time: true })).toBe('[time] first\nplain\n[time] second')
    })

    it('leaves bracketed text that is not a timestamp alone when enabled', () => {
      expect(normalizeCliOutput({ input: '[not a time] x', time: true })).toBe('[not a time] x')
    })

    it('preserves timestamps when disabled', () => {
      const input = '[12:34:56.789] first'
      expect(normalizeCliOutput({ input })).toBe(input)
    })
  })

  describe('repoRoot', () => {
    it('replaces every occurrence of the checkout root when provided', () => {
      const input = 'at /repo/packages/x/src/a.ts and /repo/packages/y'
      expect(normalizeCliOutput({ input, repoRoot: '/repo' })).toBe(
        'at <repo>/packages/x/src/a.ts and <repo>/packages/y',
      )
    })

    it('does not treat the input as a pattern when provided', () => {
      const input = 'path (x) and path (y)'
      expect(normalizeCliOutput({ input, repoRoot: '(x)' })).toBe('path <repo> and path (y)')
    })

    it('rejects an empty repoRoot instead of splicing between every character', () => {
      expect(() => normalizeCliOutput({ input: 'abc', repoRoot: '' })).toThrow()
    })

    it('leaves absolute paths untouched when omitted', () => {
      const input = 'at /repo/src/a.ts'
      expect(normalizeCliOutput({ input })).toBe(input)
    })
  })

  describe('modulePaths', () => {
    it('masks a pnpm virtual-store install prefix down to the package-relative path', () => {
      const input =
        'at <anonymous> (/repo/node_modules/.pnpm/effect@4.0.0/node_modules/effect/dist/cli.js:10:3)'
      expect(normalizeCliOutput({ input, modulePaths: true })).toBe(
        'at <anonymous> (<node_modules>/effect/dist/cli.js:10:3)',
      )
    })

    it('masks a build-system dependency view to the same package-relative path', () => {
      const input =
        'at <anonymous> (/out/deps/__entry_effect_4_0_0_abcdef__/entry/node_modules/effect/dist/cli.js:10:3)'
      expect(normalizeCliOutput({ input, modulePaths: true })).toBe(
        'at <anonymous> (<node_modules>/effect/dist/cli.js:10:3)',
      )
    })

    it('leaves paths outside a dependency install untouched when enabled', () => {
      const input = 'at /repo/packages/x/src/a.ts:1:2'
      expect(normalizeCliOutput({ input, modulePaths: true })).toBe(input)
    })

    it('preserves dependency install prefixes when disabled', () => {
      const input = 'at /repo/node_modules/effect/dist/cli.js:10:3'
      expect(normalizeCliOutput({ input })).toBe(input)
    })
  })

  describe('local-source suffix', () => {
    it('is masked unconditionally, including under an empty policy', () => {
      const input = 'genie v4.0.0 — running from local source (/repo/packages/@overeng/genie)'
      expect(normalizeCliOutput({ input })).toBe('genie v4.0.0')
    })
  })

  describe('combined policy', () => {
    it('applies every requested mask in one pass', () => {
      const input =
        '[00:00:00.000] \u001b[36mgenie\u001b[39m v1 — running from local source (/repo/pkg)\n' +
        '[00:00:00.001] at /repo/pkg/src/e.ts:1:2'
      expect(normalizeCliOutput({ input, ansi: true, time: true, repoRoot: '/repo/pkg' })).toBe(
        '[time] genie v1\n[time] at <repo>/src/e.ts:1:2',
      )
    })
  })
})
