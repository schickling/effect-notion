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

  describe('Effect CLI internals', () => {
    it('masks volatile fiber ids, package versions, and source positions when enabled', () => {
      const input =
        '[time] ERROR (#73): ~effect/cli/CliError/ShowHelp\n' +
        'at effect@4.0.0-rc.112/node_modules/effect/dist/unstable/cli/Command.js:1077:34'
      expect(normalizeCliOutput({ input, effectCliInternals: true })).toBe(
        '[time] ERROR (#<fiber>): ~effect/cli/CliError/ShowHelp\n' +
          'at effect@<version>/node_modules/effect/dist/unstable/cli/Command.js:<line>:<column>',
      )
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
